/**
 * Win and overload sequences (driven by PlaybackRunner). Each calls `done` once it has finished, so the Result
 * overlay only appears after the show.
 */
import type { Layout } from '@game/layout';
import { LOGICAL_W } from '@game/layout';
import type { BoardView } from '../view/BoardView';
import type { LaneView } from '../view/LaneView';
import type { NeonGrid } from '../view/NeonGrid';
import type { QueueView } from '../view/QueueView';
import { COLORS, DEPTH, font } from '../theme';
import type { CameraRig } from './CameraRig';
import type { Fx } from './Fx';

export interface SequenceTargets {
    layout: Layout;
    palette: number[];
    board: BoardView;
    fx: Fx;
    rig: CameraRig;
    grid?: NeonGrid;
}

export interface OverloadTargets extends SequenceTargets {
    lanes: LaneView;
    queue: QueueView;
}

const WIN_MS = 2300;
const OVERLOAD_MS = 1500;

export function playWinSequence(t: SequenceTargets, done: () => void): void {
    const scene = t.rig.main.scene;
    const { rect } = t.layout.board;
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    const frame = t.board.frameRect();
    t.board.flare(1100);
    t.grid?.applyImpulse(cx, cy, 1100, 760);
    t.fx.flash(cx, cy, 0xffffff, Math.max(rect.w, rect.h) * 1.6, 420, 0.75);
    t.fx.ring(cx, cy, 0xffffff, 520, 700, 0.8, 40);
    t.fx.ring(cx, cy, COLORS.frame, 760, 900, 0.6, 20);
    // Sparks race around the frame.
    for (let i = 0; i < 24; i++) {
        const side = i % 4;
        const f = (i * 0.37) % 1;
        const x = side === 0 ? frame.x + frame.w * f : side === 1 ? frame.x + frame.w : side === 2 ? frame.x + frame.w * (1 - f) : frame.x;
        const y = side === 0 ? frame.y : side === 1 ? frame.y + frame.h * f : side === 2 ? frame.y + frame.h : frame.y + frame.h * (1 - f);
        t.fx.burst(x, y, 0xffffff, { count: 3, speedMin: 40, speedMax: 200, scale: 0.5, life: 500 });
    }
    t.fx.fireworks(cx, cy, rect.w * 0.9, rect.h * 0.8, t.palette, Math.max(12, t.palette.length * 3));
    scene.time.delayedCall(250, () => t.board.showHologram(1700));
    celebrate(t.rig, 'CLEAR!', COLORS.good, WIN_MS - 300);
    scene.time.delayedCall(WIN_MS, done);
}

export function playOverloadSequence(t: OverloadTargets, done: () => void): void {
    const scene = t.rig.main.scene;
    const { rect } = t.layout.board;
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    t.lanes.overload();
    t.queue.crackAll();
    t.board.setFrameHeat(1);
    t.rig.shake(520, 0.016);
    t.rig.chromaPulse(800, 0.045);
    t.rig.flash(420, 255, 30, 60, 0.4);
    t.grid?.applyImpulse(cx, cy, -1500, 900);
    t.fx.ring(cx, cy, COLORS.frameHot, 40, 600, 0.9, 600);
    scene.time.delayedCall(260, () => {
        t.rig.chromaPulse(500, 0.03);
        t.grid?.applyImpulse(cx, cy, -700, 600);
    });
    celebrate(t.rig, 'OVERLOAD', COLORS.bad, OVERLOAD_MS - 200);
    scene.time.delayedCall(OVERLOAD_MS, done);
}

/** Big crisp banner on the UI camera that glitches in and fades out. */
function celebrate(rig: CameraRig, message: string, color: string, ms: number): void {
    const scene = rig.main.scene;
    const text = rig.ui(
        scene.add
            .text(LOGICAL_W / 2, 440, message, { ...font(84, color), stroke: '#05030c', strokeThickness: 10 })
            .setOrigin(0.5)
            .setDepth(DEPTH.celebrate)
            .setScale(1.6, 0.05)
            .setAlpha(0),
    );
    const max = LOGICAL_W - 60;
    const fit = text.width > max ? max / text.width : 1;
    scene.tweens.add({ targets: text, scaleX: fit, scaleY: fit, alpha: 1, duration: 260, ease: 'Back.easeOut' });
    scene.tweens.add({ targets: text, alpha: 0, scaleY: 0.05 * fit, delay: ms - 220, duration: 220, ease: 'Quad.easeIn', onComplete: () => text.destroy() });
}
