# Spy Mode — "I Spy" Design Spec

**Date:** 2026-05-12
**Status:** Approved

---

## Overview

A fourth game mode (`mode: 'spy'`) where players take turns being the Spy. The Spy picks a target country using a roulette wheel; all other players are Guessers who compete to locate it on the globe by placing a pin. The Spy scores the same distance as the best guesser that turn — so they benefit from picking findable countries, not impossible ones.

---

## Terminology

| Spy mode | Existing code |
|---|---|
| Turn (one spy + guessers) | Challenge |
| Round (all players spy once) | — |
| Guess (pin placement attempt) | Question |

---

## Game Flow

```
LOBBY
  └── host clicks Start Game
SPY_PICKING  ← new server state
  └── server broadcasts spyPicking { spyName, round, totalRounds, turnInRound, totalTurns }
  └── spy sees roulette wheel, picks a country (client-side)
  └── guessers see blurred decorative spinning wheel + "[SpyName] is choosing..."
  └── spy sends pickCountry { name } → server validates → transitions to QUESTION
QUESTION  (same as proximity mode)
  └── guessers place pins, N guesses, distance feedback after each
  └── guessEnd overlay after each guess
  └── challengeEnd when guesses exhausted or exact hit
      └── spy score = minimum guesser distance this turn
      └── if more spy turns remain in round → SPY_PICKING (next spy)
      └── if round complete and rounds remain → SPY_PICKING (next round, first spy)
      └── if all rounds complete → GAME_END
GAME_END
  └── full leaderboard (cumulative distance, ascending), host sees Play Again
```

One round = every player spies once (order shuffled at game start, same order each round). After `challengesPerGame` rounds, game ends automatically.

---

## Settings

Spy mode reuses the same settings panel rows as proximity mode. No new settings introduced.

| Setting | Key | Applies |
|---|---|---|
| Guesses per Challenge | `guessesPerChallenge` | shown |
| Challenges per Game | `challengesPerGame` | shown (= rounds per game) |
| Timer (seconds) | `timerPerGuess` | shown |
| Questions per Round | `questionsPerRound` | hidden |
| List Size | `listSize` | hidden |

The mode selector gets a new option: `<option value="spy">I Spy</option>`.

Total spy turns per game = `challengesPerGame × playerCount`.

---

## Server State

### New Room fields

```js
spyTurnOrder      // array of player names, shuffled once at game start, same order each round
currentSpyIndex   // index into spyTurnOrder for the current turn (0..playerCount-1)
currentRound      // 1..challengesPerGame
```

`challengeTarget` (from proximity mode) is reused — set when spy confirms their pick.

### New Player fields

None. Existing `pin`, `pinLocked`, `score`, `totalScore` carry over unchanged.

---

## WebSocket Protocol

```
Client → Server
  pickCountry  { name }     Spy confirms chosen country. Server validates name exists
                             in GAME_COUNTRIES, then sets challengeTarget and transitions
                             to QUESTION state. Ignored if sender is not the current spy.

Server → Client
  spyPicking   { spyName, round, totalRounds, turnInRound, totalTurns }
               Broadcast on entering SPY_PICKING. All clients know who the spy is
               and where we are in the game.
```

All existing proximity messages (`placePin`, `lockPin`, `pinUpdate`, `pinLocked`, `guessEnd`, `challengeEnd`) are reused unchanged.

---

## Scoring

