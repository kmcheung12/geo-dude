import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.js';

function makeRoom(overrides = {}) {
  return {
    roomId: 'ROOM01',
    state: 'LOBBY',
    settings: { mode: 'highlight', questionsPerRound: 10 },
    players: new Map(),
    currentRound: 0,
    currentQuestionIndex: 0,
    questions: [],
    questionStartTime: 0,
    challengeTarget: null,
    lastActivity: Date.now(),
    ...overrides,
  };
}

function makePlayer(overrides = {}) {
  return {
    name: 'Alice',
    isHost: true,
    score: 0,
    totalScore: 0,
    spectator: false,
    answer: null,
    answeredAt: null,
    pin: null,
    pinLocked: false,
    connected: true,
    ws: null,
    joinedAt: Date.now(),
    ...overrides,
  };
}

test('openDatabase — schema and pragmas', () => {
  const db = openDatabase(':memory:');

  const tableNames = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(t => t.name);
  assert.ok(tableNames.includes('rooms'), 'rooms table exists');
  assert.ok(tableNames.includes('players'), 'players table exists');

  const indexNames = db.prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name").all().map(i => i.name);
  assert.ok(indexNames.includes('idx_players_room'));
  assert.ok(indexNames.includes('idx_rooms_activity'));

  const jm = db.prepare('PRAGMA journal_mode').get().journal_mode;
  assert.ok(jm === 'wal' || jm === 'memory', `journal_mode=${jm}`);
  assert.strictEqual(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
});

test('saveRoom + loadAllRooms', () => {
  const db = openDatabase(':memory:');
  const room1 = makeRoom({ roomId: 'ROOM01', state: 'LOBBY', lastActivity: 1000 });
  db.saveRoom(room1);

  let rows = db.loadAllRooms();
  assert.strictEqual(rows.length, 1);
  const row = rows[0];
  assert.strictEqual(row.room_id, 'ROOM01');
  assert.strictEqual(row.state, 'LOBBY');
  assert.strictEqual(row.current_round, 0);
  assert.strictEqual(row.current_question_index, 0);
  assert.strictEqual(row.last_activity, 1000);
  assert.strictEqual(JSON.parse(row.settings).mode, 'highlight');
  assert.ok(Array.isArray(JSON.parse(row.questions)));
  assert.strictEqual(row.challenge_target, null);

  const room2 = makeRoom({
    roomId: 'ROOM02',
    state: 'QUESTION',
    questions: [{ name: 'France' }, { name: 'Spain' }],
    challengeTarget: { name: 'Germany', continent: 'EU' },
    currentRound: 2,
    currentQuestionIndex: 3,
    questionStartTime: 99999,
    lastActivity: 2000,
  });
  db.saveRoom(room2);

  rows = db.loadAllRooms();
  assert.strictEqual(rows.length, 2);
  const row2 = rows.find(r => r.room_id === 'ROOM02');
  assert.strictEqual(row2.state, 'QUESTION');
  assert.strictEqual(row2.current_round, 2);
  assert.strictEqual(row2.current_question_index, 3);
  assert.strictEqual(row2.question_start_time, 99999);
  assert.strictEqual(JSON.parse(row2.challenge_target).name, 'Germany');
  assert.strictEqual(JSON.parse(row2.questions).length, 2);

  // upsert
  db.saveRoom({ ...room1, state: 'FINISHED' });
  assert.strictEqual(db.loadAllRooms().find(r => r.room_id === 'ROOM01').state, 'FINISHED');
});

test('created_at preserved across saveRoom calls', () => {
  const db = openDatabase(':memory:');
  const fixedCreatedAt = 42000;
  const room = makeRoom({ roomId: 'ROOM01', lastActivity: 1000, createdAt: fixedCreatedAt });
  db.saveRoom(room);
  db.saveRoom({ ...room, state: 'FINISHED', lastActivity: 9999, createdAt: fixedCreatedAt });

  const row = db.loadAllRooms()[0];
  assert.strictEqual(row.created_at, fixedCreatedAt);
  assert.strictEqual(row.last_activity, 9999);
  assert.strictEqual(row.state, 'FINISHED');
});

test('savePlayers + loadPlayersForRoom', () => {
  const db = openDatabase(':memory:');
  db.saveRoom(makeRoom({ roomId: 'ROOM01' }));
  db.saveRoom(makeRoom({ roomId: 'ROOM02' }));

  const alice = makePlayer({ name: 'Alice', isHost: true, score: 5, totalScore: 15, pin: { lat: 48.8, lng: 2.3 }, pinLocked: true });
  const bob = makePlayer({ name: 'Bob', isHost: false, score: 2, totalScore: 7, answer: 'France', answeredAt: 12345 });
  db.savePlayers(makeRoom({ roomId: 'ROOM01', players: new Map([['Alice', alice], ['Bob', bob]]) }));

  let rows = db.loadPlayersForRoom('ROOM01');
  assert.strictEqual(rows.length, 2);

  const aliceRow = rows.find(p => p.name === 'Alice');
  assert.strictEqual(aliceRow.is_host, 1);
  assert.strictEqual(aliceRow.score, 5);
  assert.strictEqual(aliceRow.total_score, 15);
  assert.strictEqual(aliceRow.pin_lat, 48.8);
  assert.strictEqual(aliceRow.pin_lng, 2.3);
  assert.strictEqual(aliceRow.pin_locked, 1);

  const bobRow = rows.find(p => p.name === 'Bob');
  assert.strictEqual(bobRow.is_host, 0);
  assert.strictEqual(bobRow.answer, 'France');
  assert.strictEqual(bobRow.answered_at, 12345);
  assert.strictEqual(bobRow.pin_lat, null);
  assert.strictEqual(bobRow.pin_lng, null);

  // savePlayers replaces all players atomically
  const carol = makePlayer({ name: 'Carol', isHost: true });
  db.savePlayers(makeRoom({ roomId: 'ROOM01', players: new Map([['Carol', carol]]) }));
  rows = db.loadPlayersForRoom('ROOM01');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].name, 'Carol');

  // empty room
  db.savePlayers(makeRoom({ roomId: 'ROOM02' }));
  assert.strictEqual(db.loadPlayersForRoom('ROOM02').length, 0);
});

