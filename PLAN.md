# Geo Challenge — Implementation Plan

## Overview
A local-network multiplayer browser game where up to 16 players compete in geography challenges using an interactive D3.js globe. The server runs on a laptop; players join by scanning a QR code.

---

## 1. Architecture

### Stack
| Layer | Technology |
|-------|------------|
| Runtime | Node.js (v24+) |
| Web Server | Express (static files + API) |
| Real-time | WebSocket (`ws` library) |
| Globe Rendering | D3.js v7 (`d3-geo`, `topojson-client`) |
| Globe Data | Natural Earth 110m via `world-atlas@2` (~105KB TopoJSON) + 29 micro-country point markers |
| QR Code | Server-generated data URL (`qrcode` npm) |
| Styling | Vanilla CSS |
| Sound | Web Audio API (oscillators, no external files) |

### Project Structure
```
geo-challenge/
├── package.json
├── PLAN.md                    # This document
├── server/
│   ├── index.js               # HTTP + WS server, room manager, game loop
│   └── country-continents.json # Country→continent mapping
├── public/
│   ├── index.html             # Single-page app
│   ├── css/
│   │   └── style.css          # Layout, lobby, game screens, responsive
│   ├── js/
│   │   ├── app.js             # WS connection, routing, state sync, UI
│   │   └── globe.js           # D3 orthographic globe, highlighting, click handlers
│   └── data/
│       ├── countries-110m.json # Downloaded world-atlas TopoJSON
│       └── micro-countries.json # 29 micro-states too small for 110m polygons (Point GeoJSON)
```

---

## 2. Game Design Specification

### Game Modes (host picks one per game)
1. **Name the country** (`mode: 'highlight'`)
   - Globe shows a highlighted country (solid blue fill).
   - Players pick the correct name from a multiple-choice list.
   - Globe is **zoomable** (pinch/scroll) but **not rotatable** — the highlighted country stays centered.
2. **Find a country** (`mode: 'select'`)
   - A country name is displayed.
   - Players rotate/zoom the globe and click the correct country.
   - Globe is fully interactive (drag + zoom).
   - When a country is clicked, the Confirm button does **not** show the selected country name (to avoid spoiling/revealing the answer). Button reads "Confirm Selection".
   - At question end, the correct country is **highlighted on the globe** (blue fill + auto-centered) for 5 seconds. No text popup. Drag is disabled during the reveal.

### Host-Configurable Settings
| Setting | Options | Default |
|---------|---------|---------|
| Game Mode | `highlight` (Name the country), `select` (Find a country) | `highlight` |
| Questions per Round | 1–50 | 10 |
| Timer per Guess | 5s, 10s, 15s, 30s, 45s, 60s, `0` (no limit) | 30s |
| List Size | 3–10 | 4 |
| Question | `random`, `sameContinent` | `random` |
| Wrong Answer Penalty | 0 | 0 |

**Question pool behavior:**
- **`random`** — each round picks target countries and answer options from the full global list (~203 countries).
- **`sameContinent`** — the server picks one continent that has enough countries to fill the list size, then draws **both the target countries and all answer options** exclusively from that continent for the entire round.

### Round Structure
- A **Round** = N questions (guesses), configured by host as "Questions per Round".
- Questions are real-time race: all active players see the same question simultaneously.
- Answers are **lock-in on first click**.
- Next question starts immediately when **all active players have answered** OR the **timer expires**.
- After the configured number of questions: **Round End** → ranking is shown.
- The host then decides: **Start Next Round** or **Return to Lobby**.
- There is no pre-set number of rounds; play continues until the host ends the game.
- The host may also click **End Game** at any time during a round to force-end and return to the final rankings / lobby.

### Scoring (Rank-Based)
- For N active participants, correct answers are scored by arrival order at the server:
  - 1st correct: **N points**
  - 2nd correct: **N-1 points**
  - ...
  - Last correct: **1 point**
- Wrong guess or timeout: **0 points**
- This encourages speed and makes score relative to lobby size.

### Player Lifecycle
1. Player scans QR code → loads client page.
2. **QR code is visible on the join screen** so early arrivers can share it before entering.
3. Enters a **unique name** for the session (duplicates blocked with "X is already in the room").
4. Name is stored in `localStorage`; auto-reconnect sends the same name on refresh.
5. **First joined player** becomes Host.
6. Host configures settings and clicks **Start Round**.
7. Active players participate; late joiners become **Spectators** until the next round.
8. **Host health ping**: server pings the host every 10 s; 3 missed pongs = host declared dead and transferred to the next-joined connected player.
9. On host disconnect: host passes to the **next-joined player** (earliest `joinedAt`).
10. Reconnect: client sends `name`; server restores the disconnected player's record (preserving score, host status, etc.).
11. **Stale socket guard**: if a player refreshes, the old WebSocket's `close` event is ignored because the player already has a newer active socket.
12. **Name change**: any player (including host) can change their display name from the lobby, provided the new name isn't already taken by a connected player.
13. **Room hard reset**: when the last player leaves (or host times out with no successors), the server broadcasts `roomClosed`, closes all sockets, and instantiates a fresh `Room`. Rejoining starts at step 1.

