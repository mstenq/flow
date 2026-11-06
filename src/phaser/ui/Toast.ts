import type { GameObjects, Scene } from 'phaser';
import { COLORS, DEPTH, font } from '../theme';
import { ui } from '../fx/CameraRig';

/** One-line message that fades out (denied-tap reasons). */
export class Toast {
    private readonly text: GameObjects.Text;

    constructor(private readonly scene: Scene, x: number, y: number) {
        this.text = ui(scene.add.text(x, y, '', { ...font(22, COLORS.bad), stroke: '#05030c', strokeThickness: 5 }).setOrigin(0.5).setDepth(DEPTH.toast).setAlpha(0));
    }

    /** Visible (or still fading out). */
    get isShowing(): boolean {
        return this.text.alpha > 0.01;
    }

    show(message: string, color: string = COLORS.bad): void {
        this.scene.tweens.killTweensOf(this.text);
        this.text.setText(message).setColor(color).setAlpha(1);
        this.scene.tweens.add({ targets: this.text, alpha: 0, delay: 900, duration: 400 });
    }

    destroy(): void {
        this.scene.tweens.killTweensOf(this.text);
        this.text.destroy();
    }
}
