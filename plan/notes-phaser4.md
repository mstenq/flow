# Phaser 4.0.0 rendering notes (verified by `?spike=1`, see `src/phaser/scenes/Spike.ts`)

Verified with `bun run shot "spike=1" /tmp/spike.png --wait 3000` (headless Firefox, software GL, WebGL renderer, no page errors).
All 6 items worked with no fallback needed. Headless FPS read 59-60 with a 2304-tile board restamped every frame, but this is
software GL and NOT representative. **A real mid-range phone check is still needed.**

## 1. Glow / bloom (filters system)

```ts
import { Actions } from 'phaser';
// Whole-camera bloom (Threshold -> Blur, ParallelFilters ADD-blended over the original). Returns an ARRAY.
const [{ parallelFilters, threshold, blur }] = Actions.AddEffectBloom(this.cameras.main, {
    threshold: 0.35,   // 0-1, lower = more glows
    blurRadius: 2, blurSteps: 4, blurQuality: 1, // quality 0|1|2
    blendAmount: 1,    // bloom strength (>1 allowed)
    // blendMode: BlendModes.ADD (default), useInternal: false (default = external/screen space)
});
parallelFilters.active = false; // toggle off; parallelFilters.destroy() removes
blur.strength; threshold.edge1;   // tweakable at runtime

// Per-object glow (any GameObject: enableFilters() first; `filters` is null until then)
obj.enableFilters();
obj.filters!.internal.addGlow(color, outerStrength, innerStrength, scale, knockout, quality /*0-1 float*/, distance /*px, fixed at creation*/);
```
- Camera filters: `camera.filters.internal` / `camera.filters.external` (FilterList; always present on Camera, no enable call).
  FilterList methods include `addGlow, addBlur, addThreshold, addBlend, addParallelFilters, addColorMatrix, addVignette, addBarrel, addPixelate, addMask...`.
- There is NO Phaser 3 `postFX.addBloom`/`preFX`. `Actions.AddEffectBloom` replaces it. Manual equivalent: `addParallelFilters()` then `top.addThreshold()` + `top.addBlur()`.
- Internal = before camera transform (object space); external = after (screen space, full res). Camera bloom uses external.
- Bloom works best full-screen, over a dark background; the Graphics glow filter looks noisy/grainy on thin strokes (the orange outline in the spike), so prefer camera bloom for shapes.

### Bloom on the game layer but NOT on UI (verified: text crisp)
```ts
const main = this.cameras.main;               // game layer; bloom applied here
Actions.AddEffectBloom(main, {...});
const uiCam = this.cameras.add(0, 0, 720, 1280); // second camera, no filters, transparent background
main.ignore(uiObjects);   // array of GameObjects (or a Layer/Group)
uiCam.ignore(gameObjects);
```
Every object created must be ignored by one of the two cameras (keep two arrays `gameLayer` / `uiLayer`, or put UI in a `this.add.layer()` and `main.ignore(layer)`).
Objects created later (popups, particles) must be added to the right list too. Camera without bloom + `BlendModes.ADD` objects: ADD only blends within its own camera pass.

## 2. Blend modes
```ts
import { BlendModes } from 'phaser';
// NORMAL 0, ADD 1, MULTIPLY 2, SCREEN 3, OVERLAY 4, DARKEN.., ERASE, SKIP_CHECK -1
g.setBlendMode(BlendModes.ADD);   // Graphics, Image, Arc, Text... (also accepts 'ADD')
```
Particle emitter config accepts `blendMode: 'ADD'` (string) and it worked. Overlapping ADD circles sum to white (visible in the spike).
New in v4: tint modes (`setTintMode`) MULTIPLY/FILL/ADD/SCREEN/OVERLAY/HARD_LIGHT.

