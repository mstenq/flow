/** Shared colors, depths, text styles, and per-level palette art (core / glow / deep + color-blind glyph). */
import type { Types } from 'phaser';
import { colorVariants, cssColor, glyphFor, hexToNum } from '@data/themeColors';
import type { ColorGlyph, ColorVariants } from '@data/themeColors';

export const COLORS = {
    bg: 0x05030c,
    panel: 0x14102a,
    panelEdge: 0x3a3366,
    boardBack: 0x0c0818,
    slotEdge: 0x2c2650,
    text: '#e8f6ff',
    dim: '#7d78a8',
    accent: '#22e6ff',
    warn: '#ffb020',
    bad: '#ff4d6d',
    good: '#7dff3a',
    hint: 0xffe600,
    link: 0xe8f6ff,
    unknownPod: 0x2a2f48,
    darkText: '#0a0714',
    frame: 0x3fd8ff,
    frameHot: 0xff3b5c,
    key: 0xffe600,
} as const;

export interface PaletteArt extends ColorVariants {
    glyph: ColorGlyph;
    css: string;
}

/** Visual variants for each level palette color, indexed like `level.palette`. */
export function paletteArt(hexes: readonly string[]): PaletteArt[] {
    return hexes.map((hex, i) => {
        const core = hexToNum(hex);
        return { ...colorVariants(core), glyph: glyphFor(hex, i), css: hex };
    });
}

/**
 * Render order. Two cameras: game objects (bloomed) render first, UI objects (crisp) render on top of all of them,
 * so depth only orders objects within the same camera. Overlays sit on top and block input below.
 */
export const DEPTH = {
    background: -30,
    grid: -20,
    board: 1,
    lanes: 2,
    queue: 10,
    goo: 15,
    fx: 18,
    hud: 20,
    toast: 50,
    celebrate: 60,
    overlay: 100,
} as const;

export function hexNum(hex: string): number {
    return parseInt(hex.replace('#', ''), 16);
}

export function font(size: number, color: string = COLORS.text, bold = true): Types.GameObjects.Text.TextStyle {
    return { fontFamily: 'Orbitron', fontStyle: bold ? '700' : '400', fontSize: `${Math.round(size)}px`, color };
}

/** Key letter for key id 0, 1, 2 ... (A, B, C). Shown on key cells and on the pod they unlock. */
export function keyLetter(keyId: number): string {
    return String.fromCharCode(65 + (keyId % 26));
}

/** Same as `paletteArt`, from numeric colors (what the views receive). */
export function paletteArtFromNums(colors: readonly number[]): PaletteArt[] {
    return paletteArt(colors.map(cssColor));
}
