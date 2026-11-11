/**
 * Solution walkthrough content for `ModalOverlay` (pause menu → SOLUTION; BACK returns to the pause menu, RESUME to the game). One row per stored-solution tap: step
 * number, a mini map of the queue columns with the one to tap lit, the pod at its front (plus a linked partner),
 * and how it ends up once the board settles (CLEARS / STALLS). Paged in place, so flipping a page does not
 * replay the modal's power-on. The step the round is on is outlined and opens on screen; steps already tapped dim.
 */
import type { GameObjects, Scene } from 'phaser';
import type { SolutionGuide } from '@game/gameFacade';
import type { SolutionStep, StepOutcome, StepPod } from '@game/solutionGuide';
import { COLORS, font } from '../theme';
import type { PaletteArt } from '../theme';
import { ui } from '../fx/CameraRig';
import { Button } from './Button';
import type { Destroyable, ModalContent } from './ModalOverlay';
import { drawCapsule, drawGlyph, drawLinkRings, drawPadlock } from '../view/podArt';

const ROWS = 8;
const ROW_H = 66;
const ROW_W = 460;
const HEAD_H = 76;
const PAGER_H = 84;
const CHIP_W = 92;
const CHIP_H = 46;

export const SOLUTION_HEIGHT = HEAD_H + ROWS * ROW_H + PAGER_H;

const OUTCOME: Record<StepOutcome, { label: string; color: string }> = {
    clears: { label: 'CLEARS', color: COLORS.good },
    stalls: { label: 'STALLS', color: COLORS.warn },
};

interface SolutionOptions {
    guide: SolutionGuide;
    art: PaletteArt[];
    /** Queue columns in the level (for the mini column map). */
    columns: number;
    onResume: () => void;
    onBack: () => void;
}

/** Modal content for the walkthrough. */
export function solutionContent(scene: Scene, opts: SolutionOptions): ModalContent {
    return {
        title: 'SOLUTION',
        custom: { height: SOLUTION_HEIGHT, build: (panel, top) => buildGuide(scene, panel, top, opts) },
        buttons: [
            { label: 'BACK', primary: true, onPress: opts.onBack },
            { label: 'RESUME', onPress: opts.onResume },
        ],
    };
}

function buildGuide(scene: Scene, panel: GameObjects.Container, top: number, opts: SolutionOptions): Destroyable[] {
    const { steps, current } = opts.guide;
    const things: Destroyable[] = [];
    const text = (x: number, y: number, label: string, size: number, color: string): GameObjects.Text => {
        const t = ui(scene.add.text(x, y, label, font(size, color)).setOrigin(0.5));
        panel.add(t);
        things.push(t);
        return t;
    };

    text(0, top + 18, statusLine(current, steps.length), 20, current === null ? COLORS.warn : COLORS.text);
    text(0, top + 50, 'TAP, THEN LET THE LANES SETTLE', 15, COLORS.dim);

    const pages = Math.max(1, Math.ceil(steps.length / ROWS));
    const rows = ui(scene.add.container(0, 0));
    panel.add(rows);
    things.push(rows);
    const pagerY = top + HEAD_H + ROWS * ROW_H + PAGER_H / 2;
    const pageText = text(0, pagerY, '', 20, COLORS.dim);
    let page = current === null ? 0 : Math.min(pages - 1, Math.floor(current / ROWS));
    const button = (x: number, label: string, dir: number): Button => {
        const b = new Button(scene, { x, y: pagerY, w: 96, h: 60, label, onPress: () => render(page + dir), fontSize: 30 });
        panel.add(b.container);
        things.push(b);
        return b;
    };
    const prev = button(-170, '<', -1);
    const next = button(170, '>', 1);
    const showPager = pages > 1;
    prev.container.setVisible(showPager);
    next.container.setVisible(showPager);
    pageText.setVisible(showPager);

    const render = (to: number): void => {
        page = Math.max(0, Math.min(pages - 1, to));
        rows.removeAll(true);
        steps.slice(page * ROWS, (page + 1) * ROWS).forEach((step, i) => {
            const index = page * ROWS + i;
            const y = top + HEAD_H + i * ROW_H + ROW_H / 2;
            const state = current === null ? 'todo' : index < current ? 'done' : index === current ? 'now' : 'todo';
            buildRow(scene, rows, y, index, step, state, opts);
        });
        ui(rows);
        pageText.setText(`${page + 1} / ${pages}`);
        prev.setEnabled(page > 0);
        next.setEnabled(page < pages - 1);
    };
    render(page);
    return things;
}