## 3. Particle emitter with trail
```ts
// texture must exist: Graphics -> generateTexture
const pg = this.make.graphics({ x: 0, y: 0 }, false);
pg.fillStyle(0xffffff).fillCircle(8, 8, 8); pg.generateTexture('dot', 16, 16); pg.destroy();

const mover = this.add.circle(100, 420, 6, 0xffffff).setBlendMode(BlendModes.ADD);
const emitter = this.add.particles(0, 0, 'dot', {   // returns ParticleEmitter (no manager in v4 either)
    follow: mover,                 // or emitter.startFollow(obj)
    frequency: 10,                 // ms between emits (flow mode)
    lifespan: { min: 500, max: 900 },
    speed: { min: 10, max: 50 }, angle: { min: 0, max: 360 },
    scale: { start: 0.9, end: 0 }, alpha: { start: 0.9, end: 0 },
    tint: [0x22e6ff, 0xb44dff, 0xff4de1],   // random pick per particle
    blendMode: 'ADD',
});
```
All keys worked as in v3. Move the followed object each frame (`update`); particles stay in world space = a trail.
Trail length = lifespan; for a "goo stream" emit along a path with `emitZone` / `emitter.setPosition`, or spawn emitters per segment.

## 4. Custom fragment shader GameObject
```ts
const bg = this.add.shader(
    {
        name: 'nebula',                 // REQUIRED, unique. (shaderName optional)
        fragmentSource: GLSL,           // or fragmentKey from this.load.glsl
        initialUniforms: { uTime: 0, uRes: [720, 1280] },
        setupUniforms: (setUniform: (n: string, v: unknown) => void) => {   // runs every render
            setUniform('uTime', this.time.now / 1000);
        },
    },
    360, 640, 720, 1280,   // x, y (CENTER origin), w, h
);
```
GLSL (WebGL1 style): declare `precision mediump float; varying vec2 outTexCoord;` (0,0 = bottom-left, 0..1 across the quad) and your own `uniform`s;
write `gl_FragColor`. Vertex shader and `uProjectionMatrix` are supplied. Gotchas:
- v3 signature `add.shader(key, x, y, w, h)` still works only with a cached key; v3 `shader.setUniform` / `uniforms.time.value` style is replaced by `setupUniforms` / `setUniform(name, value)`.
- Config `name` is required; no alpha on the object (do it in GLSL); each Shader is its own draw call (fine for 1 background).
- It is a normal GameObject, so camera bloom applies to it too (kept subtle in the spike). To exclude it, put it on a separate camera.
- Chromatic aberration: use a filter instead (see `FilterList.addBarrel/addDisplacement`) or a Shader with `textures` + `CaptureFrame`; not tested in this spike.

## 5. 48x48 board in a DynamicTexture, redrawn every frame
```ts
// once: a white rounded tile (14px), tinted per cell
const tg = this.make.graphics({ x: 0, y: 0 }, false);
tg.fillStyle(0xffffff).fillRoundedRect(0, 0, 14, 14, 4); tg.generateTexture('tile', 14, 14); tg.destroy();
const board = this.textures.addDynamicTexture('board', 48 * 14, 48 * 14)!;   // returns DynamicTexture | null
this.add.image(cx, cy, 'board');          // use as a normal texture (or this.add.renderTexture, same underlying class)

// each frame
board.clear();
for (...) board.stamp('tile', undefined, c * 14, r * 14, { tint: color, originX: 0, originY: 0, scale: 0.92 });
board.render();                           // REQUIRED in v4: draw/stamp/fill/clear only record into a command buffer
```
- **v4 difference:** DynamicTexture/RenderTexture commands are buffered; nothing appears until `render()` (v3 drew immediately; `beginDraw/endDraw` are gone).
  `board.preserve(true)` keeps the buffer between renders (not needed if you clear+redraw). `RenderTexture#setRenderMode('redraw'|'render'|'all')`.
- `stamp(key, frame, x, y, {tint, alpha, scale, originX, originY, angle, blendMode})` is the cheap path for 2304 tinted sprites; `fill(rgb, alpha, x, y, w, h)` for rects; `draw(gameObjectOrFrame, x, y)` for objects.
  Tinting is multiply on a white tile, so unlit/colored variants should come from tint or separate baked frames.
- Headless software-GL: ~60 FPS with 2304 stamps/frame + 40 random cell changes. Real device unverified.
- Optimisation if needed: only restamp dirty cells with `preserve(true)` (no `clear()`), or bake static board once and animate only changed cells.

