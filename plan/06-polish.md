# Phase 6 — Balance, QA, ship

## Difficulty calibration
- Generate the first ~10 real levels. Play each one and record a felt difficulty from 1 to 5 next to the generator's score.
- Adjust the score weights and knob table in `difficulty.ts` until the two agree, then bump `GENERATOR_VERSION`
  and run `gen:all --force`.
- Check the curve: difficulty across `levels.json` order should rise in a sawtooth (a hard level, then a breather).
- Watch for "fast tapping" exploits or traps: play aggressively. If real-time play loses on levels where
  settled play wins too often, slow `tickMs`, or add a generator check that greedy fast play (taps every tick) also has a
  reasonable win rate.

## Introducing mechanics
Mechanics are placed automatically, so control their *first appearance* through difficulty ordering:
- Levels 1–3: core loop only (keep difficulty under 0.25).
- First hidden pod around level 4, keys around level 7, pairs around level 10.
- When a mechanic first appears, show a one-time tooltip card (stored in progress) such as "Locked pod: drain the key
  out of the image to open it." That's the only tutorial, and it needs a tiny `firstSeen` registry.

## QA checklist
- [ ] Real phones: iOS Safari and Android Chrome. Audio unlock, touch accuracy on 48×48 boards, no scroll/zoom bounce.
- [ ] Desktop: mouse, window resize, letterboxing.
- [ ] Tab hidden or resumed: the clock pauses (no tick burst on return).
- [ ] Pause, restart, and retry spam don't leak tweens, emitters, or audio nodes (check the heap after 20 restarts).
- [ ] `bun run verify` passes and `bun test` passes.
- [ ] Reduced-effects mode is readable and smooth.

## Build & deploy
- `bun run build` produces a static `dist/` that includes `levels/`. Deploy to any static host
  (GitHub Pages, Netlify, Cloudflare Pages). Optional later: PWA manifest plus offline cache for an installable app.

## Later (post-v1 backlog)
- Boosters: +1 lane, undo, shuffle a column, reveal hidden.
- Hints from the stored `solution` (recompute from the current state with the solver in a Web Worker).
- Stars from time/taps, daily level, new mechanics (frozen cells that need two passes, color-shifting cells,
  portals), and per-level overrides in `levels.json`.
