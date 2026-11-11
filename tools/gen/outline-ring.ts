/**
 * Generated seals: a brand-new color added around the picture that pods have to drain before they reach the art.
 *
 *  - Outline ring: one cell thick around the art, like a sticker border. Art that touches the board edge is padded by
 *    a cell on that side so the ring fits, which makes it a frame for full-bleed scenes.
 *  - Background: every empty cell outside the art (and outside a ring, if there is one) is painted in a pattern of
 *    1-4 new colors (`backgrounds.ts`).
 *
 * Pods reach cells through empty cells and their own color only, so a seal hides everything inside it until its
 * pods drain holes in it. Seal cells drain nearest-to-the-board-edge first (bottom, then left on ties), so the
 * picture opens in a fixed, learnable order. A background drains in layers from the board edge inward.
 */
import { MAX_DIM } from '@game/level';
import type { Rng } from '@game/rng';
import { EMPTY } from '@game/types';
import type { BackgroundStyle } from './backgrounds.ts';
import { backgroundStyle, freeNeons, paintBackground } from './backgrounds.ts';
import type { SimplifiedImage } from './palette.ts';

/** A neon the level doesn't use and that is easy to tell apart from all of its colors, or null if none is left. */
export function freeNeon(palette: readonly string[], rng: Rng): string | null {
    const options = freeNeons(palette);
    if (options.length === 0) return null;
    return rng.pick(options);
}

interface Grid {
    width: number;
    height: number;
    cells: Uint8Array;
}

/** `img` with one empty cell added on every side the art touches, or null if that would exceed `MAX_DIM`. */
function padForRing(img: Grid): Grid | null {
    const { width: w, height: h, cells } = img;
    let minX = w;
    let maxX = -1;
    let minY = h;
    let maxY = -1;
    for (let i = 0; i < cells.length; i++) {
        if (cells[i] === EMPTY) continue;
        const x = i % w;
        const y = (i - x) / w;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
    }
    if (maxX < 0) return null;
    const left = minX === 0 ? 1 : 0;
    const top = minY === 0 ? 1 : 0;
    const width = w + left + (maxX === w - 1 ? 1 : 0);
    const height = h + top + (maxY === h - 1 ? 1 : 0);
    if (width > MAX_DIM || height > MAX_DIM) return null;
    const out = new Uint8Array(width * height).fill(EMPTY);
    for (let y = 0; y < h; y++) out.set(cells.subarray(y * w, (y + 1) * w), (y + top) * width + left);
    return { width, height, cells: out };
}

/** Empty cells connected (4-way, through empty cells) to the board edge. Enclosed holes are not outside. */
function outsideEmpty(g: Grid): Uint8Array {
    const { width: w, height: h, cells } = g;
    const out = new Uint8Array(cells.length);
    const queue: number[] = [];
    const visit = (i: number) => {
        if (out[i] || cells[i] !== EMPTY) return;
        out[i] = 1;
        queue.push(i);
    };
    for (let x = 0; x < w; x++) {
        visit(x);
        visit((h - 1) * w + x);
    }
    for (let y = 0; y < h; y++) {
        visit(y * w);
        visit(y * w + w - 1);
    }
    for (let q = 0; q < queue.length; q++) {
        const i = queue[q];
        const x = i % w;
        if (x > 0) visit(i - 1);
        if (x < w - 1) visit(i + 1);
        if (i >= w) visit(i - w);
        if (i < (h - 1) * w) visit(i + w);
    }
    return out;
}

/** True if any of the 8 neighbors of cell `i` holds a color. */
function touchesArt(g: Grid, i: number): boolean {
    const { width: w, height: h, cells } = g;
    const x = i % w;
    const y = (i - x) / w;
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if ((dx === 0 && dy === 0) || nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            if (cells[ny * w + nx] !== EMPTY) return true;
        }
    }
    return false;
}

/**
 * `img` with an outline ring in a new color (index `img.palette.length`), or null when no neon is free or the
 * padded board would be too big. Every outside empty cell touching the art (8-way, so corners close) joins the ring.
 */
export function addOutlineRing(img: SimplifiedImage, rng: Rng): SimplifiedImage | null {
    const neon = freeNeon(img.palette, rng);
    if (!neon) return null;
    const padded = padForRing(img);
    if (!padded) return null;
    const outside = outsideEmpty(padded);
    const ring = img.palette.length;
    const cells = padded.cells.slice();
    let added = 0;
    for (let i = 0; i < cells.length; i++) {
        if (!outside[i] || !touchesArt(padded, i)) continue;
        cells[i] = ring;
        added++;
    }
    return {
        width: padded.width,
        height: padded.height,
        cells,
        palette: [...img.palette, neon],
        sourceColors: [...img.sourceColors, neon],
        counts: [...img.counts, added],
        log: [...img.log, `outline ring: ${added} cells of ${neon}, board ${padded.width}x${padded.height}`],
    };
}

/**
 * `img` with every outside empty cell painted in a background pattern (see `backgrounds.ts`): 1-4 new colors at
 * indexes `img.palette.length` and up. Null when no neon is free or there is no outside empty cell (full-bleed art,
 * or a frame-shaped ring that filled the padding).
 */
export function addBackground(img: SimplifiedImage, rng: Rng, style: BackgroundStyle = backgroundStyle(false)): SimplifiedImage | null {
    const outside = outsideEmpty(img);
    const targets: number[] = [];
    for (let i = 0; i < outside.length; i++) if (outside[i]) targets.push(i);
    const painted = paintBackground(img.width, img.height, targets, img.palette, style, rng);
    if (!painted) return null;
    const first = img.palette.length;
    const cells = img.cells.slice();
    const counts = new Array<number>(painted.colors.length).fill(0);
    targets.forEach((i, j) => {
        const band = painted.bands[j];
        cells[i] = first + band;
        counts[band]++;
    });
    return {
        width: img.width,
        height: img.height,
        cells,
        palette: [...img.palette, ...painted.colors],
        sourceColors: [...img.sourceColors, ...painted.colors],
        counts: [...img.counts, ...counts],
        log: [...img.log, `background: ${painted.pattern}, ${targets.length} cells in ${painted.colors.join(' ')} (${counts.join('/')})`],
    };
}