---

## 3. Server Design

### Network Discovery
- Detect the IPv4 address of the network interface with the default gateway.
- Heuristic: first non-internal IPv4 from `os.networkInterfaces()`.
- Fallback: `127.0.0.1`.
- Override: `HOST` / `PORT` environment variables.
- QR code encodes: `http://<detected-ip>:<port>`.

### WebSocket Message Protocol
```
Client → Server
  join { name }                           (name is the identity; no UUID)
  updateSettings { setting, value }       (host only, sender identified by ws)
  startRound                              (host only, sender identified by ws)
  endGame                                 (host only, during round)
  returnToLobby                           (host only, at round end)
  changeName { name }                     (any player, sender identified by ws)
  answer { answer }                       (country name; sender identified by ws)
  pong                                    (reply to server ping)

Server → Client
  state { gameState, players, settings, me }
  question { index, mode, payload, timeLimit, timeRemaining }
  questionEnd { correctAnswer, playerAnswers, scores }
  roundEnd { rankings, roundNumber }
  gameEnd { finalRankings }
  playerAnswered { name }
  error { message }
  hostAssigned { hostName }
  ping                                    (host health check)
  roomClosed { reason }
```

### Game State Machine
```
LOBBY
  └── host clicks Start Round
PRE_ROUND
  └── generate N questions, reset round scores
QUESTION
  └── all answered OR timer expires
QUESTION_END
  └── wait 5s (reveal correct answer)
  └── if questions < N → QUESTION
  └── if questions == N → ROUND_END
ROUND_END
  └── host clicks Start Next Round → PRE_ROUND
  └── host clicks Return to Lobby → LOBBY (reset)
  └── host clicks End Game → GAME_END (show final podium)
GAME_END
  └── host clicks Play Again → LOBBY
```

### Data Models
**Player**
- `name`: string (primary identity key)
- `isHost`: boolean
- `joinedAt`: timestamp
- `connected`: boolean
- `score`: number (round score, reset each round)
- `totalScore`: number (cumulative)
- `spectator`: boolean
- `answer`: string | null (current question answer)
- `answeredAt`: timestamp | null
- `ws`: WebSocket reference (active socket, null when disconnected)

**Game Settings** (stored in room)
- `mode`, `questionsPerRound`, `timerPerGuess`, `listSize`, `optionPool`

**Room State**
- `state`: enum
- `settings`: object
- `players`: Map<name, Player>
- `sockets`: Map<ws, name>
- `currentRound`: number
- `currentQuestionIndex`: number
- `questions`: Array<Question>
- `questionStartTime`: timestamp
- `questionTimer`: NodeJS.Timeout | null
- `pingInterval`: NodeJS.Timeout | null (host health check)
- `pingMisses`: number
- `awaitingPong`: boolean

**Question**
- `targetCountry`: { id, name, continent, isMicro?, coordinates? }
- `options`: string[] (mode 1 only, shuffled)
- `mode`: 'highlight' | 'select'

---

## 4. Client Design

### Screens
1. **Join Screen**
   - QR code image displayed at the top of the join card so the first (hosting) player can immediately share the room link while waiting for others.
   - Name input + Join button.
   - Status text below button shows connection state ("Connecting...", "Connected", "Reconnecting...").
   - If the user clicks Join before the WebSocket is open, the message is queued and sent automatically once connected.
   - If `localStorage` has a previous `geoName`, pre-fill name and auto-reconnect on open.
   - Duplicate-name errors (e.g. "Alice is already in the room") shown inline.
   - `roomClosed` returns the user to this screen with a message explaining the room ended.

2. **Lobby Screen** (host sees extra controls)
   - **Name change row**: input + "Change Name" button. Available to all players (host and guests). Blocked if target name is already taken by a connected player.
   - Player list with host badge.
   - Settings panel (visible to all, editable by host only).
   - QR code image (host only).
   - Start Round button (host only, enabled if ≥1 player).

3. **Game Screen**
   - Top bar: round number, question counter, timer countdown.
   - **Player chips** below header: one chip per active player showing name + score. When a player answers, a ✓ tick appears on their chip (visible to everyone).
   - Center: D3 globe (interactive or static depending on mode).
   - Bottom:
     - Name the country: grid of answer buttons.
     - Find a country: instruction text + "Confirm Selection" button (does not reveal selected country name).
   - Sidebar: live scoreboard (names + round scores).
   - **Host-only "End Game" button** visible during active questions. Non-hosts never see this button.

