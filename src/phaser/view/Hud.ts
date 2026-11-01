/**
 * Hud (neon, UI camera): top bar with pause button, level name, 1x/2x toggle. In debug mode a second row of small
 * buttons and a status line sit under the title.
 *
 * Public interface the visuals phase must keep:
 *   constructor(scene, { levelName, speed, onPause, onSpeed })
 *   setSpeed(speed)
 *   setDebugLine(text)       small status line (debug only)
 *   addDebugButton(label, onPress) -> Button
 *   destroy()
 */
import type { GameObjects, Scene } from 'phaser';
import { LOGICAL_W } from '@game/layout';
import type { GameSpeed } from '@game/gameFacade';
import { COLORS, DEPTH, font } from '../theme';
import { Button } from '../ui/Button';
import { ui } from '../fx/CameraRig';

export interface HudOptions {
    levelName: string;
    speed: GameSpeed;
    onPause: () => void;
    onSpeed: (next: GameSpeed) => void;
}

export class Hud {
    private readonly pause: Button;
    private readonly speedButton: Button;
    private readonly title: GameObjects.Text;
    private readonly bar: GameObjects.Graphics;
    private debugText: GameObjects.Text | null = null;
    private readonly debugButtons: Button[] = [];
    private speed: GameSpeed;

    constructor(
        private readonly scene: Scene,
        opts: HudOptions,
    ) {
        this.speed = opts.speed;
        this.bar = ui(scene.add.graphics().setDepth(DEPTH.hud - 1));
        this.bar.fillStyle(0x05030c, 0.82);
        this.bar.fillRect(0, 0, LOGICAL_W, 88);
        this.bar.lineStyle(6, COLORS.frame, 0.08);
        this.bar.lineBetween(0, 88, LOGICAL_W, 88);
        this.bar.lineStyle(1.5, COLORS.frame, 0.55);
        this.bar.lineBetween(0, 88, LOGICAL_W, 88);
        this.bar.fillStyle(COLORS.frame, 0.9);
        this.bar.fillRect(LOGICAL_W / 2 - 40, 87, 80, 3);
        this.pause = new Button(scene, { x: 62, y: 33, w: 92, h: 52, label: 'II', onPress: opts.onPause, fontSize: 28, depth: DEPTH.hud, edge: COLORS.frame });
        this.speedButton = new Button(scene, {
            x: LOGICAL_W - 62,
            y: 33,
            edge: COLORS.frame,
            w: 92,
            h: 52,
            label: `${opts.speed}x`,
            fontSize: 28,
            depth: DEPTH.hud,
            onPress: () => opts.onSpeed(this.speed === 1 ? 2 : 1),
        });
        this.title = ui(scene.add.text(LOGICAL_W / 2, 33, opts.levelName.toUpperCase(), { ...font(26), letterSpacing: 2 }).setOrigin(0.5).setDepth(DEPTH.hud));
        const max = 420;
        if (this.title.width > max) this.title.setScale(max / this.title.width);
    }

    setSpeed(speed: GameSpeed): void {
        this.speed = speed;
        this.speedButton.setLabel(`${speed}x`);
    }

    setDebugLine(text: string): void {
        if (this.debugText === null) {
            this.debugText = ui(this.scene.add.text(LOGICAL_W / 2, 80, '', font(14, '#ffe600', false)).setOrigin(0.5).setDepth(DEPTH.hud));
        }
        this.debugText.setText(text);
    }

    addDebugButton(label: string, onPress: () => void): Button {
        const w = 76;
        const gap = 6;
        const i = this.debugButtons.length;
        const b = new Button(this.scene, { x: 130 + i * (w + gap) + w / 2, y: 58, w, h: 22, label, onPress, fontSize: 13, depth: DEPTH.hud, minHit: 0 });
        this.debugButtons.push(b);
        return b;
    }

    destroy(): void {
        this.pause.destroy();
        this.speedButton.destroy();
        this.title.destroy();
        this.bar.destroy();
        this.debugText?.destroy();
        for (const b of this.debugButtons) b.destroy();
        this.debugButtons.length = 0;
    }
}
