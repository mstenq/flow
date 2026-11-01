# Audio engine notes

Standalone synthesized audio (WebAudio only, no assets). Not yet wired into scenes. Nothing here has been heard:
it was written and unit-tested without audio output (see "Manual listening checks").

## Files
- `src/game/music.ts`: pure logic (scales, `chooseKey(seed)`, `buildPatterns`, `intensityLayers`, `ClaimLimiter`, `cuesForEvent`). Tested in `tests/game/music.test.ts`.
- `src/phaser/audio/`: `AudioEngine` (context + bus graph), `Sfx`, `MusicEngine`, `AudioDirector`, `index.ts`.

Graph: `sfxBus` / `musicBus` -> master -> DynamicsCompressor (limiter) -> destination.

## Usage
```ts
import { audioDirector } from './audio';   // from src/phaser
```
Singleton `audioDirector`. Every method is a safe no-op before unlock, without WebAudio, under SSR and in bun tests.

| Method | Purpose |
| --- | --- |
| `installUnlock(target?)` / `unlock()` | Create + resume the AudioContext (user gesture required). |
| `setVolumes({ music?, sfx? })` / `getVolumes()` | Settings shape `{ music: number, sfx: number }`, each 0..1. Defaults `{ music: 0.6, sfx: 0.8 }` (`DEFAULT_VOLUMES` in music.ts). Ramped, click-free. |
| `onLevelStart(seed)` | Picks key/scale/tempo from the seed, starts the music, re-arms win/lose. |
| `onEvents(events, snapshot)` | Plays SFX for each event, updates music intensity from `snapshot.lanes`, plays the lanes-full warning on the transition to full. A `won`/`dead` event triggers `onWin`/`onOverload`. |
| `onDenied(reason?)` | Low buzz. |
| `onUiClick()` | Button click. |
| `onWin()` / `onOverload()` | Win sting + music resolve / overload sweep + music stop. Idempotent per level, so calling them in addition to the event path is harmless. |
| `onPauseChanged(paused)` | Suspends the context and stops scheduling / resumes. |
| `onLevelExit()` | Stop music (back to level select). |
| `dispose()` | Close the context. |

## Where to call each hook
- **Boot / first scene `create`**: `audioDirector.installUnlock()` once. It listens for `pointerdown`/`touchend`/`keydown` on `window` until the context is running. (Alternatively call `audioDirector.unlock()` in the first pointer handler.) Required on iOS/Android; until then everything is silent.
- **Settings load / settings screen**: `audioDirector.setVolumes(settings)` on load and on every slider change.
- **`PlaybackRunner.pump()`**: after `for (const e of batch) this.dispatch(e)`, add `audioDirector.onEvents(batch, this.t.getSnapshot())`. One line. Note the `won`/`dead` hooks in `dispatch` then need no audio calls.
- **Play scene `create` / restart**: `audioDirector.onLevelStart(level.meta.seed)`.
- **Play scene shutdown / back to menu**: `audioDirector.onLevelExit()`.
- **Denied tap** (where the facade returns a `TapDenial`): `audioDirector.onDenied(reason)`.
- **Buttons (`Button.ts` press handler, or menu code)**: `audioDirector.onUiClick()`.
- **Pause toggle in Play**: `audioDirector.onPauseChanged(paused)`. Also forward `document.visibilitychange` if desired.
- Optional extras on `audioDirector.sfx.play({ sfx: 'tick' })` for pod splash / count ticks (no sim event maps to `tick`).

## Event -> sound
`tapped` tap chirp; `claimed` pentatonic blip (color index -> scale degree, pitched in the level key, ~25/s limit + 8-voice stealing); `keyCollected` sparkle arpeggio; `unlocked` lock shatter; `revealed` glitch; `podCompleted` chord stab + whoosh; `won` win; `dead` overload. The mapping table is typed so a new `SimEvent` type fails typecheck until mapped.

## Music
Lookahead scheduler (25 ms timer, 100 ms ahead). Layers: pad, bass, arp (+ dotted echo), hats. Lanes used / total scales arp rate (quarter -> eighth -> sixteenth), arp gain, hats and filter cutoff. Lanes full is just the top of that ramp: no drone, no resonance (the old minor-second drone + Q 7 sweep was grating, and 2-3 lane levels sit at full constantly). The full-lanes SFX is a soft in-key note, at most once per 6 s. All changes use `setTargetAtTime`.

## Manual listening checks (no audio here)
- Levels sound different in key; claim blips match the music key and do not clip in a flood.
- Intensity transitions: no clicks or pops; hats/arp feel right at 1/3 and 2/3 lanes; full lanes sound busier, never harsh.
- Relative loudness: sfx vs music, win pad, overload sweep, reveal bitcrush, denied buzz.
- Pause/resume does not burst notes; resolve tail on win fades cleanly; unlock works on a real iOS/Android device.
- ~~Known limitation: SFX silent while paused~~ fixed in Phase 5: `onPauseChanged` now stops the music scheduler and mutes the music bus (`AudioEngine.setMusicDuck`) while the context keeps running; only a hidden tab suspends it (`onVisibilityChanged`, `installVisibility`).

## Phase 5 hookup (as wired)
- `src/phaser/bootstrap.ts` (from `Boot`): `installUnlock()`, `installVisibility()`, settings -> `setVolumes`.
- `Play.hookAudio`: a `PlaybackRunner` listener: `batch` -> `onEvents(events, snapshot, true)` (visual-timed: `unlocked`, `podCompleted`, `won`, `dead` are skipped there),
  `gooArrived` -> `onGooArrived` (tick, limited to 14/s), `keyArrived` -> `onKeyArrived` (lock shatter), `podLaunched` -> `onPodLaunched` (chord stab + whoosh),
  `denied` -> `onDenied`, `winSequenceStart` -> `onWin`, `overloadSequenceStart` -> `onOverload`. `onLevelStart(seed)` resets intensity to calm.
- `Button` calls `onUiClick()` on every press; the level tiles do it themselves.
- If the context is created after a level started (deep link before any gesture), music starts as soon as it exists (`AudioEngine.onContextCreated`).
- Nothing here has been heard; see the listening checklist above plus: pause/resume, settings sliders live, tab hide/show.
