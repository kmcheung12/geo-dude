# Proximity Mode — "Guess the Country" Design Spec

**Date:** 2026-04-22
**Status:** Approved

---

## Overview

A third game mode (`mode: 'proximity'`) where the server picks a hidden target country and players compete to locate it on the globe by placing a pin. Players have Y guesses per challenge and X challenges per game. After each guess, all players' pin positions and distances are revealed. The target is only revealed when the challenge ends.

The mode reuses the existing round/question state machine. Terminology mapping:

| Proximity mode | Existing code |
|---|---|
| Challenge (X total, fixed) | Round |
| Guess (Y per challenge) | Question |

---

## Globe Interaction Matrix

| Mode | Zoom | Rotate (drag) |
|---|---|---|
| Name the country (`highlight`) | ✓ | ✗ |
| Find a country (`select`) | ✓ | ✓ |
| Guess the country (`proximity`) | ✓ | ✓ |

On mobile, single-finger drag rotates; pinch zooms. In proximity mode a tap places a pin. Because mobile browsers fire a `click` event after `touchend`, `globe.js` suppresses post-drag clicks: the drag behavior tracks whether the pointer actually moved (`dragMoved`). If it did, any `click` fired within 400 ms of `dragend` is ignored, preventing a trailing tap from placing a pin after a rotation gesture.

---

## Settings

Two new settings, active only when `mode: 'proximity'`. Existing `questionsPerRound` and `listSize` do not apply and are hidden from the UI in this mode.

| Setting | Key | Range | Default |
|---|---|---|---|
| Guesses per Challenge | `guessesPerChallenge` | 3–10 | 5 |
| Challenges per Game | `challengesPerGame` | 3–10 | 5 |

`timerPerGuess` and `optionPool` (random / sameContinent) continue to apply unchanged.

The settings panel shows/hides relevant rows based on the selected mode — no page reload needed.

---

## Game Flow

```
LOBBY
  └── host clicks Start Round
QUESTION (guess phase)
  └── all locked OR timer expires → guessEnd broadcast → 5s reveal overlay
  └── if distance-0 hit → guessEnd + challengeEnd broadcast (challenge over)
  └── if guesses < Y and no distance-0 → next QUESTION
  └── if guesses == Y → challengeEnd broadcast
ROUND_END (challenge end)
  └── host clicks Next Challenge → next challenge (QUESTION)
  └── host clicks End Game → GAME_END
  └── if challenge == X → GAME_END automatically
GAME_END
  └── host clicks Play Again → LOBBY
```

Host manually advances between challenges (consistent with existing UX). After all X challenges complete, the game moves to GAME_END automatically.

---

## Server State

### New Room fields

```js
currentChallenge   // 1..challengesPerGame
currentGuess       // 1..guessesPerChallenge
challengeTarget    // { name, continent, isMicro, coordinates?, centroid: [lng, lat] }
```

Centroids for all polygon countries are precomputed at server startup using `d3.geoCentroid()` and stored alongside `GAME_COUNTRIES`.

### New Player fields (transient, reset each guess)

```js
pin: { lat, lng } | null   // current pin position; null if not placed
pinLocked: boolean          // true once player sends lockPin
```

---

## WebSocket Protocol

```
Client → Server
  placePin  { lat, lng }         Move or place pin. Client throttles to ~300ms.
                                  Ignored if player has already locked.
  lockPin                         Lock current pin. Ignored if no pin placed or already locked.

Server → Client
  pinUpdate  { name, lat, lng }  Broadcast on every placePin (all players including sender).
  pinLocked  { name }            Broadcast when a player locks in.
  guessEnd   { guesses: [{ name, lat, lng, distance, points }] }
                                  distance in km (0 = exact hit or within 100km for micro).
                                  points = rank-based. Emitted after every guess.
                                  Target NOT revealed here.
  challengeEnd { targetName, targetCoords: [lng, lat], rankings: [{ name, score, totalScore }] }
                                  Emitted after final guess or exact-hit guess, after guessEnd.
                                  Target revealed here.
```

On an exact-hit guess, the server emits `guessEnd` immediately followed by `challengeEnd` — the client shows the `guessEnd` overlay for 2s (not the standard 5s) then transitions directly to `challengeEnd` (target revealed, rankings). The client detects this by checking whether a `challengeEnd` message is queued immediately after `guessEnd`.

---

## Distance & Scoring

### Distance calculation (server-side, Haversine)

- **Polygon countries:** if pin is inside the polygon (`d3.geoContains(feature, [lng, lat])`) → distance = 0. Otherwise → Haversine distance from pin to country centroid.
- **Micro-countries (point geometry):** Haversine distance from pin to point coordinates. If ≤ 100km → distance = 0.

### Points per guess

Players ranked by distance ascending (0 = best). 1st place gets N pts, 2nd N−1, …, last 1 pt. No pin placed = 0 pts.

**Ties:** players with identical distance share the higher rank and both receive the same (higher) points value.

### Challenge score

- `score` accumulates rank-based points across guesses within the current challenge. Resets at the start of each challenge.
- `totalScore` accumulates across all challenges.

### Early termination (distance = 0)

- Triggered when any player's guess has distance = 0.
- Simultaneous hits (same guess, multiple players at distance 0): all receive N points.
- The exact-hitting player(s) have their **challenge score set to N**, overwriting all previously accumulated points for this challenge. This is their reward for solving it.
- All other players retain only their points from prior guesses of this challenge. They do not score for the terminating guess.
- Remaining guesses are cancelled.

---

## Client / UI

### Globe interactions

- **Click** anywhere → places or moves your pin (green marker with your initial). Ignored after lock.
- **Other players' pins** appear in real-time as colored dots with initials, updating as they move. Colors assigned per player index from a fixed palette (same source as player chips).
- **Lock In button** (below globe, disabled until pin placed) → locks position. Once locked, pin cannot be moved.
- Locked players show 🔒 on their pin marker and a ✓ tick on their player chip.

### Guess end overlay (5s, same pattern as existing questionEnd)

- Table: player name | location label | distance (km) | points earned this guess. Location label is computed client-side from the TopoJSON data already loaded in the globe (`d3.geoContains` check against all features; falls back to "Open Ocean" if no match).
- Globe visible behind overlay with all pins shown. Target not highlighted.
- Countdown ring, then next guess begins. Pins and locks reset for all players.

### Challenge end overlay (replaces guess end on final/exact-hit guess)

- Globe auto-rotates and highlights target country in blue.
- Rankings table: player name | challenge points | cumulative total.
- Host sees **Next Challenge** / **End Game** buttons. Guests see "Waiting for host…".
- If this was the last challenge (X), host only sees **End Game**.

### Settings panel

Mode selector triggers CSS show/hide of relevant setting rows:
- `highlight` / `select` → show `questionsPerRound`, `listSize`; hide `guessesPerChallenge`, `challengesPerGame`
- `proximity` → show `guessesPerChallenge`, `challengesPerGame`; hide `questionsPerRound`, `listSize`

---

## Resolved Edge Cases

| Scenario | Resolution |
|---|---|
| Player doesn't place pin before timer | 0 points for that guess |
| Two players hit distance-0 on same guess | Both get N pts; challenge ends |
| Player reconnects mid-guess | Pin state preserved on server; rejoin sees their pin still placed |
| Host ends game mid-challenge | Existing `endGame` handler; goes to GAME_END with current totalScores |
| Spectators | Same behaviour as existing modes — late joiners spectate until next challenge |
| `optionPool: sameContinent` | Applies to target country selection same as existing modes |
| All X challenges complete | GAME_END triggered automatically, no host decision needed |