## 6. Font (Orbitron, self-hosted)
```
bun add @fontsource/orbitron
```
`src/main.ts`: `import '@fontsource/orbitron/400.css'; import '@fontsource/orbitron/700.css';`
`Preloader.create()` waits: `await Promise.all([document.fonts.load('700 28px Orbitron'), document.fonts.load('400 28px Orbitron')])` then starts the next scene.
Use: `this.add.text(x, y, '0123456789', { fontFamily: 'Orbitron', fontStyle: '700', fontSize: '32px', color: '#e8f6ff' })`.
Gotchas: Phaser Text bakes a canvas at creation, so creating text before the font loads renders the fallback font permanently (call `setText`/recreate to fix).
Fontsource splits by weight and unicode-range (latin file is fetched lazily on first use, hence `document.fonts.load`). Digits render fine. Text lives on the UI camera, so it stays unbloomed.

## Other gotchas
- Types: `obj.filters` is `FiltersInternalExternal | null` on GameObjects (non-null on Camera). `setupUniforms` params are untyped in d.ts, annotate manually.
- Phaser 4 textures are Y-up for shader coords; `outTexCoord` y=0 is the bottom.
- `this.textures.addDynamicTexture` can return null if the key exists, remove the key first on scene restart (`this.textures.remove('board')`).

## Phase 4 learnings (visual pass)

- **Camera split via `cameraFilter`, not layers.** `src/phaser/fx/CameraRig.ts` listens to `scene.sys.events` `'addedtoscene'`
  and tags every new object as game-layer (`obj.cameraFilter = uiCam.id`). `ui(obj)` sets `main.id`. Container children are
  checked with `child.willRender(camera)`, which ANDs the child's own filter with the parent's (`displayList.willRender`),
  so `ui()`/`game()` must recurse into Container children, and a container that mixes bloomed art and crisp text must
  be `both()` (filter 0) with each child tagged. Content added to a UI container later must be re-tagged (`ui(root)` again).
- Consequence of the split: ALL UI-camera objects draw above ALL game-camera objects regardless of depth. Pod labels can
  overlap other pods during slides; hide labels on pods that fly over other UI.
- **Custom filter works** (`src/phaser/fx/ChromaFilter.ts`): `class X extends Renderer.WebGL.RenderNodes.BaseFilterShader`
  (`super(name, manager, undefined, fragSource)`, override `setupUniforms(controller)` using `this.programManager.setUniform`),
  register once with `renderer.renderNodes.addNodeConstructor(name, X)`, and a `class C extends Filters.Controller`
  (`super(camera, name)`) added with `camera.filters.external.add(c)`. Keep `#pragma phaserTemplate(shaderName)` and
  `#pragma phaserTemplate(fragmentHeader)` in the GLSL. Set `controller.active = false` when idle.
- **Shader with textures:** `scene.add.shader(config, x, y, w, h, [texKeyA, texKeyB])`, then in `setupUniforms`
  `setUniform('uA', 0); setUniform('uB', 1)`. Sampling a DynamicTexture with `outTexCoord` came out the right way up (no flip needed).
- **Low-res shader into a texture:** create the Shader, `removeFromDisplayList()`, `setRenderToTexture(key)`, show an Image of
  `key` scaled up, and call `shader.renderImmediate()` every N frames from `update` (nebula: 180x320, every 4th frame). Works.
- **DynamicTexture incremental redraw:** the framebuffer persists between `render()` calls (`autoClear: false`), so
  `tex.clear(x, y, w, h)` + `render()` erases one cell; no `preserve(true)` needed (that keeps the *command buffer*).
- **Particles per-particle color with one emitter:** `tint: { onEmit: () => this.color, onUpdate: (_p, _k, _t, v) => v }`
  (a plain static `tint` op overwrites `particle.tint` every update). Same trick for scale (`onUpdate` from a base stored in
  `emitCallback`). `emitParticleAt(x, y, n)` + `maxAliveParticles` gives a cheap, capped, multi-color trail emitter.
- `Actions.AddEffectBloom` returns an array; toggle `bloom.parallelFilters.active` for the reduced-effects setting.
- `camera.flash` is a full-opacity fill: too harsh for win/overload. Use a full-screen Rectangle tweened from alpha ~0.4.
- Headless testing: **never run two `tools/dev/interact.ts` / `shot` sessions at once**; the second Firefox hangs.
  A `pkill -f interact.ts` inside a Bash call also kills that call's own shell.
- Headless FPS (software GL), 60 fps baseline: dev-big 60, kimono-hard 60, dev-big with all 5 lanes tapped repeatedly
  58-60 (~60 live blobs). Real phone still unverified (bloom is the expected cost; `?fx=low` removes it).
