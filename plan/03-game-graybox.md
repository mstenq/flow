# Phase 3 — Playable gray-box

**Goal:** the complete game loop with plain shapes and text, so it's fun or not fun with no visual polish.
Rendering stays a thin layer over `Sim`. Views consume `SimEvent`s and `snapshot()` and never apply rules themselves.

## Layout (720×1280 logical)
```
 0–90     Top bar: pause • level name • 1x/2x speed toggle
 100–780  Board area 680×680. Cell size = floor(680 / max(W,H)); non-square images are centered
 800–910  Lanes row: L slots, evenly spaced
 940–1280 Queue: C columns; show front + next 3 pods per column, "+n" badge for deeper ones
```

## Scene: `Play`
- `init({ levelId })`: fetch `levels/<id>.json` and build `Sim.fromLevel(level, { emitPaths: true })`.
- **Clock:** a fixed-timestep accumulator. Every `tickMs` (halved at 2x) call `sim.tick()` and forward the events to views.
  Rendering interpolates between ticks.
- **Input:** tapping a column's front pod sends `sim.tap(col)` if it's legal. Taps take effect **immediately**, between ticks.
  An illegal tap plays a shake/"denied" response (locked, no free lane, pair partner not available).
- **Lose detection:** `sim.isSettled() && sim.isDead()` holds continuously for 1.0s (and nothing is still animating),
  then overload, then a Result overlay with Retry. Retry rebuilds the Sim from the JSON (same layout).
- **Win:** `won` event, then a short celebration, then a Result overlay (Next / Level select) and progress gets marked (Phase 5).
- **Pause overlay:** Resume / Restart / Level select. The clock stops while paused.

## Views (gray-box versions; Phase 4 replaces their internals and keeps their interfaces)
- `BoardView`: a colored rect per cell, with a key glyph on key cells. `onClaimed` removes the cell instantly
  and starts a `GooStream` placeholder (a dot tweening along `path` → board edge → lane slot).
- `LaneView`: slot rects. Each active pod shows a color swatch, its remaining count, and a fill bar.
  A linked pod that's waiting shows a "waiting for partner" state.
- `QueueView`: columns of pod rects showing capacity number + color. Hidden or locked pods show "?" / 🔒.
  Linked pairs get a connector line (straight across columns, or a bracket when stacked).
  When the front pod leaves, the column slides up with a tween.
- `Hud`: level name, speed toggle, pause.

## Debug affordances (dev builds only)
- `?level=<id>` jumps straight in. `?debug=1` overlays the next solution step, `dist` values, and a step/pause clock.
- Hotkeys: `S` single-tick, `F` settle, `R` restart, `N` next level.

## Done when
Every generated level from Phase 2 can be won by following `?debug=1` hints, losing triggers overload and retry,
all three mechanics work as described, and it runs at 60fps on a phone in the browser.
