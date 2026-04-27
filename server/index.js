/**
 * Geo Challenge Server
 * HTTP + WebSocket server with multi-room management and game engine.
 */

const express = require('express');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const os = require('os');
const fs = require('fs');
const path = require('path');
const topojson = require('topojson-client');
// geoContains used in endProximityGuess (Task 6); geoCentroid used here for centroid precomputation
const { geoContains, geoCentroid } = require('d3-geo');
const { openDatabase } = require('./db');
const db = openDatabase(path.join(__dirname, 'geo-challenge.db'));

// ------------------------------------------------------------------
// Config & Network Detection
// ------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const ROOM_IDLE_TIMEOUT_MS = parseInt(process.env.ROOM_IDLE_TIMEOUT_MS, 10) || 600000;

function detectLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

function getBaseUrl(req) {
  if (process.env.BASE_URL) {
    return process.env.BASE_URL;
  }
  const host = req.get('host') || `${detectLocalIP()}:${PORT}`;
  if (host.startsWith('localhost') || host.startsWith('127.')) {
    return `http://${detectLocalIP()}:${PORT}`;
  }
  return `${req.protocol}://${host}`;
}

function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// ------------------------------------------------------------------
// Load Country Data
// ------------------------------------------------------------------
const topoData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'data', 'countries-110m.json'), 'utf8'));
const countryFeatures = topojson.feature(topoData, topoData.objects.countries).features;
// countryFeatureMap used in endProximityGuess (Task 6) for polygon hit-testing
const countryFeatureMap = new Map(); // name -> GeoJSON feature
for (const f of countryFeatures) {
  if (f.properties.name) countryFeatureMap.set(f.properties.name, f);
}
const countryContinents = JSON.parse(fs.readFileSync(path.join(__dirname, 'country-continents.json'), 'utf8'));
const microCountries = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'data', 'micro-countries.json'), 'utf8'));

// ------------------------------------------------------------------
// Graph-color countries so neighbours never share the same colour
// ------------------------------------------------------------------
const PASTEL_PALETTE = [
  '#B4D7E8', // soft blue
  '#B8E0D2', // soft mint
  '#F3D1BF', // soft peach
  '#E6C9E0', // soft lilac
  '#D4E6B5', // soft green
  '#E8D5B7', // soft tan
  '#C9D6E8', // soft periwinkle
];

const neighbors = topojson.neighbors(topoData.objects.countries.geometries);
const n = countryFeatures.length;
const colorAssignments = new Array(n).fill(-1);
const usageCounts = new Array(PASTEL_PALETTE.length).fill(0);

// DSatur graph-colouring: always colour the vertex with the most distinctly-coloured
// neighbours first. This avoids palette exhaustion that naive sequential greedy
// produces for high-degree nodes (e.g. China with 14 neighbours).
{
  const saturation = new Array(n).fill(0);           // distinct neighbour colours seen
  const neighborColorSets = Array.from({ length: n }, () => new Set());
  const degree = neighbors.map(nb => nb.length);

  for (let step = 0; step < n; step++) {
    // Pick the uncoloured vertex with the highest saturation; break ties by degree.
    let v = -1;
    for (let i = 0; i < n; i++) {
      if (colorAssignments[i] !== -1) continue;
      if (v === -1
        || saturation[i] > saturation[v]
        || (saturation[i] === saturation[v] && degree[i] > degree[v])) {
        v = i;
      }
    }

    // Assign the least-used palette colour not already used by a neighbour.
    const usedByNeighbors = neighborColorSets[v];
    let best = -1;
    for (let c = 0; c < PASTEL_PALETTE.length; c++) {
      if (!usedByNeighbors.has(c)) {
        if (best === -1 || usageCounts[c] < usageCounts[best]) best = c;
      }
    }

    colorAssignments[v] = best;
    usageCounts[best]++;

    // Propagate the new colour into each uncoloured neighbour's saturation set.
    for (const nb of neighbors[v]) {
      if (colorAssignments[nb] === -1 && !neighborColorSets[nb].has(best)) {
        neighborColorSets[nb].add(best);
        saturation[nb]++;
      }
    }
  }
}

const countryColorMap = {};
for (let i = 0; i < n; i++) {
  const name = countryFeatures[i].properties.name;
  if (name) {
    countryColorMap[name] = PASTEL_PALETTE[colorAssignments[i]];
  }
}

// Verify no two neighbours share a colour (sanity check).
let conflicts = 0;
for (let i = 0; i < n; i++) {
  for (const nb of neighbors[i]) {
    if (nb > i && colorAssignments[i] !== -1 && colorAssignments[i] === colorAssignments[nb]) {
      console.warn('[Geo] Colour conflict:', countryFeatures[i].properties.name, '↔', countryFeatures[nb].properties.name);
      conflicts++;
    }
  }
}
if (conflicts === 0) {
  console.log('[Geo] Graph colouring: no conflicts across', n, 'countries with', PASTEL_PALETTE.length, 'colours');
}

