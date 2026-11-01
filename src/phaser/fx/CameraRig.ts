/**
 * Two cameras: `main` renders the game layer with one bloom pass (+ an idle chromatic-aberration filter),
 * `uiCam` renders UI on top with no filters, so text stays crisp and legible over the glow.
 *
 * Every Game Object added to the scene defaults to the game layer. Call `ui(obj)` for UI objects
 * (Text, HUD, overlays). Children of a Container inherit the container's camera filter, so a container that mixes
 * game art and UI text should stay on both cameras (`both(container)`) with each child tagged.
 */
import { Actions, GameObjects } from 'phaser';
import type { Cameras, Scene, Types } from 'phaser';
import { LOGICAL_H, LOGICAL_W } from '@game/layout';
import { addChromaFilter } from './ChromaFilter';
import type { ChromaController } from './ChromaFilter';
import { isReducedFx, onReducedFxChange } from './fxSettings';

type Bloom = Types.Actions.AddEffectBloomReturn;

interface Tagged {
    cameraFilter: number;
}

export class CameraRig {
    readonly main: Cameras.Scene2D.Camera;
    readonly uiCam: Cameras.Scene2D.Camera;
    private bloom: Bloom | null = null;
    private chroma: ChromaController | null = null;
    private wash: GameObjects.Rectangle | null = null;
    private chromaMs = 0;
    private chromaTotal = 1;
    private chromaPeak = 0;
    private readonly tagged = new WeakSet<object>();
    private readonly offFx: () => void;

    constructor(private readonly scene: Scene) {
        this.main = scene.cameras.main;
        this.uiCam = scene.cameras.add(0, 0, LOGICAL_W, LOGICAL_H, false, 'ui');
        for (const obj of scene.children.list) this.game(obj);
        scene.sys.events.on('addedtoscene', this.onAdded, this);
        this.applyBloom(!isReducedFx());
        this.chroma = addChromaFilter(this.main);
        this.offFx = onReducedFxChange((reduced) => this.applyBloom(!reduced));
        activeRig = this;
        scene.events.once('shutdown', () => this.destroy());
    }

    /** Render only on the crisp UI camera (recurses into Container children). */
    ui<T extends GameObjects.GameObject>(obj: T): T {
        this.setFilter(obj, this.main.id);
        return obj;
    }

    /** Render only on the bloomed game camera (the default; recurses into Container children). */
    game<T extends GameObjects.GameObject>(obj: T): T {
        this.setFilter(obj, this.uiCam.id);
        return obj;
    }

    /** Render on both cameras (containers whose children pick their own camera). */
    both<T extends GameObjects.GameObject>(obj: T): T {
        (obj as unknown as Tagged).cameraFilter = 0;
        this.tagged.add(obj);
        return obj;
    }

    shake(ms: number, intensity: number): void {
        this.main.shake(ms, intensity);
        this.uiCam.shake(ms, intensity * 0.6);
    }

    /** Full-screen color wash on the game layer that fades out (`alpha` peak, so it never blinds). */
    flash(ms: number, r: number, g: number, b: number, alpha = 0.45): void {
        const wash = this.wash ?? this.makeWash();
        this.scene.tweens.killTweensOf(wash);
        wash.setFillStyle((r << 16) | (g << 8) | b, 1).setAlpha(alpha).setVisible(true);
        this.scene.tweens.add({ targets: wash, alpha: 0, duration: ms, ease: 'Quad.easeOut', onComplete: () => wash.setVisible(false) });
    }

    private makeWash(): GameObjects.Rectangle {
        const wash = this.scene.add.rectangle(LOGICAL_W / 2, LOGICAL_H / 2, LOGICAL_W, LOGICAL_H, 0xffffff, 1).setDepth(90).setScrollFactor(0).setVisible(false);
        this.game(wash);
        this.wash = wash;
        return wash;
    }

    /** Brief chromatic aberration pulse (decays to zero). */
    chromaPulse(ms: number, amount: number): void {
        if (!this.chroma) return;
        this.chromaMs = ms;
        this.chromaTotal = ms;
        this.chromaPeak = amount;
        this.chroma.active = true;
    }

    update(dtMs: number): void {
        if (!this.chroma || this.chromaMs <= 0) return;
        this.chromaMs -= dtMs;
        if (this.chromaMs <= 0) {
            this.chroma.amount = 0;
            this.chroma.active = false;
            return;
        }
        const t = this.chromaMs / this.chromaTotal;
        this.chroma.amount = this.chromaPeak * t * (0.7 + 0.3 * Math.sin(this.chromaMs / 18));
    }

    destroy(): void {
        this.scene.sys.events.off('addedtoscene', this.onAdded, this);
        this.offFx();
        if (activeRig === this) activeRig = null;
    }

    private setFilter(obj: GameObjects.GameObject, filter: number): void {
        (obj as unknown as Tagged).cameraFilter = filter;
        this.tagged.add(obj);
        if (!(obj instanceof GameObjects.Container)) return;
        for (const child of obj.list) this.setFilter(child, filter);
    }

    private onAdded(obj: GameObjects.GameObject): void {
        if (this.tagged.has(obj)) return;
        this.game(obj);
    }

    private applyBloom(on: boolean): void {
        if (!on) {
            if (this.bloom) this.bloom.parallelFilters.active = false;
            return;
        }
        if (this.bloom) {
            this.bloom.parallelFilters.active = true;
            return;
        }
        const [bloom] = Actions.AddEffectBloom(this.main, {
            threshold: 0.42,
            blurRadius: 2,
            blurSteps: 4,
            blurQuality: 1,
            blendAmount: 1.15,
        });
        this.bloom = bloom ?? null;
    }
}

let activeRig: CameraRig | null = null;

export function getRig(): CameraRig | null {
    return activeRig;
}

/** Tag a Game Object as UI (crisp camera). No-op when the scene has no rig. */
export function ui<T extends GameObjects.GameObject>(obj: T): T {
    return activeRig ? activeRig.ui(obj) : obj;
}

/** Tag a container that mixes game art and UI children. */
export function both<T extends GameObjects.GameObject>(obj: T): T {
    return activeRig ? activeRig.both(obj) : obj;
}
