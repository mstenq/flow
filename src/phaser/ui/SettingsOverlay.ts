/**
 * Settings panel content for `ModalOverlay` (shared by the level select cog and the pause menu).
 * Rows: music volume, SFX volume (big -/+ steppers over a 10-segment bar), reduced effects, color-blind glyphs,
 * default game speed. Every change goes through `runActions.updateSettings`, which saves it and (via
 * `bootstrap.ts` / the Play scene) applies it live.
 */
import type { GameObjects, Scene } from 'phaser';
import { getRunState, runActions } from '@game/state';
import type { Settings } from '@game/state';
import { COLORS, font } from '../theme';
import { ui } from '../fx/CameraRig';
import { Button } from './Button';
import type { Destroyable, ModalContent } from './ModalOverlay';

const ROW_W = 440;
const SLIDER_H = 118;
const TOGGLE_H = 92;
const STEPS = 10;
const SEG_W = 20;
const SEG_GAP = 4;
const BAR_W = STEPS * SEG_W + (STEPS - 1) * SEG_GAP;

export const SETTINGS_HEIGHT = SLIDER_H * 2 + TOGGLE_H * 3 + 8;

type VolumeKey = 'music' | 'sfx';

/** Modal content for the settings screen; `onBack` runs when BACK is pressed. */
export function settingsContent(scene: Scene, onBack: () => void): ModalContent {
    return {
        title: 'SETTINGS',
        custom: { height: SETTINGS_HEIGHT, build: (panel, top) => buildRows(scene, panel, top) },
        buttons: [{ label: 'BACK', primary: true, onPress: onBack }],
    };
}

function buildRows(scene: Scene, panel: GameObjects.Container, top: number): Destroyable[] {
    const things: Destroyable[] = [];
    const refreshers: (() => void)[] = [];
    const refresh = () => refreshers.forEach((fn) => fn());
    const text = (x: number, y: number, label: string, size: number, color: string, originX = 0): GameObjects.Text => {
        const t = ui(scene.add.text(x, y, label, font(size, color)).setOrigin(originX, 0.5));
        panel.add(t);
        things.push(t);
        return t;
    };
    const button = (x: number, y: number, w: number, h: number, label: string, onPress: () => void, fontSize: number): Button => {
        const b = new Button(scene, { x, y, w, h, label, onPress, fontSize });
        panel.add(b.container);
        things.push(b);
        return b;
    };
    const change = (patch: Partial<Settings>) => {
        runActions.updateSettings(patch);
        refresh();
    };

    let y = top;
    const volumeRow = (key: VolumeKey, label: string) => {
        text(-ROW_W / 2, y + 26, label, 22, COLORS.dim);
        const value = text(ROW_W / 2, y + 26, '', 22, COLORS.text, 1);
        const bar = ui(scene.add.graphics());
        panel.add(bar);
        things.push(bar);
        const cy = y + 78;
        const step = (dir: number) => change({ [key]: Math.round(Math.max(0, Math.min(1, getRunState().settings[key] + dir / STEPS)) * STEPS) / STEPS });
        button(-ROW_W / 2 + 46, cy, 92, 72, '-', () => step(-1), 40);
        button(ROW_W / 2 - 46, cy, 92, 72, '+', () => step(1), 40);
        refreshers.push(() => {
            const v = getRunState().settings[key];
            const lit = Math.round(v * STEPS);
            value.setText(v <= 0 ? 'OFF' : `${Math.round(v * 100)}%`);
            bar.clear();
            for (let i = 0; i < STEPS; i++) {
                bar.fillStyle(i < lit ? 0x22e6ff : 0x2a2650, i < lit ? 1 : 0.9);
                bar.fillRoundedRect(-BAR_W / 2 + i * (SEG_W + SEG_GAP), cy - 18, SEG_W, 36, 4);
            }
        });
        bar.setPosition(0, 0);
        y += SLIDER_H;
    };
    volumeRow('music', 'MUSIC');
    volumeRow('sfx', 'SOUND FX');

    const toggleRow = (label: string, read: () => string, flip: () => Partial<Settings>) => {
        const cy = y + TOGGLE_H / 2;
        text(-ROW_W / 2, cy, label, 22, COLORS.text);
        const b = button(ROW_W / 2 - 70, cy, 140, 68, '', () => change(flip()), 28);
        refreshers.push(() => b.setLabel(read()));
        y += TOGGLE_H;
    };
    const onOff = (v: boolean) => (v ? 'ON' : 'OFF');
    toggleRow('REDUCED FX', () => onOff(getRunState().settings.reducedFx), () => ({ reducedFx: !getRunState().settings.reducedFx }));
    toggleRow('COLOR-BLIND', () => onOff(getRunState().settings.colorBlind), () => ({ colorBlind: !getRunState().settings.colorBlind }));
    toggleRow('GAME SPEED', () => `${getRunState().settings.speed}x`, () => ({ speed: getRunState().settings.speed === 1 ? 2 : 1 }));

    refresh();
    return things;
}