4. **Round End Screen**
   - Overlay showing ranked list for the round.
   - Host sees two buttons: **Start Next Round** and **Return to Lobby**.
   - Guests see a "Waiting for host..." message.

5. **Game End Screen**
   - Podium / final rankings (cumulative total scores).
   - "Play Again" button (host only → soft-resets to Lobby, preserving players and settings).
   - If the room is hard-reset (all players left / host timed out with no successors), all clients are kicked to the Join Screen via `roomClosed` instead.

### Globe Implementation (D3.js)
- **Projection**: `d3.geoOrthographic()` with `clipAngle(90)`.
- **Rotation**: `d3.geoRotation()` — animated with `d3.transition` for auto-centering.
- **Zoom**: `d3.zoom` enabled in both modes (pinch-to-zoom on mobile, scroll on desktop). Small countries are hard to see on mobile without zoom.
- **Drag/Rotate**: `d3.drag` enabled only in `select` mode (Find a country). In `highlight` mode (Name the country), drag is disabled so the highlighted country stays centered.
- **Highlighting**: apply a distinct CSS fill class to the target country's `<path>` or `<circle>`.
- **Click detection**: In `select` mode, polygon countries are detected with `d3.geoContains()`. Micro-countries (29 small island states / city-states rendered as circles) are detected by projected proximity (12 px threshold).
- **Data loading**: fetch `/data/countries-110m.json` (polygons) and `/data/micro-countries.json` (point markers), parse with `topojson.feature()`.

### Responsive Behavior
- Minimum supported: 360×640 (mobile landscape/portrait).
- Globe SVG scales to container width.
- Answer buttons stack vertically on narrow screens.
- Mobile touch-highlight fix: `-webkit-tap-highlight-color: transparent` and `touch-action: manipulation` on answer buttons, plus `document.activeElement.blur()` before rendering each question to prevent persistent `:active` states.

---

## 5. Task Breakdown & Implementation Order

### Phase 1: Foundation
1. **Initialize Node project**
   - Create `package.json`.
   - Install: `express`, `ws`, `qrcode`, `topojson-client`, `countries-list`.
   - Add npm scripts: `start`, `dev`.

2. **Fetch globe data**
   - Download `countries-110m.json` from `world-atlas` CDN to `public/data/`.
   - Verify parsing with a quick Node script.

3. **Static server & WS scaffold**
   - Express serving `public/`.
   - `ws` server attached to HTTP server.
   - Basic ping/pong and connection logging.

### Phase 2: Server Game Engine
4. **Room & player management**
   - Join flow, **name-as-identity** (no UUID). Duplicate names blocked.
   - Host election (first joined, failover on disconnect).
   - Disconnect/reconnect with `localStorage` name.
   - **Stale socket guard**: `removePlayer` only disconnects if `player.ws === ws`.
   - Spectator logic (late joiners during active round).
   - **Name change** (`changeName` message handler), blocked on name collision.

5. **Settings & lobby state**
   - Host can update settings.
   - Broadcast state to all clients.
   - Validation (e.g., list size 3–10).

6. **Game loop & timer**
    - State machine transitions.
    - Question generation (random global pool or same-continent pool for both targets and options).
    - Timer logic: start, tick broadcast, timeout handling.
    - Answer collection & lock-in.
    - Rank-based scoring: sort correct answers by `answeredAt`, assign N, N-1, ... 1 points. Wrong = 0.
    - **5-second reveal pause** after each question.

7b. **Host health ping**
    - Server pings host every 10 s; expects `pong` reply.
    - 3 missed pongs = host declared dead → `assignHost()` to next connected player.
    - If no connected players remain, `destroy()` room and `resetRoom()` (hard reset).

7c. **Round / Game end logic**
    - Round ranking (sort by round score).
    - Reset scores each round.
    - Host decision: next round / return to lobby / end game.
    - No auto-advance.
    - **Hard reset** when last player leaves or host times out with no successors: broadcast `roomClosed`, close sockets, instantiate fresh `Room`.

### Phase 3: Client UI
8. **HTML/CSS shell**
    - Single-page structure with screen sections.
    - CSS variables for theming (dark mode default).

9. **Join screen**
    - QR code displayed so the first player can share the link immediately.
    - Connection status feedback.
    - Message queue for pre-connection clicks.
    - Duplicate-name error messages.
    - `roomClosed` handler returns to join screen.

