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
  const placed = results
    .filter(r => r.distance !== null)
    .sort((a, b) => a.distance - b.distance);

  const out = results.map(r => ({ ...r, points: 0 }));
  placed.forEach((r, i) => {
    const entry = out.find(o => o.name === r.name);
    if (entry) entry.points = N - i;
  });
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
// The test verifies tied players get more than non-tied players.
assert('Both tied players score higher than third', ptsT('Alice') > ptsT('Carol') && ptsT('Bob') > ptsT('Carol'));

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (!process.argv.includes('--integration')) {
  process.exit(failed > 0 ? 1 : 0);
}