test('savePlayer — single upsert', () => {
  const db = openDatabase(':memory:');
  db.saveRoom(makeRoom({ roomId: 'ROOM01' }));

  const dave = makePlayer({ name: 'Dave', score: 0, totalScore: 0 });
  db.savePlayer('ROOM01', dave);
  assert.strictEqual(db.loadPlayersForRoom('ROOM01').find(p => p.name === 'Dave').score, 0);

  db.savePlayer('ROOM01', { ...dave, score: 10, totalScore: 20 });
  const updated = db.loadPlayersForRoom('ROOM01').find(p => p.name === 'Dave');
  assert.strictEqual(updated.score, 10);
  assert.strictEqual(updated.total_score, 20);
});

test('savePlayer — FK constraint throws for unknown room', () => {
  const db = openDatabase(':memory:');
  assert.throws(() => db.savePlayer('NONEXISTENT', makePlayer({ name: 'Ghost' })));
});

test('deleteRoom — cascades to players', () => {
  const db = openDatabase(':memory:');
  db.saveRoom(makeRoom({ roomId: 'ROOM01' }));
  const alice = makePlayer({ name: 'Alice' });
  db.savePlayers(makeRoom({ roomId: 'ROOM01', players: new Map([['Alice', alice]]) }));
  assert.ok(db.loadPlayersForRoom('ROOM01').length > 0);

  db.deleteRoom('ROOM01');
  assert.strictEqual(db.loadAllRooms().filter(r => r.room_id === 'ROOM01').length, 0);
  assert.strictEqual(db.loadPlayersForRoom('ROOM01').length, 0);
});

test('cleanupOldRooms — removes stale, keeps recent', () => {
  const db = openDatabase(':memory:');
  db.saveRoom(makeRoom({ roomId: 'OLD1', lastActivity: 100 }));
  db.saveRoom(makeRoom({ roomId: 'OLD2', lastActivity: 200 }));
  db.saveRoom(makeRoom({ roomId: 'NEW1', lastActivity: 9999 }));

  db.cleanupOldRooms(300);

  const ids = db.loadAllRooms().map(r => r.room_id);
  assert.ok(!ids.includes('OLD1'));
  assert.ok(!ids.includes('OLD2'));
  assert.ok(ids.includes('NEW1'));
});
