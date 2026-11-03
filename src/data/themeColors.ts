/**
 * Color language for the neon visuals (pure, no Phaser). Each palette color gets:
 *   core  the palette hex itself (tiles, rims, numbers)
 *   glow  a lighter, whiter variant (bloom sources, blob heads, sparks)
 *   deep  a dark tint (pod bodies, fills behind text)
 * plus a color-blind glyph so colors can be told apart by shape.
 */
import { NEON_PALETTE } from './palette';

export interface ColorVariants {
    core: number;
    glow: number;
    deep: number;
}

/**
 * 20 distinct solid shapes, one per neon color, so a level that uses 14 colors stays readable without color. No outlines
 * or thin strokes: every glyph is a filled silhouette that reads at ~12 px, and most hint at their color (red heart,
 * gold crown, chartreuse radioactive). See `GLYPH_BY_NAME` for how similar hues are kept apart.
 */
export type ColorGlyph =
    | 'circle'
    | 'triangle'
    | 'square'
    | 'star'
    | 'flame'
    | 'heart'
    | 'moon'
    | 'note'
    | 'diamond'
    | 'plus'
    | 'blossom'
    | 'crown'
    | 'hex'
    | 'shield'
    | 'radioactive'
    | 'x'
    | 'half'
    | 'gem'
    | 'spade'
    | 'club';

/**
 * Glyph per canonical neon color name (unique). Similar hues never share a silhouette:
 *   pink family    magenta circle, pink blossom, red heart
 *   purple family  violet moon, purple gem, blue note, ink square
 *   cyan family    cyan triangle, sky half-disc, teal x, steel spade, mint diamond
 *   green family   lime club, chartreuse radioactive, mint diamond
 *   warm family    yellow star, gold crown, orange flame, copper shield, peach hex
 *   pale family    white plus, peach hex, steel spade
 */
export const GLYPH_BY_NAME: Readonly<Record<string, ColorGlyph>> = {
    magenta: 'circle',
    cyan: 'triangle',
    lime: 'club',
    yellow: 'star',
    orange: 'flame',
    red: 'heart',
    violet: 'moon',
    blue: 'note',
    mint: 'diamond',
    white: 'plus',
    pink: 'blossom',
    gold: 'crown',
    peach: 'hex',
    copper: 'shield',
    chartreuse: 'radioactive',
    teal: 'x',
    sky: 'half',
    purple: 'gem',
    steel: 'spade',
    ink: 'square',
};

/** All glyphs (in palette order), for fallbacks and tests. */
export const ALL_GLYPHS: readonly ColorGlyph[] = [
    'circle',
    'triangle',
    'square',
    'star',
    'flame',
    'heart',
    'moon',
    'note',
    'diamond',
    'plus',
    'blossom',
    'crown',
    'hex',
    'shield',
    'radioactive',
    'x',
    'half',
    'gem',
    'spade',
    'club',
];

export function hexToNum(hex: string): number {
    return parseInt(hex.replace('#', ''), 16);
}

function mix(a: number, b: number, t: number): number {
    const ar = (a >> 16) & 0xff;
    const ag = (a >> 8) & 0xff;
    const ab = a & 0xff;
    const br = (b >> 16) & 0xff;
    const bg = (b >> 8) & 0xff;
    const bb = b & 0xff;
    const r = Math.round(ar + (br - ar) * t);
    const g = Math.round(ag + (bg - ag) * t);
    const bl = Math.round(ab + (bb - ab) * t);
    return (r << 16) | (g << 8) | bl;
}

/** Linear blend of two 0xRRGGBB colors (t = 0 gives `a`). */
export function mixColor(a: number, b: number, t: number): number {
    return mix(a, b, Math.min(1, Math.max(0, t)));
}

export function colorVariants(core: number): ColorVariants {
    return {
        core,
        glow: mix(core, 0xffffff, 0.45),
        deep: mix(0x05030c, core, 0.2),
    };
}

function rgbDist(a: number, b: number): number {
    const dr = ((a >> 16) & 0xff) - ((b >> 16) & 0xff);
    const dg = ((a >> 8) & 0xff) - ((b >> 8) & 0xff);
    const db = (a & 0xff) - (b & 0xff);
    return dr * dr + dg * dg + db * db;
}

/** Palette name of the neon color closest to `hex` (exact hex when it is a palette color, so a retuned palette still maps). */
export function paletteNameFor(hex: string): string | null {
    const target = hexToNum(hex);
    let best: string | null = null;
    let bestD = Infinity;
    for (const c of NEON_PALETTE) {
        const d = rgbDist(hexToNum(c.hex), target);
        if (d >= bestD) continue;
        bestD = d;
        best = c.name;
    }
    // Far from every palette color (a hand-made level): let the caller fall back to the index.
    return bestD <= 40 * 40 * 3 ? best : null;
}

/** Glyph for a level palette color: by nearest canonical neon name, else by index. */
export function glyphFor(hex: string, index: number): ColorGlyph {
    const name = paletteNameFor(hex);
    const glyph = name === null ? undefined : GLYPH_BY_NAME[name];
    return glyph ?? ALL_GLYPHS[index % ALL_GLYPHS.length]!;
}

export function cssColor(color: number): string {
    return `#${color.toString(16).padStart(6, '0')}`;
}