// ------------------------------------------------------------------
// Build GAME_COUNTRIES list (polygons + micro point-markers)
// ------------------------------------------------------------------
const GAME_COUNTRIES = countryFeatures
  .map(f => ({
    id: f.id,
    name: f.properties.name,
    continent: countryContinents[f.properties.name] || null,
    color: countryColorMap[f.properties.name] || null,
    centroid: geoCentroid(f), // [lng, lat]
  }))
  .filter(c => c.name && c.continent && c.continent !== 'AN');

for (const f of microCountries.features) {
  const name = f.properties.name;
  const continent = countryContinents[name] || null;
  if (name && continent && continent !== 'AN') {
    GAME_COUNTRIES.push({
      id: 'micro-' + name.replace(/[^a-zA-Z0-9]/g, '-'),
      name,
      continent,
      isMicro: true,
      coordinates: f.geometry.coordinates,
      centroid: f.geometry.coordinates,
      color: PASTEL_PALETTE[Math.floor(Math.random() * PASTEL_PALETTE.length)],
    });
  }
}

function shuffle(array) {
  const arr = array.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ------------------------------------------------------------------
// Proximity Mode Utilities
// ------------------------------------------------------------------
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

function computeDistance(pin, target) {
  const { lat, lng } = pin;
  if (target.isMicro) {
    const [tLng, tLat] = target.coordinates;
    const dist = haversineKm(lat, lng, tLat, tLng);
    return dist <= 100 ? 0 : dist;
  }
  const feature = countryFeatureMap.get(target.name);
  if (feature && geoContains(feature, [lng, lat])) return 0;
  const [cLng, cLat] = target.centroid;
  return haversineKm(lat, lng, cLat, cLng);
}

function rankGuesses(results, N) {
  const out = results.map(r => ({ ...r, points: 0 }));
  const placed = out
    .filter(r => r.distance !== null)
    .sort((a, b) => a.distance - b.distance);

  let i = 0;
  while (i < placed.length) {
    let j = i;
    while (j < placed.length && placed[j].distance === placed[i].distance) j++;
    const pts = Math.max(0, N - i);
    for (let k = i; k < j; k++) placed[k].points = pts;
    i = j;
  }
  return out;
}

// ------------------------------------------------------------------
// Room / Game Engine
// ------------------------------------------------------------------
class Room {
  constructor(roomId) {
    this.roomId = roomId;
    this.state = 'LOBBY';
    this.settings = {
      mode: 'highlight',
      questionsPerRound: 10,
      timerPerGuess: 30,
      listSize: 4,
      optionPool: 'random',
      penalty: 0,
      guessesPerChallenge: 5,
      challengesPerGame: 5,
    };
    this.players = new Map(); // name -> player
    this.sockets = new Map(); // ws -> name
    this.currentRound = 0;
    this.currentQuestionIndex = 0;
    this.questions = [];
    this.questionStartTime = 0;
    this.questionTimer = null;
    this.tickTimer = null;
    this.nextQuestionTimer = null;
    this.pendingNextFn = null;
    this.qrCodeDataUrl = null;
    this.pingInterval = null;
    this.pingMisses = 0;
    this.challengeTarget = null;     // current target country for proximity mode
    this.awaitingPong = false;
    this.lastActivity = Date.now();
    this.createdAt = Date.now();
    this.pinSaveTimers = {};         // playerName -> debounce timer for pin saves
    this.gameEndCleanupTimer = null;
  }

  get activePlayers() {
    return Array.from(this.players.values()).filter(p => p.connected && !p.spectator);
  }

  get allConnected() {
    return Array.from(this.players.values()).filter(p => p.connected);
  }

  get host() {
    return Array.from(this.players.values()).find(p => p.isHost);
  }

  getPlayerByWs(ws) {
    const name = this.sockets.get(ws);
    return name ? this.players.get(name) : null;
  }

  assignHost() {
    const connected = this.allConnected.sort((a, b) => a.joinedAt - b.joinedAt);
    if (connected.length > 0) {
      for (const p of this.players.values()) p.isHost = false;
      connected[0].isHost = true;
      this.broadcast({ type: 'hostAssigned', hostName: connected[0].name });
      this.broadcastPlayerList();
      this.broadcastState();
      this.startHostPing();
    } else {
      this.stopHostPing();
    }
  }

  addPlayer(ws, name) {
    this.lastActivity = Date.now();
    name = (name || '').trim().substring(0, 20);
    if (!name) {
      let n = this.players.size + 1;
      while (this.players.has(`Player${n}`)) n++;
      name = `Player${n}`;
    }

    const existing = this.players.get(name);
    if (existing) {
      if (existing.connected && existing.ws && existing.ws.readyState === 1) {
        this.send(ws, { type: 'error', message: `${name} is already in the room` });
        return null;
      }
      existing.connected = true;
      existing.ws = ws;
      existing.pin = null;
      existing.pinLocked = false;
      this.sockets.set(ws, name);
      db.savePlayer(this.roomId, existing);
      this.sendState(ws);
      if (this.state === 'QUESTION') {
        this.sendCurrentQuestion(ws);
      }
      this.broadcastPlayerList();
      if (!this.host) this.assignHost();
      return existing;
    }

    const player = {
      name,
      isHost: false,
      joinedAt: Date.now(),
      connected: true,
      score: 0,
      totalScore: 0,
      spectator: this.state !== 'LOBBY',
      answer: null,
      answeredAt: null,
      pin: null,
      pinLocked: false,
      ws,
    };
    this.players.set(name, player);
    this.sockets.set(ws, name);
    db.savePlayer(this.roomId, player);
    this.sendState(ws);
    this.broadcastPlayerList();
    if (!this.host) this.assignHost();
    return player;
  }

  removePlayer(ws) {
    const name = this.sockets.get(ws);
    if (!name) return;
    const player = this.players.get(name);
    if (player && player.ws === ws) {
      player.connected = false;
      player.ws = null;
      if (player.isHost) {
        player.isHost = false;
        this.assignHost();
      }
    }
    this.sockets.delete(ws);
    this.broadcastPlayerList();
  }

  changeName(ws, newName) {
    const player = this.getPlayerByWs(ws);
    if (!player || !newName || !newName.trim()) return;
    newName = newName.trim().substring(0, 20);
    if (newName === player.name) return;

    const target = this.players.get(newName);
    if (target && target.connected) {
      this.send(ws, { type: 'error', message: `${newName} is already in the room` });
      return;
    }

    const oldName = player.name;
    this.players.delete(oldName);
    player.name = newName;
    this.players.set(newName, player);

    for (const [s, n] of this.sockets) {
      if (n === oldName) {
        this.sockets.set(s, newName);
        break;
      }
    }

    this.lastActivity = Date.now();
    db.saveRoom(this);
    db.savePlayers(this);

    this.broadcastPlayerList();
  }

  updateSettings(ws, setting, value) {
    const player = this.getPlayerByWs(ws);
    if (!player || !player.isHost) return;
    if (this.settings.hasOwnProperty(setting)) {
      if (setting === 'questionsPerRound') {
        const n = parseInt(value, 10);
        if (!isNaN(n) && n >= 1 && n <= 50) this.settings.questionsPerRound = n;
      } else if (setting === 'listSize') {
        const n = parseInt(value, 10);
        if (!isNaN(n) && n >= 3 && n <= 10) this.settings.listSize = n;
      } else if (setting === 'timerPerGuess') {
        const n = parseInt(value, 10);
        if (!isNaN(n) && n >= 0) this.settings.timerPerGuess = n;
      } else if (setting === 'guessesPerChallenge') {
        const n = parseInt(value, 10);
        if (!isNaN(n) && n >= 3 && n <= 10) this.settings.guessesPerChallenge = n;
      } else if (setting === 'challengesPerGame') {
        const n = parseInt(value, 10);
        if (!isNaN(n) && n >= 3 && n <= 10) this.settings.challengesPerGame = n;
      } else {
        this.settings[setting] = value;
      }
      this.lastActivity = Date.now();
      db.saveRoom(this);
      this.broadcastSettings();
    }
  }

  startRound(ws) {
    const player = this.getPlayerByWs(ws);
    if (!player || !player.isHost) return;
    if (this.activePlayers.length === 0) return;

    // Proximity mode uses its own flow
    if (this.settings.mode === 'proximity') {
      if (this.state !== 'LOBBY' && this.state !== 'ROUND_END') return;
      const fromLobby = this.state === 'LOBBY';
      this.startProximityRound(fromLobby);
      return;
    }

    if (this.state === 'LOBBY') {
      this.currentRound = 1;
      for (const p of this.players.values()) {
        p.score = 0;
        p.totalScore = 0;
        if (p.connected) p.spectator = false;
      }
    } else if (this.state === 'ROUND_END') {
      this.currentRound++;
    }

    this.currentQuestionIndex = 0;
    this.startRoundInternal();
  }

  startRoundInternal() {
    this.questions = this.generateQuestions();
    this.currentQuestionIndex = 0;
    for (const p of this.activePlayers) {
      p.score = 0;
      p.answer = null;
      p.answeredAt = null;
    }
    this.lastActivity = Date.now();
    db.saveRoom(this);
    db.savePlayers(this);
    this.broadcast({ type: 'roundStart', round: this.currentRound });
    this.startQuestion();
  }

  startProximityRound(fromLobby) {
    if (fromLobby) {
      this.currentRound = 1;
      for (const p of this.players.values()) {
        p.score = 0;
        p.totalScore = 0;
        if (p.connected) p.spectator = false;
      }
    } else {
      this.currentRound++;
    }
    this.startProximityChallenge();
  }

  startProximityChallenge() {
    this.currentQuestionIndex = 0;

    let pool = GAME_COUNTRIES;
    if (this.settings.optionPool === 'sameContinent') {
      const byContinent = {};
      for (const c of GAME_COUNTRIES) {
        if (!byContinent[c.continent]) byContinent[c.continent] = [];
        byContinent[c.continent].push(c);
      }
      const validContinents = Object.keys(byContinent).filter(k => byContinent[k].length > 0);
      if (validContinents.length > 0) {
        const continent = validContinents[Math.floor(Math.random() * validContinents.length)];
        pool = byContinent[continent];
      }
    }

    this.challengeTarget = pool[Math.floor(Math.random() * pool.length)];

    for (const p of this.activePlayers) {
      p.score = 0;
      p.pin = null;
      p.pinLocked = false;
    }

    this.lastActivity = Date.now();
    db.saveRoom(this);
    db.savePlayers(this);
    this.broadcast({ type: 'roundStart', round: this.currentRound });
    this.startProximityGuess();
  }

  startProximityGuess() {
    this.state = 'QUESTION';
    for (const p of this.activePlayers) {
      p.pin = null;
      p.pinLocked = false;
    }
    this.questionStartTime = Date.now();
    this.lastActivity = Date.now();
    db.saveRoom(this);
    db.savePlayers(this);

    this.broadcast({
      type: 'question',
      index: this.currentQuestionIndex,
      totalQuestions: this.settings.guessesPerChallenge,
      round: this.currentRound,
      mode: 'proximity',
      timeLimit: this.settings.timerPerGuess,
    });
    this.broadcastState();

    if (this.settings.timerPerGuess > 0) {
      this.questionTimer = setTimeout(() => this.endProximityGuess(), this.settings.timerPerGuess * 1000);
      this.tickTimer = setInterval(() => {
        const elapsed = (Date.now() - this.questionStartTime) / 1000;
        const remaining = Math.max(0, Math.ceil(this.settings.timerPerGuess - elapsed));
        this.broadcast({ type: 'tick', remaining });
      }, 1000);
    }
  }

  handlePlacePin(ws, lat, lng) {
    if (this.state !== 'QUESTION') return;
    const player = this.getPlayerByWs(ws);
    if (!player || player.spectator || player.pinLocked) return;
    if (typeof lat !== 'number' || typeof lng !== 'number') return;

    player.pin = { lat, lng };
    this.broadcast({ type: 'pinUpdate', name: player.name, lat, lng });

    // Debounced save — cancel any existing timer and set a new 500ms one
    if (this.pinSaveTimers[player.name]) {
      clearTimeout(this.pinSaveTimers[player.name]);
    }
    this.pinSaveTimers[player.name] = setTimeout(() => {
      this.pinSaveTimers[player.name] = null;
      db.savePlayer(this.roomId, player);
    }, 500);
  }

  handleLockPin(ws) {
    if (this.state !== 'QUESTION') return;
    const player = this.getPlayerByWs(ws);
    if (!player || player.spectator || !player.pin || player.pinLocked) return;

    player.pinLocked = true;

    // Cancel debounce and save immediately
    if (this.pinSaveTimers[player.name]) {
      clearTimeout(this.pinSaveTimers[player.name]);
      this.pinSaveTimers[player.name] = null;
    }
    db.savePlayer(this.roomId, player);

    this.broadcast({ type: 'pinLocked', name: player.name });

    if (this.activePlayers.every(p => p.pinLocked)) {
      this.endProximityGuess();
    }
  }

  endProximityGuess() {
    if (this.state !== 'QUESTION') return;
    this.state = 'QUESTION_END';
    this.clearTimers();

    const target = this.challengeTarget;
    const N = this.activePlayers.length;

    // Build results with distances
    const results = this.activePlayers.map(p => ({
      name: p.name,
      lat: p.pin ? p.pin.lat : null,
      lng: p.pin ? p.pin.lng : null,
      distance: p.pin ? computeDistance(p.pin, target) : null,
      points: 0,
      exactHit: false,
    }));

    const exactHitNames = results.filter(r => r.distance === 0).map(r => r.name);
    const isExactHit = exactHitNames.length > 0;
    const isLastGuess = (this.currentQuestionIndex + 1) >= this.settings.guessesPerChallenge;
    const challengeOver = isExactHit || isLastGuess;

    if (isExactHit) {
      // Exact-hit players: override challenge score to N
      for (const name of exactHitNames) {
        const player = this.players.get(name);
        const result = results.find(r => r.name === name);
        if (player && result) {
          player.totalScore = player.totalScore - player.score + N;
          player.score = N;
          result.points = N;
          result.exactHit = true;
        }
      }
      // Other players: no points for this guess (retain accumulated)
    } else {
      // Normal guess: rank-based points for all
      const ranked = rankGuesses(results, N);
      // Copy points back into original results for broadcast
      for (const r of ranked) {
        const orig = results.find(o => o.name === r.name);
        if (orig) orig.points = r.points;
        const player = this.players.get(r.name);
        if (player && r.points > 0) {
          player.score += r.points;
          player.totalScore += r.points;
        }
      }
    }

    this.lastActivity = Date.now();
    db.saveRoom(this);
    db.savePlayers(this);

    this.broadcast({ type: 'guessEnd', guesses: results, challengeOver, exactHit: isExactHit });
    this.broadcastPlayerList();

    const delay = isExactHit ? 2000 : 5000;
    this.scheduleNextQuestion(delay, () => {
      if (challengeOver) {
        this.endProximityChallenge();
      } else {
        this.currentQuestionIndex++;
        this.startProximityGuess();
      }
    });
  }

  endProximityChallenge() {
    this.state = 'ROUND_END';
    this.lastActivity = Date.now();
    db.saveRoom(this);
    db.savePlayers(this);

    const rankings = this.activePlayers
      .map(p => ({ name: p.name, score: p.score, totalScore: p.totalScore }))
      .sort((a, b) => b.score - a.score);

    // Promote spectators for next challenge
    for (const p of this.players.values()) {
      if (p.connected && p.spectator) {
        p.spectator = false;
        p.score = 0;
      }
    }

    const isLastChallenge = this.currentRound >= this.settings.challengesPerGame;
    const targetCoords = this.challengeTarget.isMicro
      ? this.challengeTarget.coordinates
      : this.challengeTarget.centroid;

    this.broadcast({
      type: 'challengeEnd',
      targetName: this.challengeTarget.name,
      targetCoords,
      rankings,
      isLastChallenge,
    });
    if (!isLastChallenge) this.broadcastState();

    if (isLastChallenge) {
      setTimeout(() => this.endGameInternal(), 0);
    }
  }

  generateQuestions() {
    const questions = [];
    const count = this.settings.questionsPerRound;
    const mode = this.settings.mode;
    const listSize = this.settings.listSize;

    let questionPool = GAME_COUNTRIES;
    let optionPool = GAME_COUNTRIES;

    if (this.settings.optionPool === 'sameContinent') {
      const byContinent = {};
      for (const c of GAME_COUNTRIES) {
        if (!byContinent[c.continent]) byContinent[c.continent] = [];
        byContinent[c.continent].push(c);
      }
      const validContinents = Object.keys(byContinent).filter(k => byContinent[k].length >= listSize);
      if (validContinents.length > 0) {
        const continent = validContinents[Math.floor(Math.random() * validContinents.length)];
        questionPool = byContinent[continent];
        optionPool = byContinent[continent];
      }
    }

    const targets = shuffle(questionPool).slice(0, count);
    for (const target of targets) {
      let options = [];
      if (mode === 'highlight') {
        let distractors = optionPool.filter(c => c.name !== target.name);
        distractors = shuffle(distractors).slice(0, listSize - 1);
        options = shuffle([target, ...distractors]).map(c => c.name);
      }
      questions.push({
        targetCountry: target,
        options,
        mode,
      });
    }
    return questions;
  }

  startQuestion() {
    this.state = 'QUESTION';
    for (const p of this.activePlayers) {
      p.answer = null;
      p.answeredAt = null;
    }
    this.questionStartTime = Date.now();
    this.lastActivity = Date.now();
    db.saveRoom(this);
    db.savePlayers(this);
    const q = this.questions[this.currentQuestionIndex];
    const payload = {
      type: 'question',
      index: this.currentQuestionIndex,
      totalQuestions: this.questions.length,
      round: this.currentRound,
      mode: q.mode,
      targetName: q.targetCountry.name,
      options: q.options,
      timeLimit: this.settings.timerPerGuess,
    };
    this.broadcast(payload);
    this.broadcastState();

    if (this.settings.timerPerGuess > 0) {
      this.questionTimer = setTimeout(() => {
        this.endQuestion();
      }, this.settings.timerPerGuess * 1000);

      this.tickTimer = setInterval(() => {
        const elapsed = (Date.now() - this.questionStartTime) / 1000;
        const remaining = Math.max(0, Math.ceil(this.settings.timerPerGuess - elapsed));
        this.broadcast({ type: 'tick', remaining });
      }, 1000);
    }
  }

  handleAnswer(ws, answer) {
    if (this.state !== 'QUESTION') return;
    const player = this.getPlayerByWs(ws);
    if (!player || player.spectator || player.answer !== null) return;

    player.answer = answer;
    player.answeredAt = Date.now();
    db.savePlayer(this.roomId, player);

    const allAnswered = this.activePlayers.every(p => p.answer !== null);
    if (allAnswered) {
      this.endQuestion();
    } else {
      this.broadcast({ type: 'playerAnswered', name: player.name });
    }
  }

  endQuestion() {
    if (this.state !== 'QUESTION') return;
    this.state = 'QUESTION_END';
    this.clearTimers();

    const q = this.questions[this.currentQuestionIndex];
    const correctAnswer = q.targetCountry.name;
    const activeCount = this.activePlayers.length;

    const correctPlayers = this.activePlayers
      .filter(p => p.answer === correctAnswer)
      .sort((a, b) => (a.answeredAt || Infinity) - (b.answeredAt || Infinity));

    const playerAnswers = {};
    for (const p of this.activePlayers) {
      const isCorrect = p.answer === correctAnswer;
      playerAnswers[p.name] = {
        name: p.name,
        answer: p.answer,
        correct: isCorrect,
      };
    }

    for (let i = 0; i < correctPlayers.length; i++) {
      const points = activeCount - i;
      correctPlayers[i].score += points;
      correctPlayers[i].totalScore += points;
    }

    this.lastActivity = Date.now();
    db.saveRoom(this);
    db.savePlayers(this);

    this.broadcast({
      type: 'questionEnd',
      correctAnswer,
      playerAnswers,
      scores: this.activePlayers.map(p => ({ name: p.name, score: p.score })),
    });
    this.broadcastPlayerList();

    this.scheduleNextQuestion(5000, () => {
      this.currentQuestionIndex++;
      if (this.currentQuestionIndex < this.questions.length) {
        this.startQuestion();
      } else {
        this.endRound();
      }
    });
  }

  endRound() {
    this.state = 'ROUND_END';
    this.lastActivity = Date.now();
    db.saveRoom(this);
    db.savePlayers(this);
    const rankings = this.activePlayers
      .map(p => ({ name: p.name, score: p.score }))
      .sort((a, b) => b.score - a.score);

    for (const p of this.players.values()) {
      if (p.connected && p.spectator) {
        p.spectator = false;
        p.score = 0;
      }
    }

    this.broadcast({
      type: 'roundEnd',
      round: this.currentRound,
      rankings,
    });
    this.broadcastState();
  }

  endGameInternal() {
    this.clearTimers();
    this.state = 'GAME_END';
    this.lastActivity = Date.now();
    db.saveRoom(this);
    db.savePlayers(this);
    const finalRankings = this.allConnected
      .map(p => ({ name: p.name, totalScore: p.totalScore }))
      .sort((a, b) => b.totalScore - a.totalScore);
    this.broadcast({ type: 'gameEnd', finalRankings });
    this.broadcastState();
    // Schedule room cleanup from db after 5 minutes
    const roomId = this.roomId;
    this.gameEndCleanupTimer = setTimeout(() => {
      this.gameEndCleanupTimer = null;
      db.deleteRoom(roomId);
    }, 5 * 60 * 1000);
  }

  endGame(ws) {
    const player = this.getPlayerByWs(ws);
    if (!player || !player.isHost) return;
    this.endGameInternal();
  }

  returnToLobby(ws) {
    const player = this.getPlayerByWs(ws);
    if (!player || !player.isHost) return;

    this.clearTimers();
    this.state = 'LOBBY';
    this.currentRound = 0;
    this.currentQuestionIndex = 0;
    this.questions = [];
    for (const p of this.players.values()) {
      p.score = 0;
      p.totalScore = 0;
      p.spectator = false;
    }
    this.lastActivity = Date.now();
    db.saveRoom(this);
    db.savePlayers(this);
    this.broadcast({ type: 'lobbyReset' });
    this.broadcastState();
    this.broadcastPlayerList();
  }

  clearTimers() {
    if (this.questionTimer) {
      clearTimeout(this.questionTimer);
      this.questionTimer = null;
    }
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.nextQuestionTimer) {
      clearTimeout(this.nextQuestionTimer);
      this.nextQuestionTimer = null;
      this.pendingNextFn = null;
    }
  }

  scheduleNextQuestion(delay, fn) {
    this.pendingNextFn = fn;
    this.nextQuestionTimer = setTimeout(() => {
      this.nextQuestionTimer = null;
      this.pendingNextFn = null;
      fn();
    }, delay);
  }

  skipToNext(ws) {
    const player = this.getPlayerByWs(ws);
    if (!player || !player.isHost) return;
    if (this.nextQuestionTimer && this.pendingNextFn) {
      clearTimeout(this.nextQuestionTimer);
      this.nextQuestionTimer = null;
      const fn = this.pendingNextFn;
      this.pendingNextFn = null;
      fn();
    }
  }

  startHostPing() {
    this.stopHostPing();
    this.pingMisses = 0;
    this.awaitingPong = false;
    this.pingInterval = setInterval(() => {
      const h = this.host;
      if (!h || !h.ws || h.ws.readyState !== 1) {
        this.pingMisses++;
        if (this.pingMisses >= 3) {
          this.handleHostTimeout();
        }
        return;
      }
      if (this.awaitingPong) {
        this.pingMisses++;
        if (this.pingMisses >= 3) {
          this.handleHostTimeout();
          return;
        }
      }
      this.awaitingPong = true;
      this.send(h.ws, { type: 'ping' });
    }, 10000);
  }

  stopHostPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    this.awaitingPong = false;
  }

  handlePong(ws) {
    const player = this.getPlayerByWs(ws);
    if (player && player.isHost) {
      this.pingMisses = 0;
      this.awaitingPong = false;
    }
  }

  handleHostTimeout() {
    const h = this.host;
    if (h) {
      h.connected = false;
      h.ws = null;
      h.isHost = false;
    }
    this.assignHost();
    if (!this.host && this.allConnected.length === 0) {
      this.destroy();
    }
  }

  destroy() {
    for (const timer of Object.values(this.pinSaveTimers)) {
      clearTimeout(timer);
    }
    this.pinSaveTimers = {};
    if (this.gameEndCleanupTimer) {
      clearTimeout(this.gameEndCleanupTimer);
      this.gameEndCleanupTimer = null;
    }
    this.clearTimers();
    this.stopHostPing();
    for (const [ws] of this.sockets) {
      this.send(ws, { type: 'roomClosed', reason: 'Room has ended' });
      try { ws.close(); } catch {}
    }
    this.sockets.clear();
    this.players.clear();
    db.deleteRoom(this.roomId);
  }

  send(ws, msg) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(msg));
    }
  }

  broadcast(msg) {
    for (const ws of this.sockets.keys()) {
      this.send(ws, msg);
    }
  }

  sendState(ws) {
    const player = this.getPlayerByWs(ws);
    this.send(ws, {
      type: 'state',
      gameState: this.state,
      settings: this.settings,
      me: player ? { name: player.name, isHost: player.isHost, spectator: player.spectator } : null,
      currentRound: this.currentRound,
      currentQuestionIndex: this.currentQuestionIndex,
    });
  }

  broadcastState() {
    for (const ws of this.sockets.keys()) {
      this.sendState(ws);
    }
  }

  broadcastPlayerList() {
    const list = Array.from(this.players.values()).map(p => ({
      name: p.name,
      isHost: p.isHost,
      connected: p.connected,
      spectator: p.spectator,
      score: p.score,
    }));
    this.broadcast({ type: 'players', players: list });
  }

  broadcastSettings() {
    this.broadcast({ type: 'settings', settings: this.settings });
  }

  sendCurrentQuestion(ws) {
    const q = this.questions[this.currentQuestionIndex];
    if (!q) return;
    const elapsed = (Date.now() - this.questionStartTime) / 1000;
    const remaining = this.settings.timerPerGuess > 0
      ? Math.max(0, Math.ceil(this.settings.timerPerGuess - elapsed))
      : null;
    this.send(ws, {
      type: 'question',
      index: this.currentQuestionIndex,
      totalQuestions: this.questions.length,
      round: this.currentRound,
      mode: q.mode,
      targetName: q.targetCountry.name,
      options: q.options,
      timeLimit: this.settings.timerPerGuess,
      timeRemaining: remaining,
    });
  }

  async generateQR(baseUrl) {
    if (!this.qrCodeDataUrl) {
      this.qrCodeDataUrl = await QRCode.toDataURL(`${baseUrl}/?room=${this.roomId}`, { width: 256 });
    }
    return this.qrCodeDataUrl;
  }
}

