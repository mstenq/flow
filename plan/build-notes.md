# Build notes (resolved decisions — every agent reads this)

These override PLAN.md / phase files where they conflict.

## Folder layout (AGENTS.md wins over PLAN.md's `src/core` naming)

| PLAN.md says | We use | Rules |
|---|---|---|
| `src/core/*` (pure sim) | `src/game/*` | Pure TS. No Phaser, no DOM in sim files. Shared by game **and** generator (bun). Only `src/game/main.ts`, `src/game/config.ts`, `src/game/EventBus.ts` may import Phaser. Sim files must never import those three. |
| `src/game/scenes`, `src/game/view`, `src/game/audio` | `src/phaser/scenes`, `src/phaser/view`, `src/phaser/audio` | All Phaser objects live here. |
| palette, constants | `src/data/*` | Typed defs shared by game + generator (e.g. `src/data/palette.ts`). |
| `@core/*` alias | `@game/*` → `src/game/*`, `@data/*` → `src/data/*` | Must work in Vite **and** bun. |
| `tools/gen/` | `tools/gen/` | Generator CLI (bun). Imports `@game/*` sim + `@data/*`. |
| `tests/` | `tests/game/*.test.ts`, `tests/gen/*.test.ts` | `bun test`. |

### Orchestration (AGENTS.md patterns, adapted to a real-time game)
- `src/game/gameFacade.ts`: the only thing scenes call for gameplay (`load(level)`, `tap(col)`, `advance(dtMs)` → `SimEvent[]`, `snapshot()`, `restart()`). Wraps `Sim` + fixed-timestep clock. Pure, unit-testable.
- `enqueuePlayback(events)` / `PlaybackRunner` (in `src/phaser/`): dispatches `SimEvent`s to views. Claims play **concurrently** (it's real-time). It is not a strictly sequential queue. Scenes never animate outcomes directly.
- `getRunState()` (progress, settings, current level id), `getRoundState()` (current level's facade/sim snapshot, clock), `getSceneState()` (paused, speed, overlay) in `src/game/state.ts`, with matching `runActions` / `roundActions` / `sceneActions`. Keep it small. Don't over-engineer.
- AGENTS.md mentions `Button.ts` / `DicePouch.ts`. Those come from another project, so ignore them. Its Zone-hit-area guidance still applies.

## Image simplification (user requirement, overrides phase 2 "fail if too many colors")
Source PNGs can be raw photos/illustrations with ~1000 colors (e.g. `levels-src/1.png`, 48×48, 1002 colors).
The generator must **never fail on too many colors**. It must simplify automatically:
1. Alpha < 128 → empty.
2. Quantize in CIELAB to at most `maxColors` (auto, from difficulty: ~4–5 easy, ~6 mid, ~7–8 hard, hard cap 10).
   Deterministic (no unseeded randomness). Weight by pixel count.
3. **Spatial cleanup**: dissolve speckles/dithering. Recolor 4-connected regions smaller than `minRegion` (default ~3–4 px) to the
   dominant neighboring color, repeat until stable. The result should read as coherent color regions (a good puzzle), not noise.
4. Re-merge clusters that ended up tiny, then map one-to-one onto the neon palette (hue + lightness cost, keep the image recognizable).
5. Log what happened: source colors → clusters → final colors, pixels changed by cleanup.

## Make it really easy to test (user requirement)
- `bun test`: all pure logic (sim, facade, palette, generator).
- `bun run typecheck`: `tsc --noEmit` over `src`, `tools`, `tests`.
- `bun run gen levels-src/1.png --report`: writes `tools/gen/out/<id>.html` (original vs simplified vs neon board, pods, stats,
  step-through replay) **and** `tools/gen/out/<id>.preview.png` (scaled-up neon board) so you can eyeball a level instantly.
- `bun run verify`: replays every stored solution.
- `bun run shot "<query>" out.png`: headless browser screenshot of the running game (see setup). Agents use it to check visuals.
- Game URL params: `?level=<id>` to jump in, `?debug=1` for the solution-hint overlay + step clock, `?spike=1` for the FX spike.
- Dev hotkeys: `S` single tick, `F` settle, `R` restart, `N` next level, `H` play the next hint tap.

## Rules for agents
- `bun`/`bunx` only (never npm/npx/yarn).
- Do **not** `git commit`, push, or rewrite history. Leave changes in the working tree.
- When working in parallel with another agent, stay inside the paths you own. If you need a change outside them, report it instead of making it.
- Guard clauses, no inline `import('x').T` types, `import type` at the top (see AGENTS.md).
- Finish by running `bun test` + `bun run typecheck` (scoped to your area if another agent is mid-edit elsewhere) and report the results honestly.

## Difficulty model (gen-3, overrides plan/02-generator.md §5 score)
Playtesting showed the gen-2 levels were easy: the score leaned on `randomWinRate`, but nobody taps a pod whose color
is completely buried, and a player who taps "whatever is showing" won most levels every time.
- **`smartWinRate`** (new stat): a sensible player that taps pods that fill completely first, then pods with anything
  reachable, then the rest (random within a tier). The score is `0.55·(1-smart) + 0.25·(1-greedy) + 0.10·(1-random) + 0.10·deadEndRatio`.
  Rough guide: 0.15 ≈ smart wins 90%+, 0.5 ≈ 55%, 0.8 ≈ 20%. The targets in `levels-src/levels.json` are unchanged.
- **Every level must be losable:** the search heavily penalizes a layout the smart player loses less than 5% of the time
  (`MIN_SMART_LOSS` in `generate.ts`), screens and climbs longer until it finds one.
- **Structure:** knobs use `target + STRUCTURE_BOOST` (fewer lanes, more stalls), pairs are allowed from 0.25 and up to
  3 per level. Locks and colors are unchanged (colors are limited by the source art).
- **Hidden pods are not part of the score.** They are dealt after the search at a fixed share (`hiddenShareFor`:
  0 below 0.25, then ~0.22–0.27, the same as gen-2 levels had). The climb never hides or unhides.
