# Multi-Room Support with Dual Local/Public Mode

## Overview
Transition the Geo Challenge server from a single global room to a multi-room registry. Support both local LAN play (QR codes point to local IP) and public deployment (QR codes point to my-game.com). Keep WebSocket architecture. First-come-first-served host election.

---

## 1. Server (`server/index.js`)

### A. Keep `detectLocalIP()`
Retain existing LAN IP detection so the game remains playable without deployment.

### B. Add `getBaseUrl(req)` helper
Cascading fallback for generating public-facing URLs:
1. `process.env.BASE_URL` (production override)
2. If `Host` header is `localhost` or `127.x.x.x`, fall back to `http://<detectLocalIP>:<PORT>`
3. Otherwise use `req.protocol + '://' + req.get('host')`

### C. Replace global `room` with `rooms` registry
```js
const rooms = new Map(); // roomId -> Room instance
```

### D. Update `Room` class
- Constructor accepts `roomId`
- Add `lastActivity` timestamp (updated on every player action)
- `generateQR(baseUrl)` -> QR encoding `${baseUrl}/?room=${this.roomId}`

### E. Add REST endpoints
| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/rooms` | Create room -> `{ roomId, qr, url }` |
| `GET` | `/api/rooms/:roomId` | Validate room -> `{ exists, playerCount }` |
| `GET` | `/api/rooms/:roomId/qr` | Get room QR -> `{ qr, url }` |

Remove old global `GET /api/qr`.

### F. Update WebSocket `join` handler
Expect `msg.roomId` from client:
- If room missing -> `send(ws, { type: 'error', message: 'Room not found' })`
- If room exists -> `room.addPlayer(ws, msg.name)` (first player becomes host)

### G. Room cleanup interval
Every 60 seconds, destroy rooms where:
- `allConnected.length === 0` AND
- `Date.now() - room.lastActivity > 10 minutes`

### H. Environment Variables
| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP/WebSocket port |
| `BASE_URL` | `null` | Force public URL for QR codes |
| `ROOM_IDLE_TIMEOUT_MS` | `600000` | Auto-delete empty rooms |

---

## 2. Frontend (`public/index.html`)

### A. Add Landing Screen (`#screen-landing`)
- Title: "Geo Challenge"
- Button: **Start a Room**
- Button: **Join a Room**

### B. Add Host Waiting Screen (`#screen-host-wait`)
- Large Room ID display
- QR code image (`#host-qr-code`)
- Share text: "Share this link or QR code"
- Connected player list
- **Start Round** button

### C. Update Join Screen (`#screen-join`)
- Room ID input (pre-filled from `?room=` URL query param)
- Name input
- **Join Game** button

### D. Lobby & Game screens
- Remove QR code and URL elements from the lobby (moved to host waiting screen)
- Keep settings, player list, game UI intact

---

## 3. Client Logic (`public/js/app.js`)

### A. Update WebSocket URL
```js
const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
```

### B. Parse room ID from URL on load
```js
const urlRoomId = new URLSearchParams(location.search).get('room');
```

### C. Host Flow (`doCreateRoom()`)
1. Call `POST /api/rooms`
2. Receive `{ roomId, qr, url }`
3. Update browser URL: `history.replaceState(null, '', '/?room=' + roomId)`
4. Show `#screen-host-wait`
5. Set `#host-qr-code` src and display Room ID
6. Connect WebSocket
7. Send `{ type: 'join', name, roomId }`

### D. Join Flow (`doJoin()`)
1. Read room ID from input
2. (Optional) Call `GET /api/rooms/:roomId` to validate existence
3. Connect WebSocket
4. Send `{ type: 'join', name, roomId }`

### E. Update `loadQR()`
Call `fetch('/api/rooms/' + roomId + '/qr')` instead of `/api/qr`

### F. Host Election
No changes. `Room.addPlayer()` already elects the first connected player as host.

---

## 4. Room ID Generator
```js
function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // exclude 0, O, 1, I
  let id = '';
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}
```

---

## 5. Deployment Notes

### Reverse Proxy (Nginx example)
```nginx
server {
    listen 443 ssl;
    server_name my-game.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

### Free Hosting Options
| Platform | Notes |
|---|---|
| Railway | Native WebSocket, free tier available |
| Render | Native WebSocket, free tier available |
| Fly.io | Native WebSocket, free tier available |
| DigitalOcean | $6/mo VPS, simple and reliable |

---

## Files to Modify

| File | Change Type |
|---|---|
| `server/index.js` | Major rewrite |
| `public/index.html` | UI restructuring |
| `public/js/app.js` | Logic refactoring |

---

## Validation Plan

### Phase 1: Static Checks
1. Start the server: `npm start`
2. Verify server boots without errors
3. Verify no port conflicts

### Phase 2: API Endpoint Tests (using curl)
1. **Create room**: `curl -X POST http://localhost:3000/api/rooms`
   - Expect: `{ roomId: "XXXXXX", qr: "data:image/png;base64,...", url: "http://.../?room=XXXXXX" }`
