**Never use `npm`, `npx`, or `yarn`.** Use `bun` / `bunx` exclusively.


## Architecture (constitution only)

```
src/game/       # Pure game logic — no Phaser game objects (see exceptions)
src/phaser/     # Scenes, UI, animations, asset preload
src/data/       # Typed defs (items, events, bosses, …)
public/assets/  # Art
```

**Logic/render split:** `src/game/` must not import Phaser scenes or sprites. Allowed Phaser imports in `src/game/`: `main.ts`, `config.ts`, `EventBus.ts` only.

**Orchestration:** Phaser scenes call **`gameFacade`**, not `*System.ts` directly. Gameplay animations go through **`enqueuePlayback`** / `PlaybackRunner` — scenes must not drive outcome animations themselves. State: `getRunState()` / `getRoundState()` / `getSceneState()` and matching `*Actions`.

## Key patterns

### TypeScript

- **No inline type imports** (`import('./x').Foo`). Use top-level `import type { Foo } from '...'`.

### Control flow

- Prefer **guard clauses** (early `return` / `continue`) over nested `if` blocks.
- Avoid deep nesting; flatten with guards or a small named helper when a branch grows.


**Pre-ship: no backwards compatibility.** The game has not shipped; old local saves are disposable. Do not preserve compatibility with renamed or removed ids.

## Phaser gotchas

### Container hit areas

**Preferred:** put a **`Zone` child** at `(0, 0)` with face `width`/`height` and wire pointer events on the zone — not on the Container. Zone origin is center-based and aligns with center-anchored `fillRoundedRect(-w/2, -h/2, w, h)` without manual `Rectangle` math. See `Button.ts`, `ToggleCheckbox.ts`.

```ts
// ✅ Preferred — center-anchored Container + Zone hit target
const hitZone = scene.add.zone(0, 0, w, h);
container.add([, /* graphics */ hitZone]);
hitZone.setInteractive({ useHandCursor: true });
hitZone.on('pointerdown', onPress);
```

**If you must use `container.setInteractive`:** after `setSize(w, h)`, custom hit rects are easy to get wrong (symptoms: shifted up-left, or only the label clickable). Avoid guessing offsets when children are center-anchored or visually offset.

| Pattern               | Child draw                          | Container hit rect (legacy — prefer Zone)                                               |
| --------------------- | ----------------------------------- | --------------------------------------------------------------------------------------- |
| **Center-anchored**   | `fillRoundedRect(-w/2, -h/2, w, h)` | try `setSize` + `setInteractive({ useHandCursor: true })` with **no** custom rect first |
| **Top-left children** | `fillRoundedRect(0, 0, w, h)`       | see `DicePouch.ts`                                                                      |

```ts
// ❌ WRONG — custom rects on Containers are fragile; use a Zone instead
container.setInteractive(new Phaser.Geom.Rectangle(0, 0, w, h), Phaser.Geom.Rectangle.Contains);
container.setInteractive(new Phaser.Geom.Rectangle(-w / 2, -h / 2, w, h), Phaser.Geom.Rectangle.Contains);
```

**Motion vs hit area:** decorative depth offset on `Button` does not change the Zone size — match the **face** only. Interaction tweens target `faceContainer`, not the Zone.


## Skills

`.agents/skills/`: `phaser`, `particles`, `sprites-and-images`, `v4-new-features`, `game-designer`, `game-ui-design`
