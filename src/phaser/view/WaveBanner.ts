/**
 * WaveBanner (neon, UI camera): the one-line "FILL 2 MORE LANES TO START" pill on fill-first levels while the board
 * waits for the player. It sits on the toast line between the lanes and the queue, so it never covers the board, a
 * lane or a queued pod (players need every row of the art to plan). It breathes gently while it waits, pops when the
 * count of empty lanes changes, and flashes out when the wave starts. A denied-tap toast on the same line, or a
 * modal, covers it without losing the shown state. Not interactive.
 *
 * Public interface:
 *   constructor(scene, x, y)
 *   show(emptyLanes)     fade/scale in (or just update the count when already shown)
 *   hide(quick?)         fade out; `quick` is the wave-start dismissal
 *   setCovered(on)       hide under a modal or a toast without losing the shown state
 *   update(dtMs)         pulse
 *   destroy()
 */
import type { GameObjects, Scene } from 'phaser';
import { COLORS, DEPTH, font } from '../theme';
import { ui } from '../fx/CameraRig';

/** Fits the toast line (912-940) between the lane tray and the front pods. */
const PILL_H = 26;
const PAD_X = 18;

export class WaveBanner {
    private readonly root: GameObjects.Container;
    private readonly plate: GameObjects.Graphics;
    private readonly label: GameObjects.Text;
    private shown = false;
    private covered = false;
    private lastCount = -1;
    private timeS = 0;

    constructor(
        private readonly scene: Scene,
        x: number,
        y: number,
    ) {
        this.plate = scene.add.graphics();
        this.label = scene.add.text(0, 0, '', { ...font(17, COLORS.accent), stroke: '#05030c', strokeThickness: 4, letterSpacing: 2 }).setOrigin(0.5);
        this.root = ui(scene.add.container(x, y, [this.plate, this.label]).setDepth(DEPTH.toast - 1).setAlpha(0).setVisible(false));
    }

    show(emptyLanes: number): void {
        if (emptyLanes !== this.lastCount) {
            this.lastCount = emptyLanes;
            this.label.setText(emptyLanes === 1 ? 'FILL 1 MORE LANE TO START' : `FILL ${emptyLanes} MORE LANES TO START`);
            this.drawPlate(this.label.width + PAD_X * 2);
            if (this.shown) this.pop();
        }
        if (this.shown) return;
        this.shown = true;
        this.scene.tweens.killTweensOf(this.root);
        this.root.setVisible(!this.covered).setAlpha(0).setScale(0.9);
        this.scene.tweens.add({ targets: this.root, alpha: 1, scale: 1, duration: 220, ease: 'Back.easeOut' });
    }

    hide(quick = false): void {
        this.lastCount = -1;
        if (!this.shown) return;
        this.shown = false;
        this.scene.tweens.killTweensOf(this.root);
        this.scene.tweens.add({
            targets: this.root,
            alpha: 0,
            scale: quick ? 1.12 : 0.94,
            duration: quick ? 140 : 200,
            ease: quick ? 'Quad.easeOut' : 'Quad.easeIn',
            onComplete: () => this.root.setVisible(false),
        });
    }

    /** A modal (its translucent panel would show the pill through it) or a toast on the same line is up. */
    setCovered(on: boolean): void {
        if (on === this.covered) return;
        this.covered = on;
        this.root.setVisible(this.shown && !on);
    }

    update(dtMs: number): void {
        if (!this.shown) return;
        this.timeS += dtMs / 1000;
        const pulse = 0.5 + 0.5 * Math.sin(this.timeS * 3.2);
        this.plate.setAlpha(0.75 + 0.25 * pulse);
        this.label.setAlpha(0.8 + 0.2 * pulse);
    }

    destroy(): void {
        this.scene.tweens.killTweensOf([this.root, this.label]);
        this.root.destroy();
    }

    /** The empty-lane count changed: a quick bump. */
    private pop(): void {
        this.scene.tweens.killTweensOf(this.label);
        this.label.setScale(1.2);
        this.scene.tweens.add({ targets: this.label, scale: 1, duration: 200, ease: 'Back.easeOut' });
    }

    private drawPlate(w: number): void {
        const g = this.plate;
        const r = PILL_H / 2;
        g.clear();
        g.fillStyle(0x05030c, 0.9);
        g.fillRoundedRect(-w / 2, -r, w, PILL_H, r);
        g.lineStyle(6, COLORS.frame, 0.12);
        g.strokeRoundedRect(-w / 2, -r, w, PILL_H, r);
        g.lineStyle(1.5, COLORS.frame, 0.85);
        g.strokeRoundedRect(-w / 2, -r, w, PILL_H, r);
    }
}