2. **Get room info**: `curl http://localhost:3000/api/rooms/XXXXXX`
   - Expect: `{ exists: true, playerCount: 0 }`
3. **Get room QR**: `curl http://localhost:3000/api/rooms/XXXXXX/qr`
   - Expect: `{ qr: "...", url: "..." }`
4. **Get non-existent room**: `curl http://localhost:3000/api/rooms/NONEXIST`
   - Expect: 404 or `{ exists: false }`

### Phase 3: Host Flow (Single Browser)
1. Open `http://localhost:3000`
2. Click **"Start a Room"**
3. Verify:
   - Room ID displayed (6 chars)
   - QR code generated
   - URL bar updated to `/?room=XXXXXX`
   - WebSocket connects (check console)
4. Enter name and join
5. Verify:
   - Host badge appears
   - Host controls visible
   - Can modify settings

### Phase 4: Join Flow (Same Browser, New Tab)
1. Open `http://localhost:3000/?room=XXXXXX` (using the room ID from Phase 3)
2. Verify room ID pre-filled
3. Enter different name and join
4. Verify:
   - Both tabs show both players in lobby
   - Host tab has Start Round button
   - Non-host tab shows "Waiting for host..."

### Phase 5: Multiple Rooms
1. In a third tab, click **"Start a Room"**
2. Verify a different Room ID is generated
3. Join with a name
4. Verify the new room is completely isolated:
   - Players from Room 1 do not appear in Room 2
   - Starting a round in Room 1 does not affect Room 2

### Phase 6: Game Round
1. In Room 1, host clicks **Start Round**
2. Verify both players in Room 1 see the game screen
3. Verify Room 2 is unaffected
4. Play through a few questions
5. Verify scoring, timers, and state updates work for both players

### Phase 7: Room Lifecycle
1. Close all tabs for Room 2
2. Wait ~10 minutes (or temporarily lower `ROOM_IDLE_TIMEOUT_MS` to 10s for testing)
3. Try to join Room 2 with the old room ID
4. Verify "Room not found" error

### Phase 8: LAN Mode
1. Start server locally without `BASE_URL`
2. Access via `http://localhost:3000`
3. Click Start Room
4. Inspect QR code URL - should contain local LAN IP (e.g., `http://192.168.1.x:3000/?room=...`)
5. Access the same URL from another device on the same LAN
6. Verify join works

### Phase 9: Public Mode Simulation
1. Stop server
2. Start with `BASE_URL=https://my-game.com`
3. Access via `http://localhost:3000`
4. Click Start Room
5. Inspect QR code URL - should be `https://my-game.com/?room=...`

### Phase 10: Reconnect
1. In a room, refresh the host's tab
2. Verify host reconnects and reclaims their name
3. Verify other players see host reconnect
4. Verify host status preserved if host was the only player, or first-come-first-served if someone joined before them

---

## Success Criteria
- [ ] Server starts without errors
- [ ] `POST /api/rooms` creates a room with 6-char ID
- [ ] `GET /api/rooms/:id` validates room existence
- [ ] `GET /api/rooms/:id/qr` returns QR for that room
- [ ] Host can create a room and see QR + Room ID
- [ ] Player can join via URL `?room=XXXXXX`
- [ ] Multiple rooms can coexist without leaking state
- [ ] Game rounds work correctly in each isolated room
- [ ] Empty rooms auto-delete after timeout
- [ ] LAN mode generates local IP URLs
- [ ] Public mode (`BASE_URL`) generates correct domain URLs
- [x] Host refresh reconnects successfully

---

## Validation Results

### Phase 1: Static Checks
- [x] Server boots without errors on `npm start`
- [x] No port conflicts detected

### Phase 2: API Endpoint Tests
- [x] `POST /api/rooms` returns `{ roomId: "XXXXXX", qr: "...", url: "..." }`
- [x] `GET /api/rooms/:id` returns `{ exists: true, playerCount: 0 }`
- [x] `GET /api/rooms/:id/qr` returns `{ qr: "...", url: "..." }`
- [x] `GET /api/rooms/NONEXIST` returns `{ exists: false }`
- [x] `/api/countries` and `/api/country-colors` still functional

### Phase 3-6: WebSocket Multi-Room Flow
- [x] Host can create room and join via WS with `roomId`
- [x] Player can join same room with correct `roomId`
- [x] Wrong `roomId` returns `"Room not found"` error
- [x] Second room created with different ID; players isolated between rooms
- [x] First player automatically becomes host (first-come-first-served)
- [x] State, player lists, and settings broadcast correctly per room

### Phase 7: Room Lifecycle
- [x] Room immediately deleted when last player disconnects
- [x] Idle empty room cleanup interval active (60s checks)

### Phase 8: LAN Mode
- [x] Without `BASE_URL`, QR URLs contain local LAN IP (e.g., `http://192.168.1.x:3000/?room=...`)

### Phase 9: Public Mode Simulation
- [x] With `BASE_URL=https://my-game.com`, QR URLs use the public domain

### Phase 10: Reconnect
- [x] Host refresh reclaims name and host status (first-come-first-served election)
