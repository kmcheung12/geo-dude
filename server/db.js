'use strict';

/**
 * server/db.js — SQLite persistence for geo-challenge rooms and players.
 *
 * All exported functions are synchronous (better-sqlite3 is sync).
 * Usage:
 *   const db = require('./db').openDatabase(path);
 *   saveRoom(db, room);
 *   savePlayers(db, room);
 *   ...
 */

const Database = require('better-sqlite3');

/**
 * Open (or create) the SQLite database at dbPath.
 * Enables WAL mode and foreign keys, creates tables and indexes if missing.
 * Returns the better-sqlite3 Database handle.
 */
function openDatabase(dbPath) {
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      room_id                TEXT PRIMARY KEY,
      state                  TEXT NOT NULL,
      settings               TEXT NOT NULL,
      current_round          INTEGER NOT NULL DEFAULT 0,
      current_question_index INTEGER NOT NULL DEFAULT 0,
      questions              TEXT NOT NULL DEFAULT '[]',
      question_start_time    INTEGER NOT NULL DEFAULT 0,
      challenge_target       TEXT,
      last_activity          INTEGER NOT NULL,
      created_at             INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS players (
      room_id     TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      is_host     INTEGER NOT NULL DEFAULT 0,
      score       INTEGER NOT NULL DEFAULT 0,
      total_score INTEGER NOT NULL DEFAULT 0,
      spectator   INTEGER NOT NULL DEFAULT 0,
      answer      TEXT,
      answered_at INTEGER,
      pin_lat     REAL,
      pin_lng     REAL,
      pin_locked  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (room_id, name)
    );

    CREATE INDEX IF NOT EXISTS idx_players_room ON players(room_id);
    CREATE INDEX IF NOT EXISTS idx_rooms_activity ON rooms(last_activity);
  `);

  return db;
}

/**
 * INSERT OR REPLACE a room row.
 * Accepts a Room instance (or plain object with same shape).
 */
function saveRoom(db, room) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO rooms
      (room_id, state, settings, current_round, current_question_index,
       questions, question_start_time, challenge_target, last_activity, created_at)
    VALUES
      (@room_id, @state, @settings, @current_round, @current_question_index,
       @questions, @question_start_time, @challenge_target, @last_activity, @created_at)
  `);

  // Support both room.roomId (Room class) and room.room_id (plain row)
  const roomId = room.roomId || room.room_id;

  // Read existing created_at so we don't overwrite it on updates
  const existing = db.prepare('SELECT created_at FROM rooms WHERE room_id = ?').get(roomId);
  const createdAt = existing ? existing.created_at : (room.lastActivity || Date.now());

  stmt.run({
    room_id: roomId,
    state: room.state,
    settings: JSON.stringify(room.settings),
    current_round: room.currentRound ?? 0,
    current_question_index: room.currentQuestionIndex ?? 0,
    questions: JSON.stringify(room.questions ?? []),
    question_start_time: room.questionStartTime ?? 0,
    challenge_target: room.challengeTarget != null ? JSON.stringify(room.challengeTarget) : null,
    last_activity: room.lastActivity,
    created_at: createdAt,
  });
}

/**
 * In one transaction: delete all players for room, then insert all from room.players Map.
 */
function savePlayers(db, room) {
  const roomId = room.roomId || room.room_id;

  const del = db.prepare('DELETE FROM players WHERE room_id = ?');
  const ins = db.prepare(`
    INSERT INTO players
      (room_id, name, is_host, score, total_score, spectator,
       answer, answered_at, pin_lat, pin_lng, pin_locked)
    VALUES
      (@room_id, @name, @is_host, @score, @total_score, @spectator,
       @answer, @answered_at, @pin_lat, @pin_lng, @pin_locked)
  `);

  const tx = db.transaction(() => {
    del.run(roomId);
    for (const player of room.players.values()) {
      ins.run(playerToRow(roomId, player));
    }
  });

  tx();
}

/**
 * INSERT OR REPLACE a single player row.
 */
function savePlayer(db, roomId, player) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO players
      (room_id, name, is_host, score, total_score, spectator,
       answer, answered_at, pin_lat, pin_lng, pin_locked)
    VALUES
      (@room_id, @name, @is_host, @score, @total_score, @spectator,
       @answer, @answered_at, @pin_lat, @pin_lng, @pin_locked)
  `);
  stmt.run(playerToRow(roomId, player));
}

/**
 * DELETE a room (cascades to players via FK ON DELETE CASCADE).
 */
function deleteRoom(db, roomId) {
  db.prepare('DELETE FROM rooms WHERE room_id = ?').run(roomId);
}

/**
 * SELECT all rooms. Returns array of plain row objects.
 */
function loadAllRooms(db) {
  return db.prepare('SELECT * FROM rooms').all();
}

/**
 * SELECT all players for a room. Returns array of plain row objects.
 */
function loadPlayersForRoom(db, roomId) {
  return db.prepare('SELECT * FROM players WHERE room_id = ?').all(roomId);
}

/**
 * DELETE rooms with last_activity < cutoffMs.
 */
function cleanupOldRooms(db, cutoffMs) {
  db.prepare('DELETE FROM rooms WHERE last_activity < ?').run(cutoffMs);
}

// ------------------------------------------------------------------
// Internal helpers
// ------------------------------------------------------------------

function playerToRow(roomId, player) {
  return {
    room_id: roomId,
    name: player.name,
    is_host: player.isHost ? 1 : 0,
    score: player.score ?? 0,
    total_score: player.totalScore ?? 0,
    spectator: player.spectator ? 1 : 0,
    answer: player.answer ?? null,
    answered_at: player.answeredAt ?? null,
    pin_lat: player.pin ? player.pin.lat : null,
    pin_lng: player.pin ? player.pin.lng : null,
    pin_locked: player.pinLocked ? 1 : 0,
  };
}

module.exports = {
  openDatabase,
  saveRoom,
  savePlayers,
  savePlayer,
  deleteRoom,
  loadAllRooms,
  loadPlayersForRoom,
  cleanupOldRooms,
};
