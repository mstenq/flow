# Phase 0 — Setup & FX spike

**Goal:** a clean, portrait Phaser 4 project with the target folder layout, working bun
scripts, and a throwaway spike that confirms the Phaser 4 rendering features the visuals depend on.

## Tasks

### 0.1 Clean the template
- Delete `log.js` and `screenshot.png`, and remove the template sample scenes (`MainMenu`, `GameOver`, sample `Game`) and assets.
- `package.json`: rename it, change `dev`/`build` to the nolog commands, drop `package-lock.json`, and standardize on bun.
- Scripts: `dev`, `build`, `test` (`bun test`), `gen` (`bun tools/gen/cli.ts`), `gen:all`, `verify`, `typecheck` (`tsc --noEmit`).
- Turn on TS strict mode and add a path alias `@core/*` → `src/core/*` that works in both Vite and bun.
- `git init` and update `.gitignore` (`dist/`, but **commit** `public/levels/` so the game ships with its levels).

### 0.2 Game config
- Logical resolution 720×1280, `Scale.FIT`, `autoCenter: CENTER_BOTH`, background `#05030c`.
- Make sure pointer input works for both touch and mouse. Disable context menu and selection in `style.css`.
- Scenes are stubbed: `Boot → Preloader → LevelSelect → Play`.

### 0.3 Rendering spike (throwaway scene, `?spike=1`)
Confirm each of these works in **Phaser 4.0.0** and write down the API that worked in `plan/notes-phaser4.md`:
- [ ] Glow/bloom on a camera or container via the Phaser 4 **filters** system (Glow, Blur, ParallelFilters, or whatever is available).
- [ ] Additive blending on particles and Graphics.
- [ ] Particle emitter with a trail and additive glow.
- [ ] A custom fragment shader GameObject (for the background and optional chromatic aberration).
- [ ] Redrawing a ~48×48 tile board to a DynamicTexture/RenderTexture at 60fps on a mid-range phone.
- [ ] Bitmap/Web font for the numbers (pick a neon-friendly mono font such as "Orbitron" or "Rajdhani", self-hosted).

If something is missing in 4.0.0, record the fallback (for example, a manual bloom with a downsampled blurred RT and additive composite).

## Done when
- `bun run dev` shows an empty portrait scene, `bun test` runs (zero tests is fine), and `bun run typecheck` passes.
- The spike notes file lists the working APIs for glow, particles, shaders, and the board texture.
