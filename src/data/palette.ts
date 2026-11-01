/**
 * Curated neon palette shared by the game and the level generator. Order is the canonical color id order.
 * Names are stable ids (glyphs and tests key on them); hex values may be tuned.
 * Every color is at least ~25 ΔE (CIE76, Lab) from its nearest neighbor.
 */
export interface NeonColor {
    name: string;
    hex: string;
}

export const NEON_PALETTE: readonly NeonColor[] = [
    // Core neons
    { name: 'magenta', hex: '#ff2bd6' },
    { name: 'cyan', hex: '#00f0ff' },
    { name: 'lime', hex: '#7dff3a' },
    { name: 'yellow', hex: '#ffe600' },
    { name: 'orange', hex: '#ff7a1a' },
    { name: 'red', hex: '#ff2950' },
    { name: 'violet', hex: '#9b5cff' },
    { name: 'blue', hex: '#2f7bff' },
    { name: 'mint', hex: '#00ffa8' },
    { name: 'white', hex: '#f4f1ff' },
    // In-between hues plus earthy / neutral tones for food, skin, wood, metal, and outlines
    { name: 'pink', hex: '#ff7ab8' },
    { name: 'gold', hex: '#ffb000' },
    { name: 'peach', hex: '#ffd0a0' },
    { name: 'copper', hex: '#a0431a' },
    { name: 'chartreuse', hex: '#c8ff1a' },
    { name: 'teal', hex: '#00b39b' },
    { name: 'sky', hex: '#5cc8ff' },
    { name: 'purple', hex: '#cc33ff' },
    { name: 'steel', hex: '#9299b0' },
    { name: 'ink', hex: '#4f5590' },
];
