# FLOW — Neon Plasma Drain Puzzle (working title)

A Phaser 4 puzzle game inspired by *Colony Flow*. A pixel-art image made of glowing
plasma cells fills the board. You tap **pods** from queue columns into a limited number of
**lanes**. Each active pod siphons plasma of its color, which oozes out through open channels
and into the pod. Clear every cell without jamming the lanes.

Levels are **generated, not hand-built**: you drop a PNG in a folder, run one command, and a
generator builds the board, pods, mechanics, and difficulty. It proves the level is solvable
and writes a JSON file the game loads.

---

## Phase files

| # | File | Outcome |
|---|------|---------|
| 0 | [plan/00-setup.md](plan/00-setup.md) | Clean template, folder layout, bun scripts, Phaser 4 FX spike |
| 1 | [plan/01-core-sim.md](plan/01-core-sim.md) | Pure-TS deterministic rules engine plus tests (shared by game and generator) |
| 2 | [plan/02-generator.md](plan/02-generator.md) | PNG → level JSON CLI: palette, construction, solver, difficulty, mechanics |
| 3 | [plan/03-game-graybox.md](plan/03-game-graybox.md) | Fully playable game with plain visuals: load JSON, tap, lanes, win/lose |
| 4 | [plan/04-visuals.md](plan/04-visuals.md) | Neon / Geometry Wars treatment: bloom, goo streams, warp grid, FX |
| 5 | [plan/05-meta-audio.md](plan/05-meta-audio.md) | Level select, saved progress, synth SFX, and generative music |
| 6 | [plan/06-polish.md](plan/06-polish.md) | Balancing pass, mobile QA, settings, production build |

Each phase ends in a runnable, testable state. Phases 1 and 2 matter most: once the sim and the
generator are right, everything else is presentation.

---

## Decisions made while planning

| Topic | Decision |
|---|---|
| Theme | **Hybrid neon plasma + containment pods.** Space/Geometry Wars look (dark, bloom, warping grid, particles) with liquid "ooze" behavior. |
| Platform | Mobile portrait first (logical 720×1280, `Scale.FIT`), playable with a mouse on desktop. |
| Exit / reachability | **Any open board edge.** Plasma can leave if it has a 4-connected path to outside the grid through empty cells or cells of its own color. |
| Drain order | **Nearest to exit first** (BFS distance), tie-break **bottom row first, then left to right**. |
| Pod queue | **N columns.** Only the front pod of each column is tappable. |
| Lanes | **Per level**, chosen by the generator (typically 3–5). |
| Capacities | **Any number.** The generator splits each color's total into arbitrary sizes. Totals per color are exact. |
| Timing | **True real-time.** Plasma drains on fixed logic ticks and you can tap at any time, even mid-drain. |
| "Solvable" means | **Solvable for a patient player**: the solver assumes each tap settles before the next. Tapping fast is a risk/reward choice. |
| v1 mechanics | **Locked pods + keys**, **hidden pods**, **linked pairs**. |
| Keys | **Embedded in the image.** A key is attached to a board cell. Draining that cell frees the key, which flies to and unlocks its pod. |
| Linked pairs | Either in **two different columns** (adjacent or with a gap; both must be at the front) or **stacked consecutively** in one column (no gap). Both need lanes, and neither leaves until both are full. |
| Generator goal | **Target difficulty score** (0–1) per level. Stats are written into the JSON. |
| Image input | **PNG, 1 px = 1 cell.** Transparent = empty. Near-duplicate colors get merged. |
| Colors | **Remapped to a curated neon palette** (about 10 distinct hues). |
| Mechanic placement | **Fully automatic.** No per-level overrides. Your only inputs are the PNG, name, and difficulty. |
| Max board | About **48×48**. |
| Board look | **Crisp glowing tiles at rest.** Cells melt into goo blobs that stream along the path into the pod. |
| Lose | **Overload → retry** when nothing can progress. |
| v1 meta | **Level select + saved progress**, **audio** (synth SFX + generative music). |
| Not in v1 | Boosters, stars/score, per-level overrides, hints (the stored solution makes hints easy later). |

### Assumptions I made (push back if wrong)
- **Keys sit on top of a pixel; they don't replace it.** The image stays intact, and the key cell is just a
  normal colored cell with a key icon. When that cell is drained, the key is collected.
- **Locked pods hide their color/capacity** until unlocked (as in Colony Flow).
- **No combined mechanics in v1.** A pod is at most one of locked, hidden, or linked.
- **bun** is the toolchain for scripts and tests (`bun.lock` is already present). Vite still bundles the game.
- The template's `log.js` telemetry gets removed, and the `dev`/`build` scripts become the "nolog" versions.
- Working title "FLOW", which can change.

---

## Canonical game rules (the sim implements exactly this)

