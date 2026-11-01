/**
 * Mini renders of a level image for the level select: one canvas texture per (level, kind), drawn once and cached in
 * the game-global texture manager (never redrawn per frame).
 *   color  the full neon image (deep base, core fill, a bright top highlight; bloom does the glow)
 *   wire   cell outlines only, in a neutral violet (a silhouette of what is waiting to be collected)
 */
import type { Scene } from 'phaser';
import { cellColor } from '@game/grid';
import { colorVariants, cssColor, hexToNum } from '@data/themeColors';

export type MiniKind = 'color' | 'wire';

export interface MiniArt {
    key: string;
    /** Texture size in pixels. */
    w: number;
    h: number;
}

export interface MiniSource {
    id: string;
    width: number;
    height: number;
    palette: readonly string[];
    /** Row-major, '.' = empty, base-36 color index ('0'..'9', 'a'..'z'; see `cellColor`). */
    cells: string;
}

/** Texture budget per mini image (about 1.5x the on-screen art box, for sharpness on dense screens). */
const MAX_W = 408;
const MAX_H = 384;

export function miniKey(id: string, kind: MiniKind): string {
    return `mini:${kind}:${id}`;
}

/** Pixels per image cell: whole pixels so cells stay crisp, at least 2. */
export function miniCellPx(width: number, height: number): number {
    return Math.max(2, Math.floor(Math.min(MAX_W / Math.max(1, width), MAX_H / Math.max(1, height))));
}

/** Create the texture if it does not exist yet; returns its key and size. */
export function ensureMini(scene: Scene, src: MiniSource, kind: MiniKind): MiniArt {
    const px = miniCellPx(src.width, src.height);
    const w = src.width * px;
    const h = src.height * px;
    const key = miniKey(src.id, kind);
    if (scene.textures.exists(key)) return { key, w, h };
    const tex = scene.textures.createCanvas(key, w, h);
    if (!tex) return { key, w, h };
    const ctx = tex.context;
    if (kind === 'color') drawColor(ctx, src, px);
    else drawWire(ctx, src, px);
    tex.refresh();
    return { key, w, h };
}

/** Palette index of cell `i` (base-36 decoding), or -1 for empty / invalid cells and indexes past the palette. */
export function miniColorAt(cells: string, paletteSize: number, i: number): number {
    const ch = cells[i];
    if (ch === undefined) return -1;
    const c = cellColor(ch);
    return c >= 0 && c < paletteSize ? c : -1;
}

function colorAt(src: MiniSource, i: number): number {
    return miniColorAt(src.cells, src.palette.length, i);
}

function drawColor(ctx: CanvasRenderingContext2D, src: MiniSource, px: number): void {
    const inset = Math.max(0.5, px * 0.07);
    const variants = src.palette.map((hex) => colorVariants(hexToNum(hex)));
    for (let y = 0; y < src.height; y++) {
        for (let x = 0; x < src.width; x++) {
            const c = colorAt(src, y * src.width + x);
            const v = variants[c];
            if (c < 0 || !v) continue;
            const cx = x * px;
            const cy = y * px;
            ctx.fillStyle = cssColor(v.deep);
            ctx.fillRect(cx, cy, px, px);
            ctx.fillStyle = cssColor(v.core);
            ctx.fillRect(cx + inset, cy + inset, px - inset * 2, px - inset * 2);
            ctx.fillStyle = 'rgba(255,255,255,0.28)';
            ctx.fillRect(cx + inset, cy + inset, px - inset * 2, Math.max(1, (px - inset * 2) * 0.32));
        }
    }
}

function drawWire(ctx: CanvasRenderingContext2D, src: MiniSource, px: number): void {
    const line = Math.max(1, px * 0.09);
    ctx.lineWidth = line;
    ctx.strokeStyle = 'rgba(140,146,230,0.55)';
    ctx.fillStyle = 'rgba(120,126,210,0.07)';
    for (let y = 0; y < src.height; y++) {
        for (let x = 0; x < src.width; x++) {
            if (colorAt(src, y * src.width + x) < 0) continue;
            const cx = x * px + line / 2;
            const cy = y * px + line / 2;
            ctx.fillRect(cx, cy, px - line, px - line);
            ctx.strokeRect(cx, cy, px - line, px - line);
        }
    }
}
