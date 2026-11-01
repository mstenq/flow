/**
 * Full-screen modal used for Pause and Result (UI camera). A Zone swallows input to everything underneath; content
 * is rebuilt on every `show()`. The panel powers on like a CRT: a bright horizontal line that snaps open
 * vertically with a brief flicker, under faint scanlines.
 */
import { BlendModes } from 'phaser';
import type { GameObjects, Scene } from 'phaser';
import { LOGICAL_H, LOGICAL_W } from '@game/layout';
import { hexToNum } from '@data/themeColors';
import { COLORS, DEPTH, font } from '../theme';
import { ui } from '../fx/CameraRig';
import { TEX } from '../fx/textures';
import { isReducedFx } from '../fx/fxSettings';
import { Button } from './Button';

export interface ModalButton {
    label: string;
    onPress: () => void;
    primary?: boolean;
}

export interface Destroyable {
    destroy: () => void;
}

/** Extra widgets between the lines and the buttons (the settings rows). */
export interface ModalCustom {
    height: number;
    /** Build into `panel` (center-anchored); `top` is the panel-local y where the region starts. Returns what to destroy. */
    build: (panel: GameObjects.Container, top: number) => Destroyable[];
}

export interface ModalContent {
    title: string;
    /** CSS color of the title. */
    titleColor?: string;
    lines?: string[];
    custom?: ModalCustom;
    buttons: ModalButton[];
    /** Pressing anywhere on the dimmed backdrop / panel (outside the buttons) runs this (intro cards: tap to continue). */
    onBackdrop?: () => void;
}

export class ModalOverlay {
    private readonly root: GameObjects.Container;
    private readonly panel: GameObjects.Container;
    private readonly blocker: GameObjects.Zone;
    private readonly dim: GameObjects.Rectangle;
    private content: Destroyable[] = [];
    private buttons: Button[] = [];
    private open = false;
    private backdropHandler: (() => void) | null = null;

    constructor(private readonly scene: Scene) {
        this.root = scene.add.container(0, 0).setDepth(DEPTH.overlay).setVisible(false);
        this.dim = scene.add.rectangle(LOGICAL_W / 2, LOGICAL_H / 2, LOGICAL_W, LOGICAL_H, 0x020108, 0.72);
        this.blocker = scene.add.zone(LOGICAL_W / 2, LOGICAL_H / 2, LOGICAL_W, LOGICAL_H);
        this.panel = scene.add.container(LOGICAL_W / 2, LOGICAL_H / 2);
        this.root.add([this.dim, this.blocker, this.panel]);
        ui(this.root);
        this.blocker.on('pointerdown', () => this.backdropHandler?.());
    }

    get isOpen(): boolean {
        return this.open;
    }

    show(content: ModalContent): void {
        this.clearContent();
        const lines = content.lines ?? [];
        const btnH = 76;
        const btnGap = 18;
        const panelW = 520;
        const titleH = 120;
        const linesH = lines.length > 0 ? 44 * lines.length + 20 : 0;
        const customH = content.custom?.height ?? 0;
        const panelH = 24 + titleH + linesH + customH + content.buttons.length * (btnH + btnGap) + 20;
        const top = -panelH / 2;
        const accent = content.titleColor ? hexToNum(content.titleColor) : COLORS.frame;

        const panel = this.scene.add.graphics();
        panel.lineStyle(14, accent, 0.07);
        panel.strokeRoundedRect(-panelW / 2 - 3, top - 3, panelW + 6, panelH + 6, 26);
        panel.lineStyle(6, accent, 0.16);
        panel.strokeRoundedRect(-panelW / 2, top, panelW, panelH, 24);
        panel.fillStyle(0x0a0720, 0.94);
        panel.fillRoundedRect(-panelW / 2, top, panelW, panelH, 24);
        panel.lineStyle(2, accent, 0.95);
        panel.strokeRoundedRect(-panelW / 2, top, panelW, panelH, 24);
        panel.fillStyle(accent, 0.9);
        panel.fillRect(-60, top - 1.5, 120, 3);
        const scan = this.scene.add.tileSprite(0, 0, panelW - 8, panelH - 8, TEX.scan).setTint(accent).setAlpha(0.05).setBlendMode(BlendModes.ADD);
        const title = this.scene.add
            .text(0, top + 24 + titleH / 2, content.title, { ...font(48, content.titleColor ?? COLORS.text), letterSpacing: 3 })
            .setOrigin(0.5);
        if (title.width > panelW - 40) title.setScale((panelW - 40) / title.width);
        this.panel.add([panel, scan, title]);
        this.content.push(panel, scan, title);

        let y = top + 24 + titleH;
        lines.forEach((line, i) => {
            const t = this.scene.add.text(0, y + 22 + i * 44, line, font(24, COLORS.dim)).setOrigin(0.5);
            this.panel.add(t);
            this.content.push(t);
        });
        y += linesH;
        if (content.custom) this.content.push(...content.custom.build(this.panel, y));
        y += customH;

        content.buttons.forEach((b, i) => {
            const button = new Button(this.scene, {
                x: 0,
                y: y + btnH / 2 + i * (btnH + btnGap),
                w: panelW - 80,
                h: btnH,
                label: b.label,
                onPress: b.onPress,
                fontSize: 30,
                fill: b.primary ? 0x0e2a44 : 0x0d0a26,
                edge: b.primary ? 0x22e6ff : 0x4a46a0,
                textColor: b.primary ? COLORS.accent : COLORS.text,
            });
            this.panel.add(button.container);
            this.buttons.push(button);
        });

        ui(this.root);
        this.backdropHandler = content.onBackdrop ?? null;
        this.blocker.setInteractive();
        this.root.setVisible(true);
        this.open = true;
        this.powerOn();
    }

    hide(): void {
        this.clearContent();
        this.scene.tweens.killTweensOf([this.panel, this.dim]);
        this.backdropHandler = null;
        this.blocker.disableInteractive();
        this.root.setVisible(false);
        this.open = false;
    }

    destroy(): void {
        this.clearContent();
        this.root.destroy();
    }

    /** CRT power-on: a thin bright line snaps open vertically, flickers, settles. */
    private powerOn(): void {
        const tweens = this.scene.tweens;
        tweens.killTweensOf([this.panel, this.dim]);
        this.dim.setAlpha(0);
        tweens.add({ targets: this.dim, alpha: 1, duration: 180 });
        if (isReducedFx()) {
            this.panel.setScale(1).setAlpha(1);
            return;
        }
        this.panel.setScale(1.08, 0.008).setAlpha(1);
        tweens.chain({
            targets: this.panel,
            tweens: [
                { scaleX: 1, duration: 90, ease: 'Quad.easeOut' },
                { scaleY: 1, duration: 150, ease: 'Back.easeOut' },
                { alpha: 0.55, duration: 40, yoyo: true },
                { alpha: 0.8, duration: 30, yoyo: true },
            ],
        });
    }

    private clearContent(): void {
        for (const b of this.buttons) b.destroy();
        this.buttons = [];
        for (const o of this.content) o.destroy();
        this.content = [];
    }
}
