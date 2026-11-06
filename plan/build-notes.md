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
- `?speed=0.5` (any value 0.05–1) slows the clock further for the session, on top of the 1x/2x toggle. It's for pace playtests.
- **Pace (gen-3.3.1):** the median pod now drains in ~3.6s (`MEDIAN_DRAIN_MS`, ticks 90–270ms). It used to be 1.2s. The user playtested
  `?speed=0.33` and liked it: slow drains make people want to tap ahead, and tapping ahead causes the mistakes.
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
- **Pod cap (gen-3.4, replaces the fixed 120 of gen-3.2):** a pod holds at most `POD_SHARE` = 1/4 of its color's cells,
  never less than `MIN_POD_CAP` = 10 (`podCaps` in `knobs.ts`). So 1000 white cells allow 250-cell pods while a 100-cell
  outline allows 25. A per-entry `maxPod` is an extra absolute cap. `MAX_POD_CELLS` = 333 is a pacing ceiling (30s at the fastest tick),
  reached only by huge single colors such as a background on a 64×64 board. Before any cap, big single-color areas became one
  huge pod (Moon had a 1029-cell pod), which played trivially. 1/6 was considered; it nearly doubled pods per level.
- **Few colors (gen-3.2):** at or above the easy cutoff, `fewColorBoost` raises the search target and forces mechanics:
  3 colors: +0.12, 2–3 keys, ≥2 pairs (cap +2). 4 colors: +0.08, 1–3 keys, ≥1 pair (cap +1). 5 colors: +0.03, 1–3 keys.
  Floors are best-effort: a pair needs 2 free lanes, so tight layouts may get fewer. The climb can't unpair below the floor.
  Stacking pairs on top (4 pairs on 2 lanes) killed stalling and made levels easier, so the boost is a floor, not an add.
  `meta.targetDifficulty` stores the boosted target.
- **Wide levels (gen-3.3):** at or above the easy cutoff, half the levels (`WIDE_SHARE`, picked by `laneCountFor` from the
  seed) are fixed at `WIDE_LANES` = 5 lanes. The climb can't change their lane count, so it has to find difficulty
  through traps that more lanes don't fix (keys, pairs, buried colors). The other levels let the search pick 2–4 lanes
  as before (`MAX_SEARCH_LANES`). Easy levels are never wide: with no keys or pairs, 5 lanes can't trap anyone.
  Background: raw layouts with 5 lanes are almost never losable. Colors, board size, speckle, full-bleed scenes,
  lowest-left pick order and impatience all failed to change that. Real generated levels widened to 5 lanes stayed
  losable about half the time (30% hard) because of their keys and pairs. A forced 5-lane sample of 26 levels hit its
  target in 25 cases.
- **Key top-up:** keys the climbed plan is short of are added at the end. A late lock can leave one forced order (Coffee
  Bag went 0.44 → 0.00), so `bestTopUp` measures 6 placements and keeps the nearest to target (0.05 per missing key).

