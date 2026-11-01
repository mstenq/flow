/**
 * One-time mechanic intro card (hidden / locked / linked pods): a title, one line of text and a small
 * illustration drawn with the real pod art (`podArt.ts`). Built as `ModalOverlay` content so it gets the same CRT
 * power-on, blocks input underneath, and is dismissed by tapping anywhere or the button.
 */
import type { GameObjects, Scene } from 'phaser';
import type { MechanicId, MechanicInfo } from '@game/mechanics';
import { COLORS, font, keyLetter } from '../theme';
import type { PaletteArt } from '../theme';
import { drawKeyGlyph } from './glyphs';
import { drawColorPod, drawHiddenPod, drawLightning, drawLinkRings, drawLockedPod } from '../view/podArt';
import type { Destroyable, ModalContent } from './ModalOverlay';

const POD_W = 132;
const POD_H = 104;
const POD_SCALE = 0.82;
const ART_H = 176;
const TEXT_H = 150;

export const INTRO_HEIGHT = ART_H + TEXT_H;

interface IntroOptions {
    info: MechanicInfo;
    art: PaletteArt[];
    /** Cards left after this one (0 = last: the button says GOT IT). */
    remaining: number;
    onDone: () => void;
}

/** Modal content for one intro card. */
export function introContent(scene: Scene, opts: IntroOptions): ModalContent {
    const { info, remaining, onDone } = opts;
    return {
        title: info.title,
        titleColor: info.id === 'locked' ? '#ffe600' : info.id === 'linked' ? '#bff8ff' : '#b9a8ff',
        custom: { height: INTRO_HEIGHT, build: (panel, top) => buildCard(scene, panel, top, opts) },
        buttons: [{ label: remaining > 0 ? 'NEXT' : 'GOT IT', primary: true, onPress: onDone }],
        onBackdrop: onDone,
    };
}

function buildCard(scene: Scene, panel: GameObjects.Container, top: number, opts: IntroOptions): Destroyable[] {
    const things: Destroyable[] = [];
    const add = <T extends GameObjects.GameObject & Destroyable>(o: T): T => {
        panel.add(o);
        things.push(o);
        return o;
    };
    const cy = top + ART_H / 2 - 8;
    const gfx = add(scene.add.graphics());
    const art = opts.art.length > 0 ? opts.art : undefined;
    const pick = (i: number): PaletteArt | undefined => art?.[i % (art?.length ?? 1)];
    const pod = (x: number, draw: (g: GameObjects.Graphics) => void, label: string, labelColor: string, sub = ''): void => {
        const root = add(scene.add.container(x, cy).setScale(POD_SCALE));
        const g = scene.add.graphics();
        draw(g);
        const text = scene.add.text(0, 2, label, { ...font(40, labelColor), stroke: '#05030c', strokeThickness: 6 }).setOrigin(0.5);
        root.add([g, text]);
        if (sub === '') return;
        root.add(scene.add.text(0, POD_H / 2 - 16, sub, { ...font(14, '#ffe600'), stroke: '#05030c', strokeThickness: 4 }).setOrigin(0.5));
    };
    ILLUSTRATIONS[opts.info.id]({ gfx, pod, cy, pick });

    add(
        scene.add
            .text(0, top + ART_H + 8, opts.info.text, { ...font(22, COLORS.text, false), wordWrap: { width: 430 }, align: 'center', lineSpacing: 6 })
            .setOrigin(0.5, 0),
    );
    add(scene.add.text(0, top + INTRO_HEIGHT - 22, 'TAP TO CONTINUE', font(14, COLORS.dim))).setOrigin(0.5);
    return things;
}

interface Canvas {
    gfx: GameObjects.Graphics;
    pod: (x: number, draw: (g: GameObjects.Graphics) => void, label: string, labelColor: string, sub?: string) => void;
    cy: number;
    pick: (i: number) => PaletteArt | undefined;
}

/** A small arrow pointing right, centered on `x`. */
function arrow(g: GameObjects.Graphics, x: number, y: number, color: number): void {
    g.lineStyle(4, color, 0.9);
    g.lineBetween(x - 22, y, x + 14, y);
    g.fillStyle(color, 0.95);
    g.fillTriangle(x + 24, y, x + 8, y - 11, x + 8, y + 11);
}

const ILLUSTRATIONS: Record<MechanicId, (c: Canvas) => void> = {
    // ? pod -> the same slot once it reaches the front, with its color and size.
    hidden: ({ gfx, pod, cy, pick }) => {
        pod(-120, (g) => drawHiddenPod(g, POD_W, POD_H), '?', '#b9a8ff');
        arrow(gfx, 0, cy, 0x6a5cff);
        pod(120, (g) => drawColorPod(g, POD_W, POD_H, pick(1), true), '24', '#ffffff');
    },
    // A key sitting on the image -> the locked pod it opens.
    locked: ({ gfx, pod, cy, pick }) => {
        const keyColor = pick(0)?.core ?? 0x3fd8ff;
        const x = -120;
        gfx.fillStyle(keyColor, 0.9);
        gfx.fillRoundedRect(x - 36, cy - 36, 72, 72, 8);
        gfx.lineStyle(2, 0xffffff, 0.35);
        gfx.strokeRoundedRect(x - 36, cy - 36, 72, 72, 8);
        drawKeyGlyph(gfx, x, cy, 52, 0xffe600, 0x1a1000);
        arrow(gfx, 0, cy, 0xffe600);
        pod(120, (g) => drawLockedPod(g, POD_W, POD_H), '', '#ffffff', `KEY ${keyLetter(0)}`);
    },
    // Two pods joined by a tether, each marked with the link rings.
    linked: ({ gfx, pod, cy, pick }) => {
        const draw = (i: number) => (g: GameObjects.Graphics) => {
            drawColorPod(g, POD_W, POD_H, pick(i), true);
            drawLinkRings(g, POD_W / 2 - 18, -POD_H / 2 + 16, 20, 0xe8f6ff);
        };
        pod(-92, draw(2), '30', '#ffffff');
        pod(92, draw(2), '30', '#ffffff');
        drawLightning(gfx, -92 + POD_W * POD_SCALE * 0.5, cy - 8, 92 - POD_W * POD_SCALE * 0.5, cy - 8, 6, 5, 0x9ff3ff, 2.2, 1);
    },
};
