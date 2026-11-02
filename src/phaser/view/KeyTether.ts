/**
 * KeyTether: while the player holds a locked pod, a crackling gold bolt runs from the cell holding its key to the
 * pod, and that cell pulses, so the matching key is easy to find on big boards (where the key letter is tiny).
 * Positions are read every redraw, so the bolt follows a pod sliding up its column. It ends on its own when the key
 * is collected or the pod leaves the queue.
 *
 *   show(podId | null)   start (or stop) the tether for a pod
 *   update(dtMs)         per frame
 *   destroy()
 */
import { BlendModes } from 'phaser';
import type { GameObjects, Scene } from 'phaser';
import type { Point2 } from '@game/layout';
import { COLORS, DEPTH } from '../theme';
import type { Fx } from '../fx/Fx';
import { drawLightning } from './podArt';

export interface KeyTetherTargets {
    keyCenterFor(podId: number): Point2 | null;
    podCenter(podId: number): Point2 | null;
}

/** Bolts re-jitter at this interval (same crackle rate as the linked-pod tethers). */
const REDRAW_MS = 55;
/** One bolt segment per this many pixels of tether. */
const SEGMENT_PX = 26;

export class KeyTether {
    private readonly gfx: GameObjects.Graphics;
    private podId: number | null = null;
    private redrawMs = 0;
    private ageMs = 0;

    constructor(
        scene: Scene,
        private readonly targets: KeyTetherTargets,
        private readonly cell: number,
        private readonly fx?: Fx,
    ) {
        this.gfx = scene.add.graphics().setDepth(DEPTH.fx).setBlendMode(BlendModes.ADD);
    }

    show(podId: number | null): void {
        if (podId === this.podId) return;
        this.podId = podId;
        this.gfx.clear();
        if (podId === null) return;
        this.ageMs = 0;
        this.redrawMs = REDRAW_MS;
        const from = this.targets.keyCenterFor(podId);
        if (!from) {
            this.podId = null;
            return;
        }
        this.fx?.flash(from.x, from.y, COLORS.key, Math.max(60, this.cell * 3), 260);
        this.fx?.ring(from.x, from.y, COLORS.key, Math.max(40, this.cell * 2.5), 420, 0.9, this.cell * 0.5);
    }

    update(dtMs: number): void {
        if (this.podId === null) return;
        this.ageMs += dtMs;
        this.redrawMs += dtMs;
        if (this.redrawMs < REDRAW_MS) return;
        this.redrawMs = 0;
        const from = this.targets.keyCenterFor(this.podId);
        const to = this.targets.podCenter(this.podId);
        if (!from || !to) {
            this.show(null);
            return;
        }
        const g = this.gfx;
        g.clear();
        const segments = Math.max(6, Math.round(Math.hypot(to.x - from.x, to.y - from.y) / SEGMENT_PX));
        drawLightning(g, from.x, from.y, to.x, to.y, segments, 14, COLORS.key, 2.4, 1);
        drawLightning(g, from.x, from.y, to.x, to.y, segments, 22, COLORS.key, 1.2, 0.55);
        // The key cell: a pulsing target so it reads even when cells are a few pixels wide.
        const pulse = 0.5 + 0.5 * Math.sin(this.ageMs / 120);
        const r = Math.max(9, this.cell * 0.75);
        g.lineStyle(3, COLORS.key, 0.5 + 0.5 * pulse);
        g.strokeCircle(from.x, from.y, r + 4 * pulse);
        g.lineStyle(1.5, 0xffffff, 0.9);
        g.strokeCircle(from.x, from.y, r * 0.7);
        g.fillStyle(0xffffff, 0.9);
        g.fillCircle(to.x, to.y, 3);
    }

    destroy(): void {
        this.gfx.destroy();
    }
}