- **Outline ring (gen-3.4):** `outlineFor` (seeded, no per-level config) gives some levels a generated one-cell ring in
  a brand-new neon around the art (`outline-ring.ts`; a frame on full-bleed art, padded by a cell, skipped past 64×64
  or when no neon is free). The ring seals the picture: nothing inside is reachable until ring pods drain holes in it,
  nearest the board edge first. Chance (gen-3.4.2, raised at the user's request to ~85% of levels): 0 below the easy cutoff, 0.7→0.95 with the
  target, always for ≤5 colors. The few-color boost counts the art's colors, not the ring. While the ring has unassigned cells,
  construction parks pods at `SEAL_PARK_RATE` = 0.6 so ring pods queue behind parked pods; that is what makes it a
  trap (a ring with ring pods at the front is just a warm-up). Ringed levels are always wide (5 lanes).
  Experiments (24 levels, 5 lanes): raw layouts without keys or pairs went from ~3% losable to ~5% with a ring and ~19%
  with ring + parking. Full generation: mean target miss 0.018 → 0.009, fewer pairs needed, ~40% faster.
  `bun run gen <png> --outline 0|1` forces it.
- **Background fill (gen-3.5):** `backgroundFor` rolls separately at half the outline chance; a level can have a ring,
  a background, or both. Every empty cell outside the art (and outside the ring) becomes one more new neon, so the
  background drains in layers from the board edge inward before the art opens. Enclosed holes stay empty. Skipped when
  there is no outside empty cell (full-bleed art, or a ring frame that filled the padding). Ring and background are
  both "seals" (`board.seals`): the park boost applies while any seal has unassigned cells, and sealed levels are
  always wide. `--background 0|1` forces it. The level select shows open levels as a dimmed color image (not a
  wireframe), since a filled background would read as a solid block.

## 4-lane wide levels (gen-3.8.0, 2026-11-05)
There were no 4-lane levels: sealed levels (ring or background) and `laneCountFor` wide levels were fixed at 5, and the
free search cuts lanes, so it settles on 2-3. Now every fixed-lane level takes `wideLanesFor(seed)` (knobs.ts): 4 lanes
for `FOUR_LANE_SHARE` (0.5) of seeds, else `WIDE_LANES` (5), on its own seed stream. 4 is above
`FILL_FIRST_MAX_LANES`, so these levels are not fill-first, and pushy pods still apply (`MIN_PUSHY_LANES` 4).
- **Result:** regenerated the 191 five-lane levels whose seed now picks 4 (`gen:all --only ... --force`, 2m01s wall on
  15 workers; 8 hit the wall-clock budget). Mean target miss 0.0107 (0.0135 at 5 lanes), 5 miss by > 0.05 (7 before),
  none unlosable; pod and pushy counts unchanged. The other 241 entries are byte-identical: cache keys refreshed,
  generatorVersion unchanged. Lanes now: 27 at 2, 17 at 3, 192 at 4, 200 at 5. Previous levels: /tmp/flow-levels-gen3.7.0.

## Fill-first lanes (gen-3.7.0, rules v3, 2026-11-05)
Asked for every 2–3 lane level to drain in waves, except the first 3 beginner levels (Heart, Invader, Mushroom).
- **Rule (`src/game/sim.ts` header, `updateWave`):** level JSON `fillFirst?: true` (written right after `lanes`).
  Nothing drains until a wave starts: no wave running, some lane pod can drain, and the player has no legal tap (every
  lane full, or nothing in the queue can go in: the endgame release). All pods in lanes join; pods tapped mid-wave are
  `held` for the next one. The wave ends at the end of the tick where none of its pods can drain. Settled play is
  "fill every lane, then drain to idle". Hash feature `TAG_WAVE`; events `waveStarted` / `waveEnded`.
- **Eligibility:** `fillFirstEligible(index)` (knobs.ts): every levels.json entry except the first
  `FILL_FIRST_EXEMPT_LEVELS` (3); `bun run gen` defaults to the entry's index (a PNG not in levels.json is eligible),
  `--fill-first 0|1` forces it. gen:all puts eligibility in the cache key (it is positional). On an eligible level
  every candidate with ≤ `FILL_FIRST_MAX_LANES` (3) lanes is fill-first, a 4-lane one is not, and the climb's lane
  mutations never cross that line (`MutationRules.fillFirstLanes`). Wide (5-lane) levels never are.
- **Construction:** `PlaySim` wave mode drains only when the lanes are full or no cell is unassigned. construct's
  `waveView` counts held pods' cells as promised (a color's pool for new fit pods is reachable minus in-lane
  capacity), so fit pods of one color never outgrow the pool and all complete in the wave. Each fill keeps room for
  a fit pod (frees a lane), and a held color gets no park/overflow pod in the same fill. Out of options →
  `ConstructStuck`, candidate skipped (4 of 1584 candidates in the regen). A candidate that doesn't replay after
  mechanics goes to the solver (`FILL_FIRST_SOLVER_BUDGET` 20k; never needed in the regen). Non-fill-first output is byte-identical to gen-3.6.0.
- **Stats:** for fill-first levels the trace counts a pod as stalled when a wave it is in ends with it still in its
  lane (`WaveStalls` in board.ts), and `stalledAfter` counts only those lanes: a held pod is not a stall, so
  overflowPods / peakStalled keep their meaning in the search objective.
- **Result:** regenerated the 43 levels at ≤4 lanes (`gen:all --only`, 51s wall on 15 workers; 3 big boards hit the wall-clock budget there and were rerun with `--jobs 3`, alien-squid and circuit-board still hit it on 64×64 boards — circuit-board did under gen-3.6.0 too). 40 are fill-first
  (27 at 2 lanes, 13 at 3), including the four former 4-lane levels; none ended at 4 lanes. Mean target miss 0.0052,
  none > 0.05, none unlosable. The first 3 are byte-identical. The other 389 levels and the dev-* fixtures were
  restamped to rules v3 in place (cache keys refreshed, generatorVersion unchanged). Previous levels: /tmp/flow-levels-gen3.6.0.