**Board.** A `W×H` grid. Each cell is `EMPTY` or a color index `0..K-1`. Some colored cells
carry a key `k` (at most one key per cell).

**Reachability for color c.** Run a multi-source BFS starting from outside the grid, stepping
4-directionally through cells that are `EMPTY` or color `c`. `dist_c(cell)` is the step count. A cell of color
`c` is *reachable* if `dist_c` is finite. (Removing a `c` cell never changes `dist_c`, because it was
already passable. Only removing *other* colors can open new paths. The sim uses this
for incremental updates.)

**Queue.** `columns[i]` is an ordered list of pods, and index 0 is the front. A pod has `color`, `capacity`,
and optionally one of `hidden`, `lock: keyId`, or `link: partnerPodId`.

**Lanes.** `L` slots. Each holds an active pod and its `remaining` count.

**Legal tap** (at front pod `p` of column `i`):
- `p` is not locked, or its key has been collected.
- Normal pod: at least 1 free lane.
- Linked pod: at least 2 free lanes, **and** its partner is either at the front of another column
  or directly behind `p` in the same column. Tapping either pod moves both.
- The pod goes into the leftmost free lane.

**Tick** (fixed duration in game, abstract in the solver):
1. Apply any taps queued since the last tick (in game; the solver applies one tap and then settles).
2. Visit lanes left to right. Each active pod with `remaining > 0` claims **one** reachable cell of its color,
   choosing the minimum by `(dist_c, -y, x)`. The cell becomes `EMPTY` immediately, `remaining--`, and the sim
   emits a `claimed` event with the path to the exit (for visuals).
3. A claimed cell that carries a key collects it. The matching locked pod unlocks and reveals itself.
4. Pods with `remaining == 0` complete and free their lane. A linked pod waits in its lane, full, until its
   partner is also full, and then both leave together.
5. Any pod now at the front of its column that is `hidden` gets revealed.

**Settled.** No active pod can claim anything this tick.
**Win.** The board is empty. (Totals are exact, so every pod has been used too.)
**Lose.** The state is settled, there is no legal tap, and the board is not empty. In game this triggers *overload* after a short grace period.

---

## Architecture

```
src/
  core/            # pure TS, no Phaser, no DOM. Shared by the game AND the generator (bun).
    types.ts       # LevelData schema, PodSpec, Action, SimEvent
    level.ts       # parse/validate LevelData → initial State
    grid.ts        # cell storage, neighbors, key map
    reach.ts       # per-color BFS distance maps with incremental relaxation
    sim.ts         # State, legalTaps(), tap(), tick(), settle(), isWon(), isDead()
    hash.ts        # Zobrist hashing for solver memo
    rng.ts         # seeded PRNG (mulberry32)
  game/            # Phaser 4 scenes and views (only reads/writes through core/sim)
    scenes/        # Boot, Preloader, LevelSelect, Play, Pause/Result overlays
    view/          # BoardView, LaneView, QueueView, GooStream, NeonGrid, Fx
    audio/         # Synth SFX + generative music
    progress.ts    # localStorage persistence
tools/gen/         # generator CLI (bun): png, palette, construct, solver, difficulty, mechanics, report
levels-src/        # YOUR input: *.png + levels.json (order, name, difficulty)
public/levels/     # generated: <id>.json + index.json
tests/             # bun test for core and generator
```

**Key principle:** game and generator run the *same* `core/sim.ts`. In the game, ticks run on a
timer and taps arrive whenever the player makes them. The solver applies a tap and calls `settle()`. A player who
waits for settle therefore reproduces a solver-verified line exactly.

### Level JSON (v1)
```ts
interface LevelData {
  version: 1;
  rulesVersion: number;          // bump when sim rules change → `bun run verify` re-checks levels
  id: string; name: string;
  width: number; height: number;
  palette: string[];             // neon hex per color index
  cells: string;                 // row-major, '.' = empty, '0'..'9' = color index
  keys: { id: number; x: number; y: number }[];
  lanes: number;
  tickMs: number;                // base drain speed (2x toggle halves it)
  columns: PodSpec[][];          // columns[i][0] is the front
  solution: number[];            // column index tapped per step (settled play); used by verify and future hints
  meta: { seed: number; targetDifficulty: number; difficulty: number;
          stats: DifficultyStats; generatorVersion: string; sourceHash: string };
}
interface PodSpec { id: number; color: number; capacity: number;
                    hidden?: true; lock?: number; link?: number }
```

### Commands (end state)
| Command | Does |
|---|---|
| `bun run dev` | Vite dev server |
| `bun run gen levels-src/heart.png --difficulty 0.4 [--seed 7]` | Generate one level |
| `bun run gen:all [--force]` | Generate every entry in `levels-src/levels.json` (cached by source hash + params) |
| `bun run verify` | Replay every level's stored solution against the current core |
| `bun test` | Core and generator tests |
| `bun run build` | Production build to `dist/` |
