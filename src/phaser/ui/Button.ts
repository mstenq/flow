/**
 * Neon button: a center-anchored Container with a glassy face + glowing edge, a label, and a Zone child as the hit
 * target (AGENTS.md: never custom-rect the Container). Fires on release if the pointer is still over the button.
 * The hit Zone is at least `MIN_HIT` px in each direction even when the face is smaller (phone touch targets).
 * Lives on the crisp UI camera when the scene has a CameraRig.
 */
import type { GameObjects, Scene } from 'phaser';
import { COLORS, font } from '../theme';
import { ui } from '../fx/CameraRig';
import { audioDirector } from '../audio';

export interface ButtonOptions {
    x: number;
    y: number;
    w: number;
    h: number;
    label: string;
    onPress: () => void;
    fontSize?: number;
    fill?: number;
    edge?: number;
    textColor?: string;
    depth?: number;
    /** Minimum hit-area size in logical px (default `MIN_HIT`). The face keeps its own size; only the Zone grows. */
    minHit?: number;
}

/** 720 px logical width is ~390 px on a phone (scale ~0.54), so 84 logical px stays >= 44 px of finger target. */
export const MIN_HIT = 84;

export class Button {
    readonly container: GameObjects.Container;
    private readonly face: GameObjects.Graphics;
    private readonly text: GameObjects.Text;
    private readonly zone: GameObjects.Zone;
    private readonly opts: ButtonOptions;
    private down = false;
    private enabled = true;

    constructor(scene: Scene, opts: ButtonOptions) {
        this.opts = opts;
        this.container = scene.add.container(opts.x, opts.y);
        if (opts.depth !== undefined) this.container.setDepth(opts.depth);
        this.face = scene.add.graphics();
        this.text = scene.add
            .text(0, 0, opts.label, font(opts.fontSize ?? 26, opts.textColor ?? COLORS.text))
            .setOrigin(0.5);
        const minHit = opts.minHit ?? MIN_HIT;
        this.zone = scene.add.zone(0, 0, Math.max(opts.w, minHit), Math.max(opts.h, minHit));
        this.container.add([this.face, this.text, this.zone]);
        ui(this.container);
        this.zone.setInteractive({ useHandCursor: true });
        this.zone.on('pointerdown', () => this.setDown(true));
        this.zone.on('pointerout', () => this.setDown(false));
        this.zone.on('pointerup', () => {
            const fire = this.down;
            this.setDown(false);
            if (!fire) return;
            audioDirector.onUiClick();
            opts.onPress();
        });
        this.draw(false);
        this.fitText();
    }

    setLabel(label: string): void {
        this.text.setText(label);
        this.fitText();
    }

    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
        if (enabled) this.zone.setInteractive({ useHandCursor: true });
        else this.zone.disableInteractive();
        this.container.setAlpha(enabled ? 1 : 0.45);
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    destroy(): void {
        this.container.destroy();
    }

    private setDown(down: boolean): void {
        if (this.down === down) return;
        this.down = down;
        this.draw(down);
        this.container.setScale(down ? 0.96 : 1);
    }

    private draw(down: boolean): void {
        const { w, h, fill = 0x0d0a26, edge = 0x4a46a0 } = this.opts;
        const r = Math.min(14, h * 0.3);
        const g = this.face;
        g.clear();
        g.lineStyle(7, edge, down ? 0.35 : 0.14);
        g.strokeRoundedRect(-w / 2 - 1, -h / 2 - 1, w + 2, h + 2, r + 1);
        g.fillStyle(down ? edge : fill, down ? 0.55 : 0.88);
        g.fillRoundedRect(-w / 2, -h / 2, w, h, r);
        g.fillStyle(0xffffff, 0.05);
        g.fillRoundedRect(-w / 2 + 3, -h / 2 + 3, w - 6, h * 0.42, r * 0.8);
        g.lineStyle(2, edge, 1);
        g.strokeRoundedRect(-w / 2, -h / 2, w, h, r);
    }

    private fitText(): void {
        const max = this.opts.w - 16;
        this.text.setScale(this.text.width > max ? max / this.text.width : 1);
    }
}