- **Guessers**: score = their pin distance to target (lower = better), same as proximity mode.
- **Spy**: score = minimum distance among all guessers that turn (i.e. best guesser's distance).
  - If no guesser placed a pin: spy scores 20015 km (half Earth's circumference — the theoretical maximum haversine distance).
- `totalScore` accumulates across all turns for every player including the spy.
- Leaderboard sorts by `totalScore` ascending (lower = better).

---

## Wheel UI

### Rendering

The wheel is a canvas (or dynamic SVG) rendering of a virtual circle with ~200 equal segments (one per country in `GAME_COUNTRIES`). Only an arc of ~12–15 segments is visible at any time through the screen "window". Visible segments show the country flag emoji and name. Segments outside the visible arc are not rendered.

### Spy interactions

- **Drag** to rotate the wheel; the visible arc updates in real time.
- As the pointer country changes, `highlightCountry(name)` is called client-side on the spy's globe — no server involvement.
- **Spin button**: picks a random target index, animates to it with cubic ease-out deceleration.
- **Confirm button**: sends `pickCountry { name }` to server. Disabled until a country is under the pointer.

### Layout

**Desktop** (≥ 800px): wheel renders in the right side panel (same position as the existing game sidebar). Globe takes the main area. Country highlights clearly visible as wheel rotates.

**Mobile** (< 800px): wheel is positioned at the vertical centre of the right edge, half off-screen (only the left ~half of the wheel circle is visible). A pointer on the left edge of the visible arc indicates the selected country. A small label just left of the wheel shows the selected country name. Globe fills the screen behind.

### Globe highlight

Client-only on the spy's screen. Uses the existing `highlightCountry` function. Cleared when spy confirms. Guessers never see the highlight.

---

## Guesser View During Spy Picking

Full-screen decorative wheel: same arc rendering, slowly auto-spinning, country names/flags blurred (segments show shape and colour only). Overlay label: *"[SpyName] is choosing..."*. No interaction possible. Transitions to the pin-placement UI (globe + Lock In button) once the spy confirms.

---

## Turn Transition

After `challengeEnd`, before the next `SPY_PICKING`:

- **All players except next spy**: banner displays *"[NextSpyName] is spy next"* for ~2s.
- **Next spy**: banner displays *"You are spy next"* for ~2s.

The transition is **automatic** — after the 2s banner the server broadcasts `spyPicking` with no host action required. (Unlike proximity mode, there is no manual "Next Challenge" button between turns.)

---

## Spy View During Guessing Phase

While guessers are placing pins, the spy watches the globe. The spy receives the same `pinUpdate` broadcasts as everyone else (no server changes needed). On the spy's client:

- Incoming `pinUpdate` messages are queued per player.
- A 1-second debounce runs per player: only the **latest** pin within each 1s window is processed; intermediate updates are dropped.
- When a debounced pin fires, the spy's globe briefly highlights the pin location and shows a toast: *"Player X placed on [Country]"*. Country name is resolved client-side via `d3.geoContains` (same logic as the existing guess-end overlay); falls back to *"Open Ocean"* if no match.
- The highlight and toast fade after ~2s.
- Multiple players' toasts can be visible simultaneously (stacked).
- The spy cannot interact with the globe during this phase (no pin placement for the spy).

This gives the spy live visual feedback on where guessers are searching, making the waiting phase engaging without revealing whether guesses are close.

---

## Client UI Components

| Component | Description |
|---|---|
| `SpyWheelCanvas` | Canvas wheel renderer. Takes rotation angle, country list, visible arc size. Stateless — re-renders on each animation frame. |
| `spy-picking` panel | Spy-only screen: wheel + Spin + Confirm buttons + globe. |
| `spy-watching` panel | Spy screen during guessing phase: globe (read-only) with live pin toasts. |
| `guesser-waiting` panel | Guesser screen during spy picking: blurred decorative wheel + status label. |
| Pin toast | *"Player X placed on [Country]"* — debounced, fades after 2s, stackable. |
| Transition banner | 2s overlay shown after challengeEnd naming the next spy. |

---

## Resolved Edge Cases

| Scenario | Resolution |
|---|---|
| Spy disconnects during picking | Server waits up to `timerPerGuess` seconds then auto-picks a random country |
| No guessers place a pin | Spy scores max distance; guessers score nothing |
| Player joins mid-game | Spectates until the start of the next full round; added to `spyTurnOrder` for subsequent rounds |
| Only 1 player in room | Host cannot start game (existing minimum-player guard applies) |
| Spy picks country not in GAME_COUNTRIES | Server rejects `pickCountry`, spy must pick again |
| Same country picked in consecutive turns | Allowed — no deduplication |