// ------------------------------------------------------------------
// HTTP & WS Server
// ------------------------------------------------------------------
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

(async () => {
  app.use(express.json());

  const rooms = new Map();

app.post('/api/rooms', async (req, res) => {
  let roomId = generateRoomId();
  while (rooms.has(roomId)) {
    roomId = generateRoomId();
  }
  const room = new Room(roomId);
  rooms.set(roomId, room);
  db.saveRoom(room);
  const baseUrl = getBaseUrl(req);
  const qr = await room.generateQR(baseUrl);
  res.json({ roomId, qr, url: `${baseUrl}/?room=${roomId}` });
});

app.get('/api/rooms/:roomId', (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) {
    return res.status(404).json({ exists: false });
  }
  res.json({ exists: true, playerCount: room.allConnected.length });
});

app.get('/api/rooms/:roomId/qr', async (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  const baseUrl = getBaseUrl(req);
  const qr = await room.generateQR(baseUrl);
  res.json({ qr, url: `${baseUrl}/?room=${room.roomId}` });
});

app.get('/api/countries', (req, res) => {
  res.json(GAME_COUNTRIES);
});

app.get('/api/country-colors', (req, res) => {
  res.json(countryColorMap);
});

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'join': {
        if (!msg.roomId) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room ID is required.' }));
          return;
        }
        const room = rooms.get(msg.roomId);
        if (!room) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room not found.' }));
          return;
        }
        const player = room.addPlayer(ws, msg.name);
        if (player) {
          room.send(ws, { type: 'joined', name: player.name });
        }
        break;
      }
      case 'pong': {
        for (const room of rooms.values()) {
          if (room.sockets.has(ws)) {
            room.handlePong(ws);
            break;
          }
        }
        break;
      }
      case 'updateSettings': {
        for (const room of rooms.values()) {
          if (room.sockets.has(ws)) {
            room.updateSettings(ws, msg.setting, msg.value);
            break;
          }
        }
        break;
      }
      case 'startRound': {
        for (const room of rooms.values()) {
          if (room.sockets.has(ws)) {
            room.startRound(ws);
            break;
          }
        }
        break;
      }
      case 'endGame': {
        for (const room of rooms.values()) {
          if (room.sockets.has(ws)) {
            room.endGame(ws);
            break;
          }
        }
        break;
      }
      case 'returnToLobby': {
        for (const room of rooms.values()) {
          if (room.sockets.has(ws)) {
            room.returnToLobby(ws);
            break;
          }
        }
        break;
      }
      case 'answer': {
        for (const room of rooms.values()) {
          if (room.sockets.has(ws)) {
            room.handleAnswer(ws, msg.answer);
            break;
          }
        }
        break;
      }
      case 'playAgain': {
        for (const room of rooms.values()) {
          if (room.sockets.has(ws)) {
            room.returnToLobby(ws);
            break;
          }
        }
        break;
      }
      case 'changeName': {
        for (const room of rooms.values()) {
          if (room.sockets.has(ws)) {
            room.changeName(ws, msg.name);
            break;
          }
        }
        break;
      }
      case 'placePin': {
        for (const room of rooms.values()) {
          if (room.sockets.has(ws)) {
            room.handlePlacePin(ws, msg.lat, msg.lng);
            break;
          }
        }
        break;
      }
      case 'lockPin': {
        for (const room of rooms.values()) {
          if (room.sockets.has(ws)) {
            room.handleLockPin(ws);
            break;
          }
        }
        break;
      }
      case 'skipToNext': {
        for (const room of rooms.values()) {
          if (room.sockets.has(ws)) {
            room.skipToNext(ws);
            break;
          }
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    for (const [roomId, room] of rooms) {
      if (room.sockets.has(ws)) {
        room.removePlayer(ws);
        if (room.allConnected.length === 0) {
          room.destroy();
          rooms.delete(roomId);
        }
        break;
      }
    }
  });

  ws.on('error', () => {
    for (const [roomId, room] of rooms) {
      if (room.sockets.has(ws)) {
        room.removePlayer(ws);
        if (room.allConnected.length === 0) {
          room.destroy();
          rooms.delete(roomId);
        }
        break;
      }
    }
  });
});

