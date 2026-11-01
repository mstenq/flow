import { describe, expect, test } from 'bun:test';
import { NEON_PALETTE } from '@data/palette';
import { ALL_GLYPHS, GLYPH_BY_NAME, glyphFor, paletteNameFor } from '@data/themeColors';
import { paletteArt } from '../../src/phaser/theme';

/** Base shape of a glyph: the outline variants (`-o`) share it with their solid twin. */
const base = (g: string) => g.replace(/-o$/, '');

describe('color-blind glyphs', () => {
    test('every palette name has a glyph, and all 20 are distinct', () => {
        expect(NEON_PALETTE).toHaveLength(20);
        const glyphs = NEON_PALETTE.map((c) => GLYPH_BY_NAME[c.name]);
        expect(glyphs.every((g) => g !== undefined)).toBe(true);
        expect(new Set(glyphs).size).toBe(20);
        expect(Object.keys(GLYPH_BY_NAME).sort()).toEqual(NEON_PALETTE.map((c) => c.name).sort());
    });

    test('the glyph list has 20 unique entries, all used', () => {
        expect(new Set(ALL_GLYPHS).size).toBe(ALL_GLYPHS.length);
        expect(ALL_GLYPHS).toHaveLength(20);
        expect([...ALL_GLYPHS].sort()).toEqual(Object.values(GLYPH_BY_NAME).sort());
    });

    test('similar hues never share a base shape (no solid/outline twins)', () => {
        const families = [
            ['violet', 'purple', 'blue', 'ink'],
            ['orange', 'copper', 'gold', 'yellow', 'peach'],
            ['lime', 'chartreuse', 'mint'],
            ['cyan', 'sky', 'steel', 'teal', 'blue'],
            ['magenta', 'pink', 'red', 'violet', 'purple'],
            ['white', 'peach', 'steel'],
            ['mint', 'teal', 'cyan'],
        ];
        for (const family of families) {
            const bases = family.map((n) => base(GLYPH_BY_NAME[n]!));
            expect(new Set(bases).size).toBe(family.length);
        }
    });

    test('glyphFor maps level palette hexes by name, including a retuned hex', () => {
        for (const c of NEON_PALETTE) expect(glyphFor(c.hex, 0)).toBe(GLYPH_BY_NAME[c.name]!);
        expect(paletteNameFor('#ff2cd5')).toBe('magenta');
        expect(glyphFor('#ff2cd5', 7)).toBe(GLYPH_BY_NAME.magenta!);
    });

    test('colors far from the palette fall back by index, wrapping over all 20 glyphs', () => {
        expect(paletteNameFor('#000000')).toBeNull();
        const out = Array.from({ length: 20 }, (_, i) => glyphFor('#000000', i));
        expect(new Set(out).size).toBe(20);
        expect(glyphFor('#000000', 20)).toBe(glyphFor('#000000', 0));
    });

    test('a 14-color level palette gets 14 different glyphs', () => {
        const hexes = [0, 2, 3, 5, 7, 9, 10, 11, 12, 13, 14, 16, 18, 19].map((i) => NEON_PALETTE[i]!.hex);
        const art = paletteArt(hexes);
        expect(new Set(art.map((a) => a.glyph)).size).toBe(14);
    });
});