## Pushy pods (gen-3.6.0, rules v2, 2026-11-02)
Asked for more pressure on 4- and 5-lane levels. The only way to lose is every lane stalled at once, and a pushy pod
takes lane choice away from the player: a pushy pod whose color is buried becomes a forced stall.
- **Rule (`src/game/sim.ts` header, `dropPushy`):** pod JSON `pushy?: true`. A pushy pod at the front of its column takes
  a free lane by itself, exactly as if tapped, and **before the player can act**: at sim construction, at the end of
  `tap()` (the tap exposed it and a lane is still free), and at the end of a tick right after completing pods free
  lanes. Several waiting fronts drop lowest column first; a drop can expose another pushy pod, which drops too. So a
  pushy pod only ever waits at a front while every lane is busy. Tapping it is legal by the normal rules, but in
  practice it answers `noLane`. Deterministic and a pure function of state: the hash needs nothing new and settled play
  (`tap` → `settle`) models it exactly. New event `{ t: 'pushed', podId, lane }`; `PodState.pushy`.
- **Exclusive:** a pushy pod is never hidden, locked or linked (`validateLevel` counts pushy as a mechanic). Locks were
  kept exclusive too: one mechanic per pod, as before.
- **Count:** `pushyCountFor` (knobs.ts): uniform 0–`MAX_PUSHY` (5) from the seed on its own stream, 0 below the easy
  cutoff or below `MIN_PUSHY_LANES` (4). The climb keeps the count fixed (a `pushy-move` mutation only moves the flag);
  on non-fixed levels `lanes-` can't drop below 4 while pushy pods exist. A level that climbs to 4 lanes gets its pushy
  pods in the end top-up (`bestTopUp`, now shared with keys: 4 measured placements, 0.03 per missing pod, pushy before keys).
- **Plan:** `Plan.order` is lane-entry order (taps + pushy drops). `toLayout` skips pushy pods in the solution and
  rejects a pushy pod at a column front. With pushy pods, order-preserving redeals are no longer automatically
  solvable, so `planFromLayout(board, layout)` reads the order off the real Sim and every edit is validated (replay,
  then the solver: `validatePlan` in mechanics.ts). `addPushy` weights candidates toward pods that would drop early
  while their color is unreachable.
- **Players:** the solver and every rollout player need no special code (the sim drops). The smart player does not
  look ahead at pushy pods: a lookahead that judged them by reach *before* the tapped pod drained was too pessimistic
  and the climb exploited it.
- **Game:** orange ▼▼ badge on every visible pushy pod at any depth (`drawPushyGlyph`, `drawPushyBadge`); a waiting
  front pushy pod pulses. `pushed` plays a flatter, faster orange flight via `PlaybackRunner`, plus its own sfx.
  One-time intro card "PUSHY POD". The report marks pushy pods with ▼ and lists drops per step.
- **Result (gen:all, 432 levels):** 323 levels have pushy pods (977 pods, all wanted placed). Counts 0/1/2/3/4/5 →
  109/61/71/62/57/72 levels (the 0s include the 39 levels at 2–3 lanes and 2 of the 4 at 4 lanes). The score still targets the same
  difficulty, so smart win rate barely moved (mean 0.376 → 0.375); the pressure replaced other sources (overflow pods
  8.9 → 8.25 and solution taps 34.3 → 31.3 on pushy levels, same pairs/keys). Target miss mean 0.0108 → 0.0122
  (>0.05: 12 → 13). None unlosable. Previous levels: /tmp/flow-levels-gen3.5.1. The `dev-*` levels were rebuilt with
  `bun tools/dev/make-dev-levels.ts` for rules v2.

## Big boards (2026-11-02)
- Boards go up to 64×64 (`MAX_DIM` in `src/game/level.ts`; the generator's `MAX_BOARD_SIZE` is the same constant). It
  used to be 48. 128×128 was tried (Demon) and dropped: cells got too small to see and to judge "is there enough of
  this color". `levels:add` skips bigger PNGs (it lists them as skipped).
- The search's safety-net time budget went from 24s to 30s (`generate.ts`).
- Lane experiments: more colors don't make 5 lanes hard (our art simplifies to at most ~10–12 colors). Big boards with
  pairs and keys make 4 lanes losable; 5 lanes stays almost never losable for the smart player.
