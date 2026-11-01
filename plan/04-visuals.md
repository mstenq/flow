# Phase 4 — Neon / Geometry Wars visuals

**Goal:** make it gorgeous. Dark void, saturated neon, bloom, and everything reacting. Implement against
the API notes from the Phase 0 spike. Visual changes only: no rule changes, and each view keeps its interface.

## Global look
- **Background:** near-black `#05030c` with a slow drifting starfield (2 parallax layers) and a faint nebula
  (shader noise, very low alpha, hue drifting over minutes).
- **Warp grid** (`NeonGrid`): a Geometry Wars spring-mass grid of points behind everything,
  drawn as additive thin lines. Events push it around: `applyImpulse(x, y, force, radius)` (pod complete = outward
  shockwave, claim = tiny dimple at the exit point, overload = violent implosion).
- **Bloom:** one global bloom pass on the main camera (threshold + blur + additive). Everything neon goes
  over it and UI text stays crisp (separate UI camera without bloom, or render order).
- **Color language:** each palette color has `core` (the hex), `glow` (lighter, for bloom), and `deep` (dark tint for
  fills). Color-blind aid: each color also gets a small glyph (●▲■◆✚…) on pods and an optional board overlay toggle.

## Board
- Cells are rounded tiles with a bright core, soft inner gradient, and 1px gaps. A very slow shimmer wave
  moves across the image so it feels alive. The whole board is drawn to one texture and redrawn only on change.
- A thin neon frame around the board. Plasma streams travel along this frame.
- **Reachable hint (subtle):** when a lane pod of color `c` is active, reachable `c` cells pulse slightly brighter
  so the player can read where it's pulling from.
- **Key cells:** a small glowing crystal key icon sits over the tile with a rotating sparkle.

## Goo stream (the signature effect)
When a cell is claimed:
1. The tile "melts": a quick squash and an additive flash, then it becomes a goo blob (a soft circle sprite with a metaball-ish
   look, made by rendering overlapping blobs into an RT and thresholding if the spike shows that's cheap).
2. The blob flows along `path` (cell → border) at high speed, leaving a fading trail of particles in its color.
3. It exits at the frame, rides the frame to the bottom edge nearest its lane, then arcs (bezier) into the pod.
4. On arrival the pod's liquid level ticks up, a splash particle burst fires, and the count decrements with a pop.
Many blobs streaming at once along the same channel should read as a **continuous river of plasma**.
That's the whole look of the game, so give it the most tuning time.

## Pods
- Glass capsules: a dark translucent body, bright rim light, and liquid fill rendered as a wobbling sine surface
  that sloshes when blobs land. The capacity number sits in a crisp mono font.
- **Tap:** the pod launches from its column to the lane on a quick arc, a lane-slot flash fires, and the grid ripples.
- **Complete:** the pod brightens, compresses, and shoots up offscreen (or implodes) with a shockwave on the warp grid, plus a chime.
- **Hidden:** a static/glitch shader with a flickering "?". The reveal is a glitch burst into its color.
- **Locked:** a hex-lock overlay with chains of light. Key collection: the key flies along a curved trail from its cell
  to the lock, the lock shatters into shards, and the pod reveals itself.
- **Linked pair:** an energy tether (a jittering lightning line) between the two pods, which persists in the lanes.
  The completed one holds a "charged, waiting" glow until its partner finishes, then both launch together.
- **Denied tap:** a red-shifted wobble plus a short buzz.

## Lanes
- Empty slot: a dim dashed outline that breathes slowly.
- When all lanes are full: the lane row's border heats from cyan toward red as a warning.

## Win / lose
- **Win:** the last cell drains, then the whole frame flares, the grid gets a big outward shockwave, fireworks of every palette color
  burst out, and the full original image briefly ghosts back in as a hologram before the Result overlay.
- **Overload:** lanes flash red, pods crack (shard particles), screen shake, chromatic aberration pulse,
  the grid implodes, then the Result overlay.

## Scene transitions
- Level select → play: the selected tile zooms in and dissolves into the board. A CRT-style power-on flicker for overlays.

## Performance budget
- 60fps on a mid-range phone with 5 active lanes streaming. Caps: about 300 live blobs and about 1500 particles.
- Pool every blob, particle, and shard. No per-frame allocation in hot paths.
- Settings toggle: "Reduced effects" (no bloom or grid warp, fewer particles), also defaulted on when
  `prefers-reduced-motion` is set.

## Done when
A screen recording of one level looks like it belongs in a trailer, and the performance budget holds on a real phone.
