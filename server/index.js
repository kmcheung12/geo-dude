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
const colorAssignments = new Array(countryFeatures.length).fill(-1);
const usageCounts = new Array(PASTEL_PALETTE.length).fill(0);

for (let i = 0; i < countryFeatures.length; i++) {
  const used = new Set();
  for (const n of neighbors[i]) {
    if (colorAssignments[n] !== -1) used.add(colorAssignments[n]);
  }
  const valid = [];
  for (let c = 0; c < PASTEL_PALETTE.length; c++) {
    if (!used.has(c)) valid.push(c);
  }
  let best = valid[0];
  for (let v = 1; v < valid.length; v++) {
    if (usageCounts[valid[v]] < usageCounts[best]) {
      best = valid[v];
    }
  }
  colorAssignments[i] = best;
  usageCounts[best]++;
}

const countryColorMap = {};
for (let i = 0; i < countryFeatures.length; i++) {
  const name = countryFeatures[i].properties.name;
  if (name) {
    countryColorMap[name] = PASTEL_PALETTE[colorAssignments[i]];
  }
}

for (let c = 0; c < PASTEL_PALETTE.length; c++) {
  if (usageCounts[c] === 0) {
    console.warn('[Geo] Warning: palette colour', c, PASTEL_PALETTE[c], 'was not used on the map');
  }
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
    };
    this.players = new Map(); // name -> player
    this.sockets = new Map(); // ws -> name
    this.currentRound = 0;
    this.currentQuestionIndex = 0;
    this.questions = [];
    this.questionStartTime = 0;
    this.questionTimer = null;
    this.tickTimer = null;
    this.qrCodeDataUrl = null;
    this.pingInterval = null;
    this.pingMisses = 0;
    this.awaitingPong = false;
    this.lastActivity = Date.now();
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
      this.send(ws, { type: 'error', message: 'Please enter a name.' });
      return null;
    }

    const existing = this.players.get(name);
    if (existing) {
      if (existing.connected && existing.ws && existing.ws.readyState === 1) {
        this.send(ws, { type: 'error', message: `${name} is already in the room` });
        return null;
      }
      existing.connected = true;
      existing.ws = ws;
      this.sockets.set(ws, name);
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
      ws,
    };
    this.players.set(name, player);
    this.sockets.set(ws, name);
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

    this.players.delete(player.name);
    player.name = newName;
    this.players.set(newName, player);

    for (const [s, n] of this.sockets) {
      if (n === player.name) {
        this.sockets.set(s, newName);
        break;
      }
    }

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
      } else {
        this.settings[setting] = value;
      }
      this.broadcastSettings();
    }
  }

  startRound(ws) {
    const player = this.getPlayerByWs(ws);
    if (!player || !player.isHost) return;
    if (this.activePlayers.length === 0) return;

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
    this.broadcast({ type: 'roundStart', round: this.currentRound });
    this.startQuestion();
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

    this.broadcast({
      type: 'questionEnd',
      correctAnswer,
      playerAnswers,
      scores: this.activePlayers.map(p => ({ name: p.name, score: p.score })),
    });
    this.broadcastPlayerList();

    setTimeout(() => {
      this.currentQuestionIndex++;
      if (this.currentQuestionIndex < this.questions.length) {
        this.startQuestion();
      } else {
        this.endRound();
      }
    }, 5000);
  }

  endRound() {
    this.state = 'ROUND_END';
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

  endGame(ws) {
    const player = this.getPlayerByWs(ws);
    if (!player || !player.isHost) return;

    this.clearTimers();
    this.state = 'GAME_END';
    const finalRankings = this.allConnected
      .map(p => ({ name: p.name, totalScore: p.totalScore }))
      .sort((a, b) => b.totalScore - a.totalScore);

    this.broadcast({
      type: 'gameEnd',
      finalRankings,
    });
    this.broadcastState();
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
    this.clearTimers();
    this.stopHostPing();
    for (const [ws] of this.sockets) {
      this.send(ws, { type: 'roomClosed', reason: 'Room has ended' });
      try { ws.close(); } catch {}
    }
    this.sockets.clear();
    this.players.clear();
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

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.json());

const rooms = new Map();

app.post('/api/rooms', async (req, res) => {
  let roomId = generateRoomId();
  while (rooms.has(roomId)) {
    roomId = generateRoomId();
  }
  const room = new Room(roomId);
  rooms.set(roomId, room);
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

server.listen(PORT, () => {
  console.log(`Geo Challenge server running at http://${detectLocalIP()}:${PORT}`);
});
