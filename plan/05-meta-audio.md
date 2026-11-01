# Phase 5 — Level select, progress, audio

## Level select (`LevelSelect` scene)
- Reads `levels/index.json`. Shows a vertical scrolling grid of level tiles (drag/swipe to scroll, with inertia).
- Each tile is a **mini render of the level image**:
  - Locked level: dark tile with a lock.
  - Unlocked, not completed: a dim wireframe silhouette of the image (cell outlines only) in a neutral glow.
  - Completed: the full-color neon image, slowly shimmering. Your collection fills in as you play.
- Linear unlock: completing level *n* unlocks *n+1*. The current level pulses.
- The tiles also act as a title screen. The game name is on top, with a settings cog.

## Progress (`progress.ts`)
- `localStorage['flow.progress.v1'] = { completed: { [id]: { bestMs, attempts } }, settings: {...} }`.
- Versioned with a migration hook. If a level id disappears from the index, ignore it and keep the rest.
- Settings: music volume, SFX volume, reduced effects, color-blind glyphs, default speed (1x/2x).

## Audio (`src/game/audio/`), all synthesized, no asset files
- **Engine:** a single `AudioContext`, unlocked on the first pointer event (mobile requirement). A master bus,
  then a compressor/limiter, with separate music and SFX gain nodes.
- **SFX** (WebAudio oscillators and noise, tiny functions in the style of ZzFX):
  - Tap/launch: a short upward square chirp.
  - Claim: a very short soft "blip" whose pitch maps to the color index (a pentatonic scale).
    Rate-limited, since many claims per second blend into a shimmering texture.
  - Pod splash / count tick, pod complete (chord stab plus whoosh), key collected (sparkly arpeggio),
    lock shatter (noise burst plus glass ping), hidden reveal (glitch bitcrush), denied (low buzz),
    lanes-full warning (low pulse), overload (descending distorted sweep), win (rising arpeggio plus big pad).
- **Generative music:** a synthwave/ambient loop built from a scheduled step sequencer (lookahead scheduler):
  a bass drone plus an arpeggiated pentatonic lead plus a soft pad. **Intensity follows the game state**:
  more lanes in use adds layers (hats, faster arp), and lanes full adds a filter sweep and tension. It resolves on win.
  Each level picks a key/scale from its seed so levels feel different.
- Everything respects the volume settings and pauses with the game.

## Done when
A fresh browser starts at level select with level 1 unlocked, progress survives a reload, completed levels show their
neon art, and sound plays on mobile after the first tap with music reacting to lane pressure.