// Cleanup idle empty rooms every 60s
setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    if (room.allConnected.length === 0 && now - room.lastActivity > ROOM_IDLE_TIMEOUT_MS) {
      console.log(`[Geo] Cleaning up idle room ${roomId}`);
      room.destroy();
      rooms.delete(roomId);
    }
  }
}, 60000);

function reloadRoomsFromDB() {
  db.cleanupOldRooms(Date.now() - ROOM_IDLE_TIMEOUT_MS);

  const roomRows = db.loadAllRooms();
  let restored = 0;

  for (const row of roomRows) {
    try {
      const room = new Room(row.room_id);

      room.state = row.state;
      room.settings = JSON.parse(row.settings);
      room.currentRound = row.current_round;
      room.currentQuestionIndex = row.current_question_index;
      room.questions = JSON.parse(row.questions);
      room.questionStartTime = row.question_start_time;
      room.challengeTarget = row.challenge_target ? JSON.parse(row.challenge_target) : null;
      room.lastActivity = row.last_activity;
      room.createdAt = row.created_at;

      const playerRows = db.loadPlayersForRoom(row.room_id);
      for (const pr of playerRows) {
        const player = {
          name: pr.name,
          ws: null,
          isHost: pr.is_host === 1,
          connected: false,
          score: pr.score,
          totalScore: pr.total_score,
          spectator: pr.spectator === 1,
          answer: pr.answer,
          answeredAt: pr.answered_at,
          joinedAt: pr.answered_at ?? room.lastActivity,
          pin: (pr.pin_lat !== null && pr.pin_lng !== null) ? { lat: pr.pin_lat, lng: pr.pin_lng } : null,
          pinLocked: pr.pin_locked === 1,
        };
        room.players.set(pr.name, player);
      }

      if (room.state === 'QUESTION' && room.settings.timerPerGuess > 0) {
        const isProximity = room.settings.mode === 'proximity';
        const remaining = room.settings.timerPerGuess * 1000 - (Date.now() - room.questionStartTime);

        if (remaining <= 0) {
          if (isProximity) {
            room.endProximityGuess();
          } else {
            room.endQuestion();
          }
        } else {
          if (isProximity) {
            room.questionTimer = setTimeout(() => room.endProximityGuess(), remaining);
          } else {
            room.questionTimer = setTimeout(() => room.endQuestion(), remaining);
          }
          room.tickTimer = setInterval(() => {
            const elapsed = (Date.now() - room.questionStartTime) / 1000;
            const rem = Math.max(0, Math.ceil(room.settings.timerPerGuess - elapsed));
            if (rem === 0) return;
            room.broadcast({ type: 'tick', remaining: rem });
          }, 1000);
        }
      }

      rooms.set(row.room_id, room);
      restored++;
    } catch (e) {
      console.error(`[Geo] Failed to restore room ${row.room_id}:`, e.message);
    }
  }

  console.log(`[Geo] Restored ${restored} room(s) from database`);
}

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, '..', 'dist')));
  }

  reloadRoomsFromDB();

  server.listen(PORT, () => {
    console.log(`Geo Challenge server running at http://${detectLocalIP()}:${PORT}`);
  });

  if (require.main !== module) {
    module.exports = { reloadRoomsFromDB, rooms, db };
  }
})();
