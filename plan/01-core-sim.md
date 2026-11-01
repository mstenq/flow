# Phase 1 — Core simulation (`src/core/`)

**Goal:** a pure, deterministic, fast rules engine that implements exactly the
"Canonical game rules" in `PLAN.md`. It has no Phaser, DOM, or `Math.random` dependencies. Both the game and
the generator import it.

## Modules

### `types.ts`
`LevelData`, `PodSpec`, `PodState`, `LaneState`, `Action` (`{ column: number }`), and `SimEvent`:
```ts
type SimEvent =
  | { t: 'tapped'; podIds: number[]; lanes: number[] }
  | { t: 'claimed'; podId: number; lane: number; x: number; y: number; color: number; path: Point[] } // cell → exit
  | { t: 'keyCollected'; keyId: number; x: number; y: number; podId: number }
  | { t: 'unlocked'; podId: number }
  | { t: 'revealed'; podId: number }
  | { t: 'podCompleted'; podId: number; lane: number }   // emitted per pod, pairs emit together
  | { t: 'won' } | { t: 'dead' };
```

### `grid.ts`
- `Uint8Array` cells (`255` = empty), plus a `keyAt: Int16Array` (`-1` = none).
- Per-color list of remaining cell indices (swap-remove), used for fast "min reachable" scans and counts.

### `reach.ts`: distance maps
- For each color `c`, `dist_c: Int32Array` (∞ = unreachable).
- **Initial build:** multi-source BFS seeded from all border cells that are passable for `c` (dist 1).
- **Incremental update:** when a cell of color `d` is emptied, then for every color `c ≠ d`, if the
  cell's best neighbor `dist_c + 1` (or 1 at the border) is better than `∞`, relax outward from it with a BFS queue.
  Removing an obstacle can only *decrease* distances, so relaxation is local and cheap.
  For `c == d` nothing changes (the cell was already passable).
- **Path for visuals:** from a claimed cell, walk to any neighbor with `dist - 1` until reaching the border.
  The walk is deterministic (fixed neighbor order). Only compute it when the caller asks (the game does, the solver doesn't).
- **Pick:** `pickNearest(c)` scans the remaining color-`c` cells for min `(dist, -y, x)`. That's O(cells of c), which is fine at 48×48.
  Optimize later with bucket queues if profiling says to.

### `sim.ts`
```ts
class Sim {
  static fromLevel(level: LevelData, opts?: { emitPaths?: boolean }): Sim
  clone(): Sim                          // cheap typed-array copies, used by the solver
  legalTaps(): number[]                 // column indices
  tap(column: number): SimEvent[]       // throws if illegal
  tick(): SimEvent[]                    // one claim per active pod, then keys/complete/reveal
  settle(): SimEvent[]                  // tick until no claim happens
  isSettled(): boolean; isWon(): boolean; isDead(): boolean
  hash(): bigint                        // Zobrist: emptied cells + column heads + lanes(pod,remaining) + collected keys
  snapshot(): ViewState                 // what the game renders (respects hidden/locked info)
}
```
Notes:
- Linked pods: tapping either partner moves both into the two leftmost free lanes. A completed linked pod
  holds its lane in a "full, waiting" state until its partner is done, and then both free together.
- Lane order is the claim priority. When two active pods share a color, the left lane claims first each tick.
- Re-checking `isDead` is only valid when settled. The game adds a grace period on top of it.

### `hash.ts`, `rng.ts`
- Zobrist tables seeded deterministically from `(width, height, podCount)`, updated incrementally on every mutation.
- `mulberry32(seed)` plus helpers `int`, `pick`, `shuffle`, `weighted`.

## Tests (`tests/core/*.test.ts`) using tiny ASCII fixtures
Write a helper `lvl(ascii, columns, lanes)` to build levels inline. Cover:
- Reachability: a cell enclosed by another color is unreachable. It becomes reachable when the enclosing color is drained.
- Own-color passthrough: a deep cell in a solid blob that touches the edge is reachable.
- Drain order: nearest first, tie-break bottom row then left (golden test on a 5×5 board).
- Incremental distance updates match a full BFS rebuild after random removals (property test, 500 random seeds).
- A partial pod stays in its lane. Lanes fill up, leaving no legal tap, so the state is dead.
- Locked pod: not tappable → key cell drained → `keyCollected` + `unlocked` → tappable.
- Hidden pod: revealed only when at the front, with the event emitted once.
- Linked pairs: side-by-side with a gap column, stacked consecutively, needs 2 lanes, holds the lane until both are full.
- Determinism: the same taps give the same event stream and hash. `clone()` is independent.
- Win when the board is empty.
- Perf smoke test: a full random 48×48, 8-color settle run with greedy taps finishes in under 50ms.

## Done when
All tests pass, there's 100% coverage of rule branches in `sim.ts`, and the perf smoke test passes.
