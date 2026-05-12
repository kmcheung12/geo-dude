/**
 * Geo Challenge Server
 * HTTP + WebSocket server with multi-room management and game engine.
 */

import express from 'express';
import { ClientMessage, ServerMessage, GameState } from '../shared/constants.js';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as topojson from 'topojson-client';
// geoContains used in endProximityGuess (Task 6); geoCentroid used here for centroid precomputation
import { geoContains, geoCentroid } from 'd3-geo';
import { openDatabase } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = openDatabase(path.join(__dirname, '..', 'data', 'geo-challenge.db'));

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
    this.state = GameState.LOBBY;
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
    this.spyTurnOrder   = [];   // player names, set at game start
    this.currentSpyIndex = 0;  // index into spyTurnOrder
    this.spyPickingTimer = null; // auto-pick timeout
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
      this.broadcast({ type: ServerMessage.HOST_ASSIGNED, hostName: connected[0].name });
      this.broadcastPlayerList();
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
        this.send(ws, this.state, { type: ServerMessage.ERROR, message: `${name} is already in the room` });
        return null;
      }
      existing.connected = true;
      existing.ws = ws;
      existing.pin = null;
      existing.pinLocked = false;
      this.sockets.set(ws, name);
      db.savePlayer(this.roomId, existing);
      if (this.state === GameState.QUESTION) {
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
      spectator: this.state !== GameState.LOBBY,
      answer: null,
      answeredAt: null,
      pin: null,
      pinLocked: false,
      ws,
    };
    this.players.set(name, player);
    this.sockets.set(ws, name);
    db.savePlayer(this.roomId, player);
    if (!this.host) {
        this.assignHost();
    } else { 
        this.broadcastPlayerList();
    }
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
      this.send(ws, this.state, { type: ServerMessage.ERROR, message: `${newName} is already in the room` });
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
    if (this.activePlayers.length < 2) return;  // spy needs at least 2 players

    if (this.settings.mode === 'spy') {
      if (this.state !== GameState.LOBBY && this.state !== GameState.ROUND_END) return;
      this.startSpyGame(this.state === GameState.LOBBY);
      return;
    }

    // Proximity mode uses its own flow
    if (this.settings.mode === 'proximity') {
      if (this.state !== GameState.LOBBY && this.state !== GameState.ROUND_END) return;
      const fromLobby = this.state === GameState.LOBBY;
      this.startProximityRound(fromLobby);
      return;
    }

    if (this.state === GameState.LOBBY) {
      this.currentRound = 1;
      for (const p of this.players.values()) {
        p.score = 0;
        p.totalScore = 0;
        if (p.connected) p.spectator = false;
      }
    } else if (this.state === GameState.ROUND_END) {
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
    this.broadcast({ type: ServerMessage.ROUND_START, round: this.currentRound });
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

  startSpyGame(fromLobby) {
    if (fromLobby) {
      this.currentRound = 1;
      for (const p of this.players.values()) {
        p.score = 0;
        p.totalScore = 0;
        if (p.connected) p.spectator = false;
      }
      // Shuffle turn order once; same order repeats each round
      this.spyTurnOrder = shuffle(this.activePlayers.map(p => p.name));
    } else {
      this.currentRound++;
    }
    this.currentSpyIndex = 0;
    this.startSpyPicking();
  }

  startSpyPicking() {
    this.state = GameState.SPY_PICKING;
    this.lastActivity = Date.now();
    db.saveRoom(this);

    const spyName = this.spyTurnOrder[this.currentSpyIndex];
    const turnInRound = this.currentSpyIndex + 1;
    const totalTurns = this.spyTurnOrder.length;

    this.broadcast({
      type: ServerMessage.SPY_PICKING,
      spyName,
      round: this.currentRound,
      totalRounds: this.settings.challengesPerGame,
      turnInRound,
      totalTurns,
    });

    // Auto-pick if spy doesn't respond within timerPerGuess seconds (min 15s)
    const timeout = Math.max(15, this.settings.timerPerGuess) * 1000;
    this.spyPickingTimer = setTimeout(() => {
      this.spyPickingTimer = null;
      if (this.state !== GameState.SPY_PICKING) return;
      const randomCountry = GAME_COUNTRIES[Math.floor(Math.random() * GAME_COUNTRIES.length)];
      this.beginSpyChallenge(randomCountry);
    }, timeout);
  }

  handlePickCountry(ws, name) {
    if (this.state !== GameState.SPY_PICKING) return;
    const player = this.getPlayerByWs(ws);
    const spyName = this.spyTurnOrder[this.currentSpyIndex];
    if (!player || player.name !== spyName) return;

    const country = GAME_COUNTRIES.find(c => c.name === name);
    if (!country) {
      this.send(ws, this.state, { type: ServerMessage.ERROR, message: 'Unknown country.' });
      return;
    }

    if (this.spyPickingTimer) {
      clearTimeout(this.spyPickingTimer);
      this.spyPickingTimer = null;
    }

    this.beginSpyChallenge(country);
  }

  beginSpyChallenge(country) {
    this.challengeTarget = country;
    this.currentQuestionIndex = 0;
    for (const p of this.activePlayers) {
      p.score = 0;
      p.pin = null;
      p.pinLocked = false;
    }
    this.lastActivity = Date.now();
    db.saveRoom(this);
    db.savePlayers(this);
    this.broadcast({ type: ServerMessage.ROUND_START, round: this.currentRound });
    this.startProximityGuess();   // reuse proximity guess flow
  }

  endSpyChallenge() {
    this.state = GameState.ROUND_END;
    this.lastActivity = Date.now();

    const spyName = this.spyTurnOrder[this.currentSpyIndex];
    const spyPlayer = this.players.get(spyName);
    const guessers = this.activePlayers.filter(p => p.name !== spyName);

    // Spy score = minimum distance among guessers (best guesser's distance).
    // Guesser distances are stored in p.lastSpyDistance during endProximityGuess (Task 8b).
    const distances = guessers
      .map(p => p.lastSpyDistance)
      .filter(d => d !== undefined && d !== null);
    const spyDistance = distances.length > 0 ? Math.min(...distances) : 20015;

    if (spyPlayer) {
      spyPlayer.totalScore += spyDistance;
    }

    // Promote spectators
    for (const p of this.players.values()) {
      if (p.connected && p.spectator) {
        p.spectator = false;
        p.score = 0;
      }
    }

    db.saveRoom(this);
    db.savePlayers(this);

    const targetCoords = this.challengeTarget.isMicro
      ? this.challengeTarget.coordinates
      : this.challengeTarget.centroid;

    // Determine next spy for banner
    const nextSpyIndex = this.currentSpyIndex + 1;
    const isLastTurnInRound = nextSpyIndex >= this.spyTurnOrder.length;
    const isLastRound = isLastTurnInRound && this.currentRound >= this.settings.challengesPerGame;
    const nextSpyName = isLastTurnInRound ? null : this.spyTurnOrder[nextSpyIndex];

    const rankings = this.activePlayers
      .map(p => ({ name: p.name, score: p.score, totalScore: p.totalScore }))
      .sort((a, b) => a.totalScore - b.totalScore);  // ascending: lower distance = better

    this.broadcast({
      type: ServerMessage.CHALLENGE_END,
      targetName: this.challengeTarget.name,
      targetCoords,
      rankings,
      isLastChallenge: isLastRound,
      nextSpyName,
      isLastTurnInRound,
    });

    if (isLastRound) {
      setTimeout(() => this.endGameInternal(), 0);
      return;
    }

    // Auto-advance after 2s banner
    setTimeout(() => {
      if (isLastTurnInRound) {
        this.currentRound++;
        this.currentSpyIndex = 0;
      } else {
        this.currentSpyIndex++;
      }
      this.startSpyPicking();
    }, 2000);
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
    this.broadcast({ type: ServerMessage.ROUND_START, round: this.currentRound });
    this.startProximityGuess();
  }

  startProximityGuess() {
    this.state = GameState.QUESTION;
    for (const p of this.activePlayers) {
      p.pin = null;
      p.pinLocked = false;
    }
    this.questionStartTime = Date.now();
    this.lastActivity = Date.now();
    db.saveRoom(this);
    db.savePlayers(this);

    this.broadcast({
      type: ServerMessage.QUESTION,
      index: this.currentQuestionIndex,
      totalQuestions: this.settings.guessesPerChallenge,
      round: this.currentRound,
      mode: this.settings.mode,
      timeLimit: this.settings.timerPerGuess,
    });

    if (this.settings.timerPerGuess > 0) {
      this.questionTimer = setTimeout(() => this.endProximityGuess(), this.settings.timerPerGuess * 1000);
      this.tickTimer = setInterval(() => {
        const elapsed = (Date.now() - this.questionStartTime) / 1000;
        const remaining = Math.max(0, Math.ceil(this.settings.timerPerGuess - elapsed));
        this.broadcast({ type: ServerMessage.TICK, remaining });
      }, 1000);
    }
  }

  handlePlacePin(ws, lat, lng) {
    if (this.state !== GameState.QUESTION) return;
    const player = this.getPlayerByWs(ws);
    if (!player || player.spectator || player.pinLocked) return;
    if (this.settings.mode === 'spy' && this.state === GameState.QUESTION &&
        this.spyTurnOrder[this.currentSpyIndex] === player.name) return;
    if (typeof lat !== 'number' || typeof lng !== 'number') return;

    player.pin = { lat, lng };
    this.broadcast({ type: ServerMessage.PIN_UPDATE, name: player.name, lat, lng });

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
    if (this.state !== GameState.QUESTION) return;
    const player = this.getPlayerByWs(ws);
    if (!player || player.spectator || !player.pin || player.pinLocked) return;
    if (this.settings.mode === 'spy' && this.state === GameState.QUESTION &&
        this.spyTurnOrder[this.currentSpyIndex] === player.name) return;

    player.pinLocked = true;

    // Cancel debounce and save immediately
    if (this.pinSaveTimers[player.name]) {
      clearTimeout(this.pinSaveTimers[player.name]);
      this.pinSaveTimers[player.name] = null;
    }
    db.savePlayer(this.roomId, player);

    this.broadcast({ type: ServerMessage.PIN_LOCKED, name: player.name });

    if (this.activePlayers.every(p => p.pinLocked)) {
      this.endProximityGuess();
    }
  }

  endProximityGuess() {
    if (this.state !== GameState.QUESTION) return;
    this.state = GameState.QUESTION_END;
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

    if (this.settings.mode === 'spy') {
      // Spy mode: score = raw distance (lower = better). No rank-based points.
      for (const r of results) {
        const p = this.players.get(r.name);
        if (!p) continue;
        const dist = r.distance !== null ? r.distance : 20015;
        p.lastSpyDistance = dist;
        r.points = 0;  // points column unused in spy mode
        if (p.name !== this.spyTurnOrder[this.currentSpyIndex]) {
          // Only guessers accumulate distance score
          p.score += dist;
          p.totalScore += dist;
        }
      }
    } else if (isExactHit) {
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

    this.broadcast({ type: ServerMessage.GUESS_END, guesses: results, challengeOver, exactHit: isExactHit });
    this.broadcastPlayerList();

    const delay = isExactHit ? 2000 : 5000;
    this.scheduleNextQuestion(delay, () => {
      if (challengeOver) {
        if (this.settings.mode === 'spy') {
          this.endSpyChallenge();
        } else {
          this.endProximityChallenge();
        }
      } else {
        this.currentQuestionIndex++;
        this.startProximityGuess();
      }
    });
  }

  endProximityChallenge() {
    this.state = GameState.ROUND_END;
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
      type: ServerMessage.CHALLENGE_END,
      targetName: this.challengeTarget.name,
      targetCoords,
      rankings,
      isLastChallenge,
    });

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

    // add .fill(questionPool[4]) to hardcode question for debugging
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
    this.state = GameState.QUESTION;
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
      type: ServerMessage.QUESTION,
      index: this.currentQuestionIndex,
      totalQuestions: this.questions.length,
      round: this.currentRound,
      mode: q.mode,
      targetName: q.targetCountry.name,
      options: q.options,
      timeLimit: this.settings.timerPerGuess,
    };
    this.broadcast(payload);

    if (this.settings.timerPerGuess > 0) {
      this.questionTimer = setTimeout(() => {
        this.endQuestion();
      }, this.settings.timerPerGuess * 1000);

      this.tickTimer = setInterval(() => {
        const elapsed = (Date.now() - this.questionStartTime) / 1000;
        const remaining = Math.max(0, Math.ceil(this.settings.timerPerGuess - elapsed));
        this.broadcast({ type: ServerMessage.TICK, remaining });
      }, 1000);
    }
  }

  handleAnswer(ws, answer) {
    if (this.state !== GameState.QUESTION) return;
    const player = this.getPlayerByWs(ws);
    if (!player || player.spectator || player.answer !== null) return;

    player.answer = answer;
    player.answeredAt = Date.now();
    db.savePlayer(this.roomId, player);

    const allAnswered = this.activePlayers.every(p => p.answer !== null);
    if (allAnswered) {
      this.endQuestion();
    } else {
      this.broadcast({ type: ServerMessage.PLAYER_ANSWERED, name: player.name });
    }
  }

  endQuestion() {
    if (this.state !== GameState.QUESTION) return;
    this.state = GameState.QUESTION_END;
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
      type: ServerMessage.QUESTION_END,
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
    this.state = GameState.ROUND_END;
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
      type: ServerMessage.ROUND_END,
      round: this.currentRound,
      rankings,
    });
  }

  endGameInternal() {
    this.clearTimers();
    this.state = GameState.GAME_END;
    this.lastActivity = Date.now();
    db.saveRoom(this);
    db.savePlayers(this);
    const finalRankings = this.allConnected
      .map(p => ({ name: p.name, totalScore: p.totalScore }))
      .sort((a, b) => b.totalScore - a.totalScore);
    this.broadcast({ type: ServerMessage.GAME_END, finalRankings });
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
    this.state = GameState.LOBBY;
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
    this.broadcast({ type: ServerMessage.LOBBY_RESET });
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
    if (this.spyPickingTimer) {
      clearTimeout(this.spyPickingTimer);
      this.spyPickingTimer = null;
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
      this.send(h.ws, this.state, { type: ServerMessage.PING });
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
      this.send(ws, this.state, { type: ServerMessage.ROOM_CLOSED, reason: 'Room has ended' });
      try { ws.close(); } catch {}
    }
    this.sockets.clear();
    this.players.clear();
    db.deleteRoom(this.roomId);
  }

  send(ws, state, msg) {
    if (ws.readyState === 1) {
      msg.gameState = state;
      ws.send(JSON.stringify(msg));
    }
  }

  broadcast(msg) {
    for (const ws of this.sockets.keys()) {
      this.send(ws, this.state, msg);
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
    this.broadcast({ type: ServerMessage.PLAYERS, players: list });
  }

  broadcastSettings() {
    this.broadcast({ type: ServerMessage.SETTINGS, settings: this.settings });
  }

  sendCurrentQuestion(ws) {
    const q = this.questions[this.currentQuestionIndex];
    if (!q) return;
    const elapsed = (Date.now() - this.questionStartTime) / 1000;
    const remaining = this.settings.timerPerGuess > 0
      ? Math.max(0, Math.ceil(this.settings.timerPerGuess - elapsed))
      : null;
    this.send(ws, this.state, {
      type: ServerMessage.QUESTION,
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
      case ClientMessage.JOIN: {
        if (!msg.roomId) {
          ws.send(JSON.stringify({ type: ServerMessage.ERROR, message: 'Room ID is required.' }));
          return;
        }
        const room = rooms.get(msg.roomId);
        if (!room) {
          ws.send(JSON.stringify({ type: ServerMessage.ERROR, message: 'Room not found.' }));
          return;
        }
        const player = room.addPlayer(ws, msg.name);
        if (player) {
          room.send(ws, room.state, { type: ServerMessage.JOINED, name: player.name });
        }
        break;
      }
      case ClientMessage.PONG: {
        for (const room of rooms.values()) {
          if (room.sockets.has(ws)) {
            room.handlePong(ws);
            break;
          }
        }
        break;
      }
      case ClientMessage.UPDATE_SETTINGS: {
        for (const room of rooms.values()) {
          if (room.sockets.has(ws)) {
            room.updateSettings(ws, msg.setting, msg.value);
            break;
          }
        }
        break;
      }
      case ClientMessage.START_ROUND: {
        for (const room of rooms.values()) {
          if (room.sockets.has(ws)) {
            room.startRound(ws);
            break;
          }
        }
        break;
      }
      case ClientMessage.END_GAME: {
        for (const room of rooms.values()) {
          if (room.sockets.has(ws)) {
            room.endGame(ws);
            break;
          }
        }
        break;
      }
      case ClientMessage.RETURN_TO_LOBBY: {
        for (const room of rooms.values()) {
          if (room.sockets.has(ws)) {
            room.returnToLobby(ws);
            break;
          }
        }
        break;
      }
      case ClientMessage.ANSWER: {
        for (const room of rooms.values()) {
          if (room.sockets.has(ws)) {
            room.handleAnswer(ws, msg.answer);
            break;
          }
        }
        break;
      }
      case ClientMessage.PLAY_AGAIN: {
        for (const room of rooms.values()) {
          if (room.sockets.has(ws)) {
            room.returnToLobby(ws);
            break;
          }
        }
        break;
      }
      case ClientMessage.CHANGE_NAME: {
        for (const room of rooms.values()) {
          if (room.sockets.has(ws)) {
            room.changeName(ws, msg.name);
            break;
          }
        }
        break;
      }
      case ClientMessage.PLACE_PIN: {
        for (const room of rooms.values()) {
          if (room.sockets.has(ws)) {
            room.handlePlacePin(ws, msg.lat, msg.lng);
            break;
          }
        }
        break;
      }
      case ClientMessage.LOCK_PIN: {
        for (const room of rooms.values()) {
          if (room.sockets.has(ws)) {
            room.handleLockPin(ws);
            break;
          }
        }
        break;
      }
      case ClientMessage.SKIP_TO_NEXT: {
        for (const room of rooms.values()) {
          if (room.sockets.has(ws)) {
            room.skipToNext(ws);
            break;
          }
        }
        break;
      }
      case ClientMessage.PICK_COUNTRY: {
        for (const room of rooms.values()) {
          if (room.sockets.has(ws)) {
            room.handlePickCountry(ws, msg.name);
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

      if (room.state === GameState.QUESTION && room.settings.timerPerGuess > 0) {
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
            room.broadcast({ type: ServerMessage.TICK, remaining: rem });
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

})();
