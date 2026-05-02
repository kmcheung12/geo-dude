import { test } from 'node:test';
import assert from 'node:assert/strict';

// Copied from server/index.js for isolated unit testing (no server required).

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

function computeDistanceMicro(pin, target) {
  const [tLng, tLat] = target.coordinates;
  const dist = haversineKm(pin.lat, pin.lng, tLat, tLng);
  return dist <= 100 ? 0 : dist;
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

test('haversineKm — known distances', () => {
  assert.ok(Math.abs(haversineKm(51.5, -0.12, 48.85, 2.35) - 342) <= 5, 'London→Paris ≈ 342 km');
  assert.strictEqual(haversineKm(0, 0, 0, 0), 0, 'same point → 0');
  assert.ok(Math.abs(haversineKm(0, 0, 0, 180) - 20015) <= 5, 'antipodal ≈ 20015 km');
});

test('computeDistanceMicro — 100 km threshold', () => {
  const monaco = { coordinates: [7.4, 43.73] };
  assert.strictEqual(computeDistanceMicro({ lat: 44.17, lng: 7.4 }, monaco), 0, 'within 100 km → 0');
  const d = computeDistanceMicro({ lat: 45.5, lng: 7.4 }, monaco);
  assert.ok(d > 100, '>100 km → raw distance');
  assert.ok(Math.abs(d - 197) <= 20, 'raw distance in expected range');
});

test('rankGuesses — rank-based points', () => {
  const ranked = rankGuesses([
    { name: 'Alice', distance: 500 },
    { name: 'Bob',   distance: 100 },
    { name: 'Carol', distance: null },
  ], 3);
  const pts = name => ranked.find(r => r.name === name).points;
  assert.strictEqual(pts('Bob'), 3, 'closest gets N pts');
  assert.strictEqual(pts('Alice'), 2, 'second gets N-1 pts');
  assert.strictEqual(pts('Carol'), 0, 'no pin → 0 pts');
});

test('rankGuesses — tie handling', () => {
  const ranked = rankGuesses([
    { name: 'Alice', distance: 0 },
    { name: 'Bob',   distance: 0 },
    { name: 'Carol', distance: 300 },
  ], 3);
  const pts = name => ranked.find(r => r.name === name).points;
  assert.strictEqual(pts('Alice'), 3, 'tied first → N pts');
  assert.strictEqual(pts('Bob'), 3, 'tied first → N pts');
  assert.ok(pts('Alice') > pts('Carol'), 'tied first beats third');
});
