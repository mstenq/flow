# FLOW

A Phaser 4 portrait puzzle game. Levels are generated from PNGs: drop an image in `levels-src/`, run the generator, and the game loads the resulting JSON from `public/levels/`. See `PLAN.md` and `plan/`.

Use `bun` / `bunx` only (never npm, npx or yarn).

## Commands

| Command | Does |
|---|---|
| `bun install` | Install dependencies |
| `bun run dev` | Vite dev server on http://localhost:8080 |
| `bun run build` | Production build to `dist/` (drops `levels/dev-*.json`, no `window.__FLOW__`) |
| `bunx vite preview --config vite/config.prod.mjs` | Serve `dist/` locally |
| `bun test` | Sim, facade, progress, intro and generator tests |
| `bun run typecheck` | `tsc --noEmit` over `src`, `tools`, `tests` |
| `bun run verify` | Replay every level's stored solution against the current sim |
| `bun run shot "<query>" out.png [--wait ms] [--size WxH]` | Headless Firefox screenshot of the dev server; prints console / page errors and the renderer |
| `bun tools/dev/interact.ts "<query>" step step ...` | Scripted headless session (see "Headless sessions") |
| `bun tools/dev/leak.ts [restarts=20] [roundTrips=10] [level=heart]` | Leak check: restarts + level-select round trips, prints before/after counts, exit 1 on growth |

### Generator workflow

| Command | Does |
|---|---|
| `bun run gen levels-src/heart.png --report` | Generate one level into `public/levels/<id>.json` and write the report |
| `bun run gen levels-src/1.png --difficulty 0.4 --seed 7 [--name X] [--id X] [--max-colors N] [--min-region N] [--max-pod N]` | Same, with explicit parameters (they override the `levels-src/levels.json` entry) |
| `bun run gen:all [--force] [--no-report]` | Generate every entry of `levels-src/levels.json` (cached by source hash + params; `--force` regenerates) and rewrite `public/levels/index.json` |
| `bun run gen:sweep [glob] [--difficulty 0.4] [--simplify-only] [--limit N] [--every N] [--jobs N] [--out stem] [--timeout S] [--include-listed]` | Try the generator on a whole folder of PNGs (default `levels-src/*.png`); never writes to `public/levels` |
| `bun run verify` | Replay stored solutions for all levels in `public/levels` |

Where output lands:

- `tools/gen/out/<id>.html`: report for one level (original vs simplified vs neon board, pods, stats, step-through replay).
- `tools/gen/out/<id>.preview.png`: scaled-up neon board of that level.
- `tools/gen/out/sweep.html` and `sweep.json`: the sweep contact sheet and raw results (`--out` changes the file stem).
- `public/levels/<id>.json` + `public/levels/index.json`: what the game loads. `dev-*.json` are test levels (`bun tools/dev/make-dev-levels.ts`) that only dev builds list.

Add a level: put the PNG in `levels-src/`, add an entry to `levels-src/levels.json` (`file`, `name`, `difficulty`, optional `id`, `seed`, `maxColors`), run `bun run gen:all`, then `bun run verify`. The order of `levels.json` is the campaign order.

## How to test

### URL flags

All flags work in dev; the ones marked (prod) also work in a production build.

| Flag | Effect |
|---|---|
| `?level=<id>` (prod) | Jump straight into a level (ignores locks). Without it you land on the level select |
| `?autoplay=1` (prod) | Follows the stored solution (one tap every 250 ms when idle). `?autoplay=random` taps random legal columns (good for seeing overload). Mechanic intro cards close themselves after 1.5 s while autoplaying |
| `?speed=2` (prod) | Start at 2x speed (headless runs) |
| `?fx=low` / `?fx=high` (prod) | Force reduced effects on / off for the session (no bloom, no warp grid, fewer particles) |
| `?cb=1` (prod) | Color-blind glyph overlay on the board (also saved in settings) |
| `?debug=1` (prod) | Solution-hint overlay on the queue, extra HUD buttons (DIST, HOLD, STEP, SETTLE, HINT), a debug line, and the hotkeys below |
| `?reset=1` (prod) | Wipe saved progress, settings and seen intro cards. The flag is removed from the URL so a reload keeps the fresh state |
| `?intro=reset` (prod) | Forget only the one-time mechanic intro cards (hidden / locked / linked) so you can see them again |
| `?intro=off` (prod) | Never show the intro cards this session |
| `?unlockall=1` (prod) | Every level selectable (this session only, not saved) |
| `?progress=heart,invader` (prod) | Mark those levels as cleared (best time 1:30) |
| `?spike=1` | The FX spike scene (visual experiments) |

Flags combine, e.g. `/?level=dev-mechanics&reset=1&autoplay=1&speed=2`. Progress and settings live in `localStorage['flow.progress.v1']`.

### Hotkeys

Dev server, or any build with `?debug=1`:

| Key | Does |
|---|---|
| `S` | Single sim tick |
| `F` | Settle (tick until idle) |
| `R` | Restart the level |
| `N` | Next level |
| `H` | Play the next hint tap (follows the stored solution) |
| `G` | Toggle color-blind glyphs |

### Handy checks

- Mechanic intro cards: `/?level=dev-mechanics&intro=reset` (hidden, locked and linked cards in sequence; tap anywhere or the button).
- Tab hidden: switch tabs while playing. The pause menu opens and the clock does not advance; coming back never causes a burst of ticks.
- Level select scrolling: drag / swipe (with inertia) or the mouse wheel. Dev builds show `dev-*` levels in a separate DEV section.
- Window resize / phones: the game letterboxes (`Scale.FIT`) at any size; try `--size 1280x720` and `--size 390x844` with `bun run shot`.
- Leaks: `bun tools/dev/leak.ts`.

### Headless sessions

```
bun run shot "level=kimono&autoplay=1&speed=2" /tmp/a.png --wait 8000 --size 390x844
bun tools/dev/interact.ts "level=heart" wait:2500 click:100,1000 wait:500 shot:/tmp/a.png scene fps
FLOW_PROD=1 bun tools/dev/interact.ts "x=1" wait:2500 shot:/tmp/prod.png     # tests dist/ (run bun run build first)
```

`interact.ts` steps: `wait:<ms>`, `click:<x>,<y>`, `key:<Key>`, `drag:<x1>,<y1>,<x2>,<y2>[,steps[,stepMs]]`, `wheel:<dy>`, `goto:<query>`, `reload`, `storage`, `shot:<png>`, `fps`, `scene`, `eval:<js>` (dev only: `__FLOW__` exposes `game`, `facade`, `state`, `audio`), `hide` / `show` (fake the tab being hidden / visible), `resize:<WxH>`. Run one headless session at a time (a second Firefox hangs).

## Notes

- The page is locked to the viewport: no scroll, no overscroll bounce, no pinch / double-tap zoom.
- Touch targets: every `Button` has a hit zone of at least 84 logical px (about 45 px on a phone); queue columns are whole-column strips.
- Phaser template leftovers were removed; `public/levels/dev-*.json` are stripped from `dist/` by the prod Vite config.