function statusLine(current: number | null, total: number): string {
    if (total === 0) return 'NO SOLUTION STORED';
    if (current === null) return 'OFF THE PATH: RESTART';
    if (current >= total) return 'ALL STEPS DONE';
    return `YOU'RE ON STEP ${current + 1} OF ${total}`;
}

function buildRow(
    scene: Scene,
    rows: GameObjects.Container,
    y: number,
    index: number,
    step: SolutionStep,
    state: 'done' | 'now' | 'todo',
    opts: SolutionOptions,
): void {
    const left = -ROW_W / 2;
    const row = scene.add.container(0, 0);
    rows.add(row);
    const g = scene.add.graphics();
    row.add(g);
    if (state === 'done') row.setAlpha(0.35);
    if (state === 'now') {
        g.fillStyle(0x0e2a44, 0.9);
        g.fillRoundedRect(left - 6, y - ROW_H / 2 + 3, ROW_W + 12, ROW_H - 6, 12);
        g.lineStyle(2, 0x22e6ff, 1);
        g.strokeRoundedRect(left - 6, y - ROW_H / 2 + 3, ROW_W + 12, ROW_H - 6, 12);
    }
    row.add(scene.add.text(left + 22, y, String(index + 1), font(20, state === 'now' ? COLORS.accent : COLORS.dim)).setOrigin(0.5));
    drawColumnMap(g, left + 52, y, opts.columns, step.column);

    const chipX = left + 52 + mapWidth(opts.columns) + 24 + CHIP_W / 2;
    drawChip(scene, row, g, chipX, y, step.pod, step.partner !== null, opts.art);
    if (step.partner) {
        row.add(scene.add.text(chipX + CHIP_W / 2 + 14, y, '+', font(24, COLORS.text)).setOrigin(0.5));
        drawChip(scene, row, g, chipX + CHIP_W + 28, y, step.partner, true, opts.art);
    }
    const outcome = OUTCOME[step.outcome];
    row.add(scene.add.text(ROW_W / 2, y, outcome.label, font(16, outcome.color)).setOrigin(1, 0.5));
}

const MAP_COL_W = 12;
const MAP_COL_H = 30;
const MAP_GAP = 4;

function mapWidth(columns: number): number {
    return columns * MAP_COL_W + (columns - 1) * MAP_GAP;
}

/** Every queue column as a thin bar, the one to tap lit. `x` is the left edge. */
function drawColumnMap(g: GameObjects.Graphics, x: number, y: number, columns: number, lit: number): void {
    for (let c = 0; c < columns; c++) {
        const cx = x + c * (MAP_COL_W + MAP_GAP);
        if (c === lit) {
            g.fillStyle(0x22e6ff, 1);
            g.fillRoundedRect(cx, y - MAP_COL_H / 2, MAP_COL_W, MAP_COL_H, 3);
            continue;
        }
        g.lineStyle(2, 0x4a46a0, 0.9);
        g.strokeRoundedRect(cx, y - MAP_COL_H / 2, MAP_COL_W, MAP_COL_H, 3);
    }
}

/** A small pod: its color and glyph, its capacity, and marks for how it started (locked, hidden) or a link. */
function drawChip(
    scene: Scene,
    row: GameObjects.Container,
    g: GameObjects.Graphics,
    x: number,
    y: number,
    pod: StepPod,
    linked: boolean,
    art: PaletteArt[],
): void {
    const a = art[pod.color];
    const core = a?.core ?? 0xffffff;
    drawCapsule(g, x, y, CHIP_W, CHIP_H, { body: a?.deep ?? 0x14102a, bodyAlpha: 0.94, rim: core, rimAlpha: 1, rimWidth: 2.5, glowAlpha: 0.6 });
    if (a) drawGlyph(g, a.glyph, x - CHIP_W / 2 + 18, y, 9, a.glow, 1);
    row.add(scene.add.text(x + 10, y + 1, String(pod.capacity), { ...font(22, '#ffffff'), stroke: '#05030c', strokeThickness: 5 }).setOrigin(0.5));
    const markX = x + CHIP_W / 2 - 4;
    const markY = y - CHIP_H / 2 - 2;
    if (pod.lock !== null) drawPadlock(g, markX, markY, 14, COLORS.key);
    if (pod.hidden) row.add(scene.add.text(markX, markY, '?', { ...font(18, '#b9a8ff'), stroke: '#05030c', strokeThickness: 5 }).setOrigin(0.5));
    if (linked) drawLinkRings(g, x - CHIP_W / 2 + 6, y - CHIP_H / 2 - 2, 18, COLORS.link);
}
