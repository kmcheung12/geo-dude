/**
 * Unit tests for proximity mode distance and scoring utilities.
 * Run with: node test-proximity-server.js  (server does NOT need to be running)
 */
'use strict';

const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
let passed = 0, failed = 0;

function assert(label, condition) {
  if (condition) { console.log(`  ${PASS} ${label}`); passed++; }
  else           { console.log(`  ${FAIL} ${label}`); failed++; }
}

function approx(a, b, tolerance = 1) {
  return Math.abs(a - b) <= tolerance;
}

// ---- copy implementations here for isolated testing ----
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// Simplified computeDistance for unit-testing without d3-geo.
// Full version (with geoContains) lives in server/index.js.
function computeDistanceMicro(pin, target) {
  // target is micro-country (point)
  const [tLng, tLat] = target.coordinates;
  const dist = haversineKm(pin.lat, pin.lng, tLat, tLng);
  return dist <= 100 ? 0 : dist;
}

function rankGuesses(results, N) {
  // results: [{ name, distance }]  distance=null means no pin
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

// ---- tests ----

console.log('\n[Test 1] haversineKm — known distances');
// London (51.5, -0.12) to Paris (48.85, 2.35) ≈ 342 km
assert('London→Paris ≈ 342 km', approx(haversineKm(51.5, -0.12, 48.85, 2.35), 342, 5));
// Same point → 0
assert('Same point → 0 km', haversineKm(0, 0, 0, 0) === 0);
// Antipodal points → ~20015 km
assert('Antipodal ≈ 20015 km', approx(haversineKm(0, 0, 0, 180), 20015, 5));

console.log('\n[Test 2] computeDistanceMicro — 100 km threshold');
// Monaco is at approx [7.4, 43.73]. Pin 50 km away → distance 0
const monacoTarget = { isMicro: true, coordinates: [7.4, 43.73] };
const pinNearMonaco = { lat: 44.17, lng: 7.4 }; // ~49 km north
assert('Pin within 100 km of micro-country → 0', computeDistanceMicro(pinNearMonaco, monacoTarget) === 0);
// Pin 200 km away → actual distance
const pinFarFromMonaco = { lat: 45.5, lng: 7.4 }; // ~197 km north
const farDist = computeDistanceMicro(pinFarFromMonaco, monacoTarget);
assert('Pin >100 km from micro-country → raw distance', farDist > 100);
assert('Pin >100 km — distance is reasonable (150–250 km)', approx(farDist, 197, 20));

console.log('\n[Test 3] rankGuesses — rank-based points');
// 3 active players, 3 results
const results3 = [
  { name: 'Alice', distance: 500 },
  { name: 'Bob',   distance: 100 },
  { name: 'Carol', distance: null }, // no pin
];
const ranked3 = rankGuesses(results3, 3);
const pts = name => ranked3.find(r => r.name === name).points;
assert('Closest (Bob, 100km) gets N=3 pts', pts('Bob') === 3);
assert('Second (Alice, 500km) gets 2 pts', pts('Alice') === 2);
assert('No pin (Carol) gets 0 pts', pts('Carol') === 0);

console.log('\n[Test 4] rankGuesses — tie handling');
const resultsTie = [
  { name: 'Alice', distance: 0 },
  { name: 'Bob',   distance: 0 },
  { name: 'Carol', distance: 300 },
];
const rankedTie = rankGuesses(resultsTie, 3);
const ptsT = name => rankedTie.find(r => r.name === name).points;
// Ties: Alice and Bob both rank 1st.
// Tied players share the higher rank and both receive the same points.
assert('Both tied players score higher than third', ptsT('Alice') > ptsT('Carol') && ptsT('Bob') > ptsT('Carol'));
assert('Tied players receive equal points', ptsT('Alice') === ptsT('Bob'));
assert('Tied players both get N=3 (top rank points)', ptsT('Alice') === 3 && ptsT('Bob') === 3);

console.log(`\n=== Unit test results: ${passed} passed, ${failed} failed ===`);
if (!process.argv.includes('--integration')) {
  process.exit(failed > 0 ? 1 : 0);
}

// ---- Integration tests (require server running on localhost:3000) ----
// Run with: node test-proximity-server.js --integration

(async () => {
  const WebSocket = require('ws');
  const BASE = 'http://localhost:3000';

  async function post(path) {
    const res = await fetch(`${BASE}${path}`, { method: 'POST' });
    return res.json();
  }

  function openWs() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket('ws://localhost:3000');
      const received = [];
      ws.on('message', d => received.push(JSON.parse(d)));
      ws.on('open', () => resolve({ ws, received }));
      ws.on('error', reject);
    });
  }

  function waitForType(received, type, ms = 3000) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + ms;
      const iv = setInterval(() => {
        const msg = received.find(m => m.type === type);
        if (msg) { clearInterval(iv); resolve(msg); }
        else if (Date.now() > deadline) { clearInterval(iv); reject(new Error(`timeout: ${type}`)); }
      }, 30);
    });
  }

  function sendWs(ws, msg) {
    ws.send(JSON.stringify(msg));
    return new Promise(r => setTimeout(r, 80));
  }

  async function joinRoom(roomId, name) {
    const conn = await openWs();
    await sendWs(conn.ws, { type: 'join', name, roomId });
    await waitForType(conn.received, 'joined');
    conn.received.length = 0;
    return conn;
  }

  console.log('\n[Integration] Proximity mode game flow');
  let intPassed = 0, intFailed = 0;

  function iassert(label, condition) {
    if (condition) { console.log(`  ${'\x1b[32mPASS\x1b[0m'} ${label}`); intPassed++; }
    else           { console.log(`  ${'\x1b[31mFAIL\x1b[0m'} ${label}`); intFailed++; }
  }

  try {
    const { roomId } = await post('/api/rooms');
    const host  = await joinRoom(roomId, 'Host');
    const guest = await joinRoom(roomId, 'Guest');

    // Set mode to proximity with 3 guesses, 1 challenge, 60s timer
    await sendWs(host.ws, { type: 'updateSettings', setting: 'mode', value: 'proximity' });
    await sendWs(host.ws, { type: 'updateSettings', setting: 'guessesPerChallenge', value: '3' });
    await sendWs(host.ws, { type: 'updateSettings', setting: 'challengesPerGame', value: '1' });
    await sendWs(host.ws, { type: 'updateSettings', setting: 'timerPerGuess', value: '60' });

    // Start round
    await sendWs(host.ws, { type: 'startRound' });
    const q = await waitForType(host.received, 'question', 3000);
    iassert('question received with mode=proximity', q.mode === 'proximity');
    iassert('question has no targetName (hidden)', q.targetName === undefined);
    iassert('question has totalQuestions=3', q.totalQuestions === 3);

    host.received.length = 0;
    guest.received.length = 0;

    // Host places a pin — should broadcast to guest
    await sendWs(host.ws, { type: 'placePin', lat: 48.85, lng: 2.35 }); // Paris
    const pinMsg = await waitForType(guest.received, 'pinUpdate', 2000);
    iassert('pinUpdate broadcast to guest', pinMsg.name === 'Host');
    iassert('pinUpdate has correct coords', Math.abs(pinMsg.lat - 48.85) < 0.01);

    guest.received.length = 0;
    host.received.length = 0;

    // Host locks pin
    await sendWs(host.ws, { type: 'lockPin' });
    const lockMsg = await waitForType(guest.received, 'pinLocked', 2000);
    iassert('pinLocked broadcast to guest', lockMsg.name === 'Host');

    // Guest places and locks pin (triggers guessEnd since all locked)
    await sendWs(guest.ws, { type: 'placePin', lat: 51.5, lng: -0.12 }); // London
    host.received.length = 0;
    guest.received.length = 0;
    await sendWs(guest.ws, { type: 'lockPin' });

    const guessEnd = await waitForType(host.received, 'guessEnd', 3000);
    iassert('guessEnd received', guessEnd !== undefined);
    iassert('guessEnd has 2 player results', guessEnd.guesses.length === 2);
    iassert('guessEnd.exactHit is false (no one pinned the target exactly)', guessEnd.exactHit === false);

    const hostGuess = guessEnd.guesses.find(g => g.name === 'Host');
    iassert('Host guess has distance (number)', typeof hostGuess.distance === 'number');
    iassert('Host guess has points >= 0', hostGuess.points >= 0);

    host.ws.close();
    guest.ws.close();
    await new Promise(r => setTimeout(r, 200));

    console.log(`\n[Integration] Results: ${intPassed} passed, ${intFailed} failed`);
    console.log(`\n=== Total: ${passed + intPassed} passed, ${failed + intFailed} failed ===`);
    process.exit((failed + intFailed) > 0 ? 1 : 0);
  } catch (err) {
    console.error('\n[Integration] Error:', err.message);
    process.exit(1);
  }
})();
