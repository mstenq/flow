# Phase 2 — Level generator (`tools/gen/`)

**Goal:** `PNG → LevelData JSON` with no manual layout work. It guarantees solvability (for settled play),
targets a difficulty, and places all mechanics automatically.

## Inputs
`levels-src/levels.json` (the only thing you edit besides the PNGs):
```json
[
  { "file": "heart.png",      "name": "Heart",      "difficulty": 0.15 },
  { "file": "watermelon.png", "name": "Watermelon", "difficulty": 0.55 }
]
```
Order equals level order. `id` is derived from the filename. CLI flags (`--difficulty`, `--seed`) override these for one-off runs.

## Pipeline

### 1. `png.ts`: import
- Read with `pngjs` (pure JS). Alpha < 128 means an empty cell.
- Reject boards larger than 48 in either dimension, and reject zero cells.

### 2. `palette.ts`: color merge + neon remap
- Convert to CIELAB. Greedily cluster colors within ΔE < `tolerance` (default 10), weighted by pixel count.
  Clusters with fewer than 3 pixels merge into their nearest cluster, which removes anti-aliasing noise.
- Fail with a clear message if there are more clusters than the palette (~10). Print the clusters and suggest a tolerance.
- **Neon palette** (tune in Phase 4): magenta `#ff2bd6`, cyan `#00f0ff`, lime `#7dff3a`, yellow `#ffe600`,
  orange `#ff7a1a`, red `#ff2950`, violet `#9b5cff`, blue `#2f7bff`, mint `#00ffa8`, white `#f4f1ff`.
- Assign clusters to palette entries with the best one-to-one match (brute-force or Hungarian on a cost of
  hue distance plus a lightness penalty), so a red source stays red-ish and two source colors never share a neon.
  Very dark or desaturated sources go to white or violet.

### 3. `construct.ts`: build a layout from a known solution
Building forward from a solution guarantees solvability without having to search for it:
1. Pick knobs from the difficulty (see 5): `lanes`, `columns`, the pod-size range, and mechanic counts.
2. **Simulate a play-through:** at each step, choose a color that currently has reachable cells, weighted
   toward colors that will be blocked soon. Choose a capacity in `[min,max]` (clamped to that color's remaining
   total; the last pod of a color takes the exact remainder). Tap it in the sim and settle.
   Respect the lane limit by only creating a pod when a lane is free.
   This produces an ordered list of pods `S` that wins when played in order.
3. **Deal `S` into columns** while keeping their relative order. Any order-preserving deal keeps `S` a valid
   solution, because each pod is at the front of its column by the time it's needed. Dealing strategy (random,
   round-robin, or clumped) is another difficulty knob.
4. Store `solution` as the column index tapped per step.

### 4. `mechanics.ts`: automatic placement (no combos in v1)
- **Hidden:** mark a random share of non-front pods. This doesn't affect solvability.
- **Locked + key:** choose a pod `P` at solution step `j`. Choose a key cell drained **strictly before** step `j`
  in the constructed play, preferring cells drained 2–6 steps earlier and cells buried deeper
  (higher `dist`). Attach key → `P`. Pods at the front of a column at level start can't be locked.
- **Linked pair:** pick consecutive solution steps `k, k+1` where ≥2 lanes were free at step `k`. Make them
  a pair and redeal so that either both sit at the front of different columns at step `k`, or `k+1`
  is directly behind `k` in the same column. Replay to confirm.
- After each placement, **replay** the solution (settled). If it fails, undo that placement and try another.

### 5. `difficulty.ts`: measuring
For a candidate level, compute `DifficultyStats`:
- `randomWinRate`: % of 300 rollouts won by a player picking uniformly among legal taps (settled play).
- `greedyWinRate`: % won by a "reasonable" player who prefers taps whose color currently has reachable cells
  (with random tie-breaks).
- `deadEndRatio`: share of explored states that are dead, from a bounded DFS (see 6).
- `minLanes`: the smallest lane count still solvable (the solver tries `lanes-1`, `lanes-2`).
- `branching`: average number of legal taps per step along the solution.
- `hiddenShare`, `lockCount`, `pairCount`.

Score (calibrated on the first ~10 levels, then frozen in a `GENERATOR_VERSION`):
```
difficulty ≈ 0.45·(1-greedyWinRate) + 0.30·(1-randomWinRate) + 0.15·deadEndRatio + 0.10·mechanicsLoad
```

### 6. `solver.ts`: search
- DFS over taps with `settle()` between them. Keep a memo `Set<hash>` of dead or visited states.
- Move ordering: taps that complete immediately come first, then taps whose color is reachable, then the rest.
- A node budget (default 200k) returns `solved | unsolvable | unknown`.
- It's used for: mutated candidates (where the constructed solution may no longer apply), `minLanes`, and `deadEndRatio`.
  When a new solution is found, it replaces `solution` in the JSON.

### 7. Search loop (`cli.ts`)
```
seeded rng(seed)
repeat up to N candidates (default 40) or until |score - target| < 0.05:
    knobs ← sample around target (lanes, columns, size range, deal style, mechanic counts)
    level ← construct + mechanics
    stats ← measure
    keep best by |score - target|
then hill-climb the best ~15 iterations: mutate (swap neighbors across columns, split/merge a pod,
    ±1 lane, add/remove a mechanic) → solver must return `solved` → re-measure → keep if closer
```
Knob ranges by target difficulty (starting point, tune in Phase 6):

| target | lanes | columns | pods per color | mechanics |
|---|---|---|---|---|
| < 0.25 | 5 | 3–4 | 1–3 | none |
| 0.25–0.5 | 4–5 | 3–4 | 2–4 | hidden |
| 0.5–0.75 | 4 | 3–5 | 3–6 | hidden, keys, 1 pair |
| > 0.75 | 3–4 | 4–5 | 4–8 | all, more of them |

- `tickMs` is chosen so the median pod drains in about 1.2s (clamped to 30–90ms).
- Output: `public/levels/<id>.json`, plus regenerating `public/levels/index.json` (`[{id,name,width,height,difficulty}]`).
- Console summary: dimensions, colors, pods, lanes, mechanics, all stats, and the achieved vs target difficulty.
- `--report`: writes `tools/gen/out/<id>.html` with the board, columns, stats, and a step-through replay of the solution.
  This is the main debugging tool for judging whether a level is good.

### 8. `verify.ts`
Loads every `public/levels/*.json`, checks `rulesVersion`, replays `solution` with `settle()`, and asserts a win.
Exits non-zero on failure. Run it after any `src/core` change.

## Caching
`gen:all` skips a level when `sourceHash + params + GENERATOR_VERSION + rulesVersion` is unchanged (unless `--force`).
Seeds default to a hash of the id, so output is reproducible.

## Tests
- Palette: merges anti-aliased noise, maps to distinct neons, errors when there are too many colors.
- Construct: 200 random seeds on 3 fixture PNGs, and every result replays to a win.
- Mechanics: the key is always drained before its lock is needed, and pairs are always tappable at their step.
- Solver: finds solutions for small hand-made puzzles and proves a known-unsolvable fixture is unsolvable.
- Determinism: same input and seed give byte-identical JSON.

## Done when
`bun run gen:all` turns 3+ sample PNGs (you supply them, plus generated test fixtures) into levels at ~0.2 / 0.5 / 0.8,
`verify` passes, and each level takes under ~20s to generate.
