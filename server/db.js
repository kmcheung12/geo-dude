/**
 * server/db.js — SQLite persistence for geo-challenge rooms and players.
 *
 * All methods are synchronous (better-sqlite3 is sync).
 * Usage:
 *   const db = require('./db').openDatabase(path);
 *   db.saveRoom(room);
 *   db.savePlayers(room);
 *   db.savePlayer(roomId, player);
 *   db.deleteRoom(roomId);
 *   db.loadAllRooms();
 *   db.loadPlayersForRoom(roomId);
 *   db.cleanupOldRooms(cutoffMs);
 *
 * openDatabase opens (or creates) the database, enables WAL mode and foreign
 * keys, creates tables/indexes if missing, compiles all prepared statements
 * once, and returns a thin wrapper object that closes over those statements.
 */

import Database from 'better-sqlite3';

/**
 * Open (or create) the SQLite database at dbPath.
 * Enables WAL mode and foreign keys, creates tables and indexes if missing.
 * Compiles all prepared statements once and returns a wrapper object with
 * helper methods that close over them.
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

  // Compile all statements once
  const stmts = {
    insertRoom: db.prepare(`
      INSERT OR REPLACE INTO rooms
        (room_id, state, settings, current_round, current_question_index,
         questions, question_start_time, challenge_target, last_activity, created_at)
      VALUES
        (@room_id, @state, @settings, @current_round, @current_question_index,
         @questions, @question_start_time, @challenge_target, @last_activity, @created_at)
    `),
    deletePlayers: db.prepare('DELETE FROM players WHERE room_id = ?'),
    insertPlayer: db.prepare(`
      INSERT OR REPLACE INTO players
        (room_id, name, is_host, score, total_score, spectator,
         answer, answered_at, pin_lat, pin_lng, pin_locked)
      VALUES
        (@room_id, @name, @is_host, @score, @total_score, @spectator,
         @answer, @answered_at, @pin_lat, @pin_lng, @pin_locked)
    `),
    deleteRoom: db.prepare('DELETE FROM rooms WHERE room_id = ?'),
    selectAllRooms: db.prepare('SELECT * FROM rooms'),
    selectPlayersByRoom: db.prepare('SELECT * FROM players WHERE room_id = ?'),
    deleteOldRooms: db.prepare('DELETE FROM rooms WHERE last_activity < ?'),
  };

  // Build the savePlayers transaction once
  const savePlayersTx = db.transaction((roomId, players) => {
    stmts.deletePlayers.run(roomId);
    for (const player of players) {
      stmts.insertPlayer.run(playerToRow(roomId, player));
    }
  });

  return {
    /**
     * The underlying better-sqlite3 handle, exposed for tests that need to
     * run raw queries (e.g. PRAGMA checks, sqlite_master queries).
     */
    prepare: db.prepare.bind(db),
    pragma: db.pragma.bind(db),

    /**
     * INSERT OR REPLACE a room row.
     * Accepts a Room instance or plain object.
     * Uses room.createdAt if present; otherwise defaults to Date.now().
     * Does NOT issue a SELECT to find the previous created_at — callers are
     * expected to carry createdAt on the room object across calls.
     */
    saveRoom(room) {
      const roomId = room.roomId || room.room_id;
      const createdAt = room.createdAt ?? Date.now();

      stmts.insertRoom.run({
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
    },

    /**
     * In one transaction: delete all players for room, then insert all from room.players Map.
     */
    savePlayers(room) {
      const roomId = room.roomId || room.room_id;
      savePlayersTx(roomId, room.players.values());
    },

    /**
     * INSERT OR REPLACE a single player row.
     */
    savePlayer(roomId, player) {
      const row = playerToRow(roomId, player);
      const roomExists = db.prepare('SELECT 1 FROM rooms WHERE room_id = ?').get(roomId);
      if (!roomExists) {
        console.error('[db] savePlayer FK violation: room_id=%s does not exist in rooms table. player=%s', roomId, player.name);
      }
      try {
        stmts.insertPlayer.run(row);
      } catch (err) {
        console.error('[db] savePlayer failed: room_id=%s player=%s row=%j error=%s', roomId, player.name, row, err.message);
        throw err;
      }
    },

    /**
     * DELETE a room (cascades to players via FK ON DELETE CASCADE).
     */
    deleteRoom(roomId) {
      stmts.deleteRoom.run(roomId);
    },

    /**
     * SELECT all rooms. Returns array of plain row objects.
     */
    loadAllRooms() {
      return stmts.selectAllRooms.all();
    },

    /**
     * SELECT all players for a room. Returns array of plain row objects.
     */
    loadPlayersForRoom(roomId) {
      return stmts.selectPlayersByRoom.all(roomId);
    },

    /**
     * DELETE rooms with last_activity < cutoffMs.
     */
    cleanupOldRooms(cutoffMs) {
      stmts.deleteOldRooms.run(cutoffMs);
    },
  };
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

export { openDatabase };