10. **Lobby screen**
    - Join form with name input.
    - Name change row for all players.
    - Player list, host badge.
    - Settings form (enabled/disabled based on `isHost`).
    - QR code display (host).

11. **Globe module**
    - Load TopoJSON + micro-country GeoJSON, render orthographic globe.
    - Separate zoom and drag controls.
    - Highlight country helper (polygons and circles).
    - Click-to-select with feedback (polygon containment + circle proximity).

12. **Game screen**
    - Timer countdown display.
    - Player chips below header with real-time answer status (✓ when answered).
    - Name the country: render multiple-choice buttons from WS payload.
    - Find a country: render interactive globe, confirm lock-in (button does not show selected name).
    - **Find a country answer reveal**: highlight correct country on globe, no text popup.
    - Live scoreboard sidebar.
    - Host "End Game" button.

13. **Round / Game end screens**
    - Ranked list with medals/positions.
    - Host decision buttons (Start Next Round / Return to Lobby).

### Phase 4: Polish & Validation
14. **Integration testing**
    - Start server, open multiple browser tabs.
    - Verify join, host election, start game.
    - Verify mode 1 and mode 2 full flow.
    - Verify timer timeout.
    - Verify host disconnect failover.
    - Verify spectator → player promotion.
    - Verify name change broadcast.
    - Verify rank-based scoring.

15. **Edge cases & cleanup**
    - Handle browser refresh mid-question (reconnect by name).
    - Stale socket close race (player refreshes, old WS closes after new WS opens).
    - Host health ping failover (3 misses).
    - Empty room hard reset.
    - Graceful server shutdown.
    - Prevent double-answer exploits.
    - Clear all timers on state change to avoid leaks.
    - Mobile touch-highlight prevention.

---

## 6. Sound Effects Design
All sounds generated via Web Audio API (no external assets).

| Event | Sound Description |
|-------|-------------------|
| Countdown 5→1 | Short, crisp tick/beep (440 Hz, 50 ms). Pitch rises slightly on last second. |
| Correct answer | Pleasant ascending two-tone chime (523 Hz → 659 Hz, 150 ms each). |
| Wrong answer | Low descending buzz (300 Hz → 150 Hz, 300 ms, square wave). |
| Round end | Brief triumphant fanfare (ascending arpeggio). Optional / low priority. |

---

## 7. Open Questions / Ambiguities Resolved
- **Host ending mid-round**: Immediately ends the current round, calculates rankings from total scores so far, and shows GAME_END. No partial-question scoring.
- **Round-end host decision**: Only the host sees "Start Next Round" / "Return to Lobby". Guests wait. No auto-advance.
- **"Endless" mode**: Since the host now manually starts each round, "endless" is implicitly supported by repeatedly clicking "Start Next Round". The "Questions per Round" setting can be set to any number; "endless" is removed as a setting.
- **Find-a-country button**: The confirm button will read "Confirm Selection" and never echo the selected country name.
- **Find-a-country answer reveal**: Instead of a text popup, the correct country is highlighted in blue on the globe and auto-centered. Drag is disabled during the 5-second reveal. No per-player answer list is shown.
- **Rank-based scoring ties**: If two answers arrive in the same event-loop tick, server arrival order (natural WS processing order) determines rank. Timestamps are not compared for ties.
- **Chips**: Chips show all active players. Spectators are not shown in chips. The ✓ appears when the server broadcasts `playerAnswered` and disappears at the start of the next question.
- **Mobile button highlight reset**: On mobile browsers, tapping an answer button can leave a persistent `:active` or touch-highlight state. Fix: explicitly `blur()` the active element and set `-webkit-tap-highlight-color: transparent` on answer buttons before rendering each question.
- **Zoom in Name the country mode**: Zoom (pinch/scroll) is always available so mobile users can see small countries. Rotation is only available in Find a country mode.
- **Identity model**: Name is the primary key. No UUID/sessionId is issued by the server. `localStorage` stores `geoName` for transparent reconnect.
- **Stale socket close**: When a player refreshes, the old WebSocket may close *after* the new one opens. The server ignores the old close because `player.ws` no longer matches the closing socket.
- **Host health ping**: Passive TCP close detection is unreliable for mobile devices that suspend. Active ping every 10 s with 3-miss tolerance guarantees host failover even if the OS doesn't fire `ws.on('close')` promptly.
- **Room hard reset**: When `allConnected.length === 0`, the server destroys the Room (clearing scores, settings, player records) and creates a new one. Existing sockets receive `roomClosed` and are dropped.
- **Join screen connection state**: The join button is never HTML-disabled; instead it queues the join message if the WebSocket isn't open yet, and shows connection status text below the button.
- **Cache busting**: Script tags use `?v=N` query params to force browsers to load new JS after deployments.
