'use strict';

/**
 * Tests for server/db.js
 * Run with: node test-db.js
 */

const { openDatabase, saveRoom, savePlayers, savePlayer, deleteRoom, loadAllRooms, loadPlayersForRoom, cleanupOldRooms } = require('./server/db');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  PASS: ${message}`);
    passed++;
  } else {
    console.error(`  FAIL: ${message}`);
    failed++;
  }
}

function assertThrows(fn, message) {
  try {
    fn();
    console.error(`  FAIL: ${message} (expected throw, got none)`);
    failed++;
  } catch (e) {
    console.log(`  PASS: ${message}`);
    passed++;
  }
}

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

// -------------------------
// Test: openDatabase
// -------------------------
console.log('\n--- openDatabase ---');
let db;
try {
  db = openDatabase(':memory:');
  assert(db !== null && db !== undefined, 'openDatabase returns a handle');
} catch (e) {
  console.error('FATAL: openDatabase threw:', e.message);
  process.exit(1);
}

// Verify tables exist by querying sqlite_master
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
const tableNames = tables.map(t => t.name);
assert(tableNames.includes('rooms'), 'rooms table created');
assert(tableNames.includes('players'), 'players table created');

// Verify indexes
const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name").all();
const indexNames = indexes.map(i => i.name);
assert(indexNames.includes('idx_players_room'), 'idx_players_room index created');
assert(indexNames.includes('idx_rooms_activity'), 'idx_rooms_activity index created');

// Verify WAL mode is requested (in-memory DBs silently use 'memory' instead of 'wal',
// so we just confirm the pragma was set without error; file DBs will use WAL).
const journalMode = db.prepare('PRAGMA journal_mode').get();
assert(
  journalMode.journal_mode === 'wal' || journalMode.journal_mode === 'memory',
  'WAL mode set (wal for file DB, memory for :memory: DB)'
);

// Verify foreign keys
const fkPragma = db.prepare('PRAGMA foreign_keys').get();
assert(fkPragma.foreign_keys === 1, 'Foreign keys enabled');

// -------------------------
// Test: saveRoom + loadAllRooms
// -------------------------
console.log('\n--- saveRoom + loadAllRooms ---');
const room1 = makeRoom({ roomId: 'ROOM01', state: 'LOBBY', lastActivity: 1000 });
saveRoom(db, room1);

let rows = loadAllRooms(db);
assert(rows.length === 1, 'loadAllRooms returns 1 row after insert');

const row = rows[0];
assert(row.room_id === 'ROOM01', 'room_id stored correctly');
assert(row.state === 'LOBBY', 'state stored correctly');
assert(row.current_round === 0, 'current_round stored correctly');
assert(row.current_question_index === 0, 'current_question_index stored correctly');
assert(row.last_activity === 1000, 'last_activity stored correctly');

// settings should be JSON-encoded object
const parsedSettings = JSON.parse(row.settings);
assert(parsedSettings.mode === 'highlight', 'settings.mode round-trips correctly');

// questions JSON
const parsedQuestions = JSON.parse(row.questions);
assert(Array.isArray(parsedQuestions), 'questions is a JSON array');

// challengeTarget null
assert(row.challenge_target === null, 'challenge_target is null when not set');

// Save room with challengeTarget and questions
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
saveRoom(db, room2);

rows = loadAllRooms(db);
assert(rows.length === 2, 'loadAllRooms returns 2 rows');

const row2 = rows.find(r => r.room_id === 'ROOM02');
assert(row2 !== undefined, 'ROOM02 row found');
assert(row2.state === 'QUESTION', 'ROOM02 state correct');
assert(row2.current_round === 2, 'current_round=2');
assert(row2.current_question_index === 3, 'current_question_index=3');
assert(row2.question_start_time === 99999, 'question_start_time correct');

const parsedTarget = JSON.parse(row2.challenge_target);
assert(parsedTarget.name === 'Germany', 'challengeTarget.name round-trips');

const parsedQ = JSON.parse(row2.questions);
assert(parsedQ.length === 2, 'questions array length=2');

// Replace (upsert): save room1 again with modified state
saveRoom(db, { ...room1, state: 'FINISHED' });
rows = loadAllRooms(db);
const updatedRow1 = rows.find(r => r.room_id === 'ROOM01');
assert(updatedRow1.state === 'FINISHED', 'saveRoom upserts (replaces) existing room');

// -------------------------
// Test: savePlayers + loadPlayersForRoom
// -------------------------
console.log('\n--- savePlayers + loadPlayersForRoom ---');
const alice = makePlayer({ name: 'Alice', isHost: true, score: 5, totalScore: 15, pin: { lat: 48.8, lng: 2.3 }, pinLocked: true });
const bob = makePlayer({ name: 'Bob', isHost: false, score: 2, totalScore: 7, answer: 'France', answeredAt: 12345 });

const roomWithPlayers = makeRoom({ roomId: 'ROOM01', players: new Map([['Alice', alice], ['Bob', bob]]) });
savePlayers(db, roomWithPlayers);

let playerRows = loadPlayersForRoom(db, 'ROOM01');
assert(playerRows.length === 2, 'loadPlayersForRoom returns 2 players');

const aliceRow = playerRows.find(p => p.name === 'Alice');
assert(aliceRow !== undefined, 'Alice row found');
assert(aliceRow.is_host === 1, 'is_host=1 for Alice');
assert(aliceRow.score === 5, 'score=5');
assert(aliceRow.total_score === 15, 'total_score=15');
assert(aliceRow.pin_lat === 48.8, 'pin_lat stored');
assert(aliceRow.pin_lng === 2.3, 'pin_lng stored');
assert(aliceRow.pin_locked === 1, 'pin_locked=1');

const bobRow = playerRows.find(p => p.name === 'Bob');
assert(bobRow !== undefined, 'Bob row found');
assert(bobRow.is_host === 0, 'is_host=0 for Bob');
assert(bobRow.answer === 'France', 'answer stored');
assert(bobRow.answered_at === 12345, 'answered_at stored');
assert(bobRow.pin_lat === null, 'pin_lat null when no pin');
assert(bobRow.pin_lng === null, 'pin_lng null when no pin');

// savePlayers replaces all players transactionally
const carol = makePlayer({ name: 'Carol', isHost: true });
savePlayers(db, { ...roomWithPlayers, players: new Map([['Carol', carol]]) });
playerRows = loadPlayersForRoom(db, 'ROOM01');
assert(playerRows.length === 1, 'savePlayers replaced all players');
assert(playerRows[0].name === 'Carol', 'only Carol remains');

// loadPlayersForRoom returns empty for room with no players
const emptyRoom = makeRoom({ roomId: 'ROOM02' });
savePlayers(db, emptyRoom);
playerRows = loadPlayersForRoom(db, 'ROOM02');
assert(playerRows.length === 0, 'loadPlayersForRoom returns [] for empty players');

// -------------------------
// Test: savePlayer (single upsert)
// -------------------------
console.log('\n--- savePlayer ---');
const dave = makePlayer({ name: 'Dave', score: 0, totalScore: 0 });
savePlayer(db, 'ROOM01', dave);
playerRows = loadPlayersForRoom(db, 'ROOM01');
const daveRow = playerRows.find(p => p.name === 'Dave');
assert(daveRow !== undefined, 'Dave inserted via savePlayer');
assert(daveRow.score === 0, 'Dave score=0');

// Update Dave's score
savePlayer(db, 'ROOM01', { ...dave, score: 10, totalScore: 20 });
playerRows = loadPlayersForRoom(db, 'ROOM01');
const daveUpdated = playerRows.find(p => p.name === 'Dave');
assert(daveUpdated.score === 10, 'savePlayer upserts score');
assert(daveUpdated.total_score === 20, 'savePlayer upserts total_score');

// -------------------------
// Test: deleteRoom (cascade)
// -------------------------
console.log('\n--- deleteRoom ---');
// Ensure ROOM01 has players
playerRows = loadPlayersForRoom(db, 'ROOM01');
assert(playerRows.length > 0, 'ROOM01 has players before delete');

deleteRoom(db, 'ROOM01');

rows = loadAllRooms(db);
assert(!rows.find(r => r.room_id === 'ROOM01'), 'ROOM01 deleted from rooms');

// cascade: players for ROOM01 should be gone
playerRows = loadPlayersForRoom(db, 'ROOM01');
assert(playerRows.length === 0, 'players cascade-deleted when room is deleted');

// -------------------------
// Test: cleanupOldRooms
// -------------------------
console.log('\n--- cleanupOldRooms ---');
saveRoom(db, makeRoom({ roomId: 'OLD1', lastActivity: 100 }));
saveRoom(db, makeRoom({ roomId: 'OLD2', lastActivity: 200 }));
saveRoom(db, makeRoom({ roomId: 'NEW1', lastActivity: 9999 }));

cleanupOldRooms(db, 300);

rows = loadAllRooms(db);
const roomIds = rows.map(r => r.room_id);
assert(!roomIds.includes('OLD1'), 'OLD1 cleaned up');
assert(!roomIds.includes('OLD2'), 'OLD2 cleaned up');
assert(roomIds.includes('NEW1'), 'NEW1 kept');
// ROOM02 has lastActivity=2000, also kept
assert(roomIds.includes('ROOM02'), 'ROOM02 kept');

// -------------------------
// Summary
// -------------------------
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
