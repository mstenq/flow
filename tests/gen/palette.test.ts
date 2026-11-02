import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NEON_PALETTE } from '@data/palette';
import { HARD_MAX_COLORS, MIN_LEVEL_DELTA_E, maxColorsForDifficulty, neonsConflict, simplifyImage, tryAssignNeons, type SimplifiedImage } from '../../tools/gen/palette';
import { hexToLab, hexToRgb, rgbToLab, deltaE } from '../../tools/gen/lab';
import { generateLevel } from '../../tools/gen/generate';
import { formatLevel } from '../../tools/gen/output';
import { replay } from '../../tools/gen/board';
import { cellColor } from '../../src/game/grid';
import { validateLevel } from '../../src/game/level';
import type { LevelData } from '../../src/game/types';
import { readPng, writePng, type RgbaImage } from '../../tools/gen/png';

const EMPTY = 255;

function makeImage(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): RgbaImage {
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            data.set(pixel(x, y), (y * width + x) * 4);
        }
    }
    return { width, height, data };
}

/** Small deterministic PRNG for fixtures (tests only). */
function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 0x100000000;
    };
}

function mix(a: number[], b: number[], t: number): [number, number, number, number] {
    return [0, 1, 2].map((i) => Math.round(a[i] * (1 - t) + b[i] * t)).concat(255) as [number, number, number, number];
}

/** Anti-aliased filled circle (color `fg`) on a solid background (`bg`). */
function antialiasedDisc(size = 32, radius = 10, fg = [255, 220, 0], bg = [20, 40, 160]): RgbaImage {
    const c = (size - 1) / 2;
    return makeImage(size, size, (x, y) => {
        const d = Math.hypot(x - c, y - c);
        const coverage = Math.max(0, Math.min(1, radius + 0.5 - d));
        return mix(bg, fg, coverage);
    });
}

function opaqueCount(img: RgbaImage): number {
    let n = 0;
    for (let i = 3; i < img.data.length; i += 4) if (img.data[i] >= 128) n++;
    return n;
}

function usedColors(out: SimplifiedImage): Set<number> {
    return new Set(Array.from(out.cells).filter((c) => c !== EMPTY));
}

/** 8-connected regions that are smaller than `minRegion` and still touch a different color (8-neighborhood). */
function speckles(out: SimplifiedImage, minRegion: number): number[][] {
    const { width, height, cells } = out;
    const seen = new Uint8Array(cells.length);
    const bad: number[][] = [];
    for (let s = 0; s < cells.length; s++) {
        if (cells[s] === EMPTY || seen[s]) continue;
        const region = [s];
        seen[s] = 1;
        for (let q = 0; q < region.length; q++) {
            const x = region[q] % width;
            const y = (region[q] - x) / width;
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                const j = ny * width + nx;
                if (seen[j] || cells[j] !== cells[s]) continue;
                seen[j] = 1;
                region.push(j);
            }
        }
        if (region.length >= minRegion) continue;
        const touches = region.some((i) => {
            const x = i % width;
            const y = (i - x) / width;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = x + dx;
                    const ny = y + dy;
                    if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                    const v = cells[ny * width + nx];
                    if (v !== EMPTY && v !== cells[s]) return true;
                }
            }
            return false;
        });
        if (touches) bad.push(region);
    }
    return bad;
}

function neonNameAt(out: SimplifiedImage, x: number, y: number): string {
    const idx = out.cells[y * out.width + x];
    const hex = out.palette[idx];
    return NEON_PALETTE.find((n) => n.hex === hex)!.name;
}

describe('NEON_PALETTE', () => {
    test('has 20 distinct neons', () => {
        expect(NEON_PALETTE.length).toBe(20);
        expect(new Set(NEON_PALETTE.map((n) => n.hex)).size).toBe(20);
        expect(new Set(NEON_PALETTE.map((n) => n.name)).size).toBe(20);
        expect(HARD_MAX_COLORS).toBe(20);
    });

    test('every neon is at least ~24 delta-E from every other', () => {
        const labs = NEON_PALETTE.map((n) => hexToLab(n.hex));
        for (let i = 0; i < labs.length; i++) {
            for (let j = i + 1; j < labs.length; j++) {
                expect(deltaE(labs[i], labs[j])).toBeGreaterThan(24);
            }
        }
    });

    test('the original ten neons keep their ids', () => {
        const names = NEON_PALETTE.slice(0, 10).map((n) => n.name);
        expect(names).toEqual(['magenta', 'cyan', 'lime', 'yellow', 'orange', 'red', 'violet', 'blue', 'mint', 'white']);
    });

    test('the distinctness threshold only forbids the closest few pairs', () => {
        const pairs: string[] = [];
        for (let i = 0; i < NEON_PALETTE.length; i++) {
            for (let j = i + 1; j < NEON_PALETTE.length; j++) {
                if (neonsConflict(NEON_PALETTE[i].hex, NEON_PALETTE[j].hex)) pairs.push(`${NEON_PALETTE[i].name}/${NEON_PALETTE[j].name}`);
            }
        }
        expect(pairs.length).toBeGreaterThan(0);
        expect(pairs.length).toBeLessThanOrEqual(6);
        expect(pairs).toContain('violet/purple');
        expect(pairs).toContain('lime/chartreuse');
    });
});

describe('maxColorsForDifficulty', () => {
    test('is round(6 + 8d) clamped to [4, 20]', () => {
        expect(maxColorsForDifficulty(0)).toBe(6);
        expect(maxColorsForDifficulty(0.1)).toBe(7);
        expect(maxColorsForDifficulty(0.5)).toBe(10);
        expect(maxColorsForDifficulty(0.75)).toBe(12);
        expect(maxColorsForDifficulty(1)).toBe(14);
        expect(maxColorsForDifficulty(5)).toBe(14);
        expect(maxColorsForDifficulty(-1)).toBe(6);
        for (let d = 0; d <= 1; d += 0.05) {
            const n = maxColorsForDifficulty(d);
            expect(n).toBeGreaterThanOrEqual(4);
            expect(n).toBeLessThanOrEqual(HARD_MAX_COLORS);
        }
    });
});

describe('simplifyImage', () => {
    test('anti-aliased two-color shape becomes exactly 2 colors with no speckles', () => {
        const img = antialiasedDisc();
        const out = simplifyImage(img, { maxColors: 6 });
        expect(out.palette.length).toBe(2);
        expect(usedColors(out).size).toBe(2);
        expect(speckles(out, 3)).toEqual([]);
        expect(out.counts.reduce((a, b) => a + b, 0)).toBe(32 * 32);
        // the disc is a single connected blob: it must still be one solid region
        const disc = out.counts[1];
        expect(disc).toBeGreaterThan(250);
        expect(disc).toBeLessThan(400);
    });

    test('anti-aliased shape on a transparent background keeps empty cells empty', () => {
        const size = 32;
        const c = (size - 1) / 2;
        const img = makeImage(size, size, (x, y) => {
            const d = Math.hypot(x - c, y - c);
            const a = Math.max(0, Math.min(1, 12.5 - d));
            return [255, 41, 80, Math.round(a * 255)];
        });
        const out = simplifyImage(img, { maxColors: 5 });
        expect(out.palette.length).toBe(1);
        for (let i = 0; i < out.cells.length; i++) {
            expect(out.cells[i] === EMPTY).toBe(img.data[i * 4 + 3] < 128);
        }
    });

    test('noisy photo-like image with hundreds of colors never throws and respects maxColors', () => {
        const rnd = lcg(7);
        const noisy = makeImage(40, 40, () => [Math.floor(rnd() * 256), Math.floor(rnd() * 256), Math.floor(rnd() * 256), 255]);
        const gradient = makeImage(48, 48, (x, y) => {
            const n = Math.floor(rnd() * 24) - 12;
            return [Math.min(255, Math.max(0, x * 5 + n)), Math.min(255, Math.max(0, y * 5 + n)), Math.min(255, Math.max(0, 255 - x * 3 - y * 2 + n)), 255];
        });
        for (const img of [noisy, gradient]) {
            for (const maxColors of [3, 6, 8, 14, 30]) {
                const out = simplifyImage(img, { maxColors });
                expect(out.palette.length).toBeLessThanOrEqual(Math.min(maxColors, HARD_MAX_COLORS));
                expect(out.palette.length).toBeGreaterThanOrEqual(1);
                expect(new Set(out.palette).size).toBe(out.palette.length);
                expect(out.counts.reduce((a, b) => a + b, 0)).toBe(opaqueCount(img));
            }
        }
    });

    test('maps pure hues to the matching neon, one neon per color', () => {
        const bands: Array<[number, number, number, string]> = [
            [255, 0, 0, 'red'],
            [0, 255, 255, 'cyan'],
            [255, 255, 0, 'yellow'],
            [32, 96, 255, 'blue'],
            [255, 0, 255, 'magenta'],
            [255, 128, 0, 'orange'],
            [255, 176, 0, 'gold'],
            [0, 179, 155, 'teal'],
        ];
        const img = makeImage(bands.length * 6, 8, (x) => {
            const b = bands[Math.floor(x / 6)];
            return [b[0], b[1], b[2], 255];
        });
        const out = simplifyImage(img, { maxColors: 10 });
        expect(out.palette.length).toBe(bands.length);
        bands.forEach((b, i) => expect(neonNameAt(out, i * 6 + 2, 4)).toBe(b[3]));
        expect(new Set(out.palette).size).toBe(out.palette.length);
    });

    test('pure green goes to a green neon; black/gray/white go to ink/steel/white', () => {
        const green = makeImage(8, 8, (x) => (x < 4 ? [0, 255, 0, 255] : [255, 0, 0, 255]));
        const g = simplifyImage(green, { maxColors: 4 });
        expect(['lime', 'mint']).toContain(neonNameAt(g, 1, 1));
        expect(neonNameAt(g, 6, 1)).toBe('red');

        const mono = makeImage(12, 8, (x) => (x < 4 ? [0, 0, 0, 255] : x < 8 ? [128, 128, 128, 255] : [255, 255, 255, 255]));
        const m = simplifyImage(mono, { maxColors: 4 });
        expect(neonNameAt(m, 10, 3)).toBe('white');
        expect(neonNameAt(m, 1, 3)).toBe('ink');
        expect(neonNameAt(m, 6, 3)).toBe('steel');
    });

    test('every neon, shown as a source color, maps to itself', () => {
        for (const n of NEON_PALETTE) {
            const rgb = hexToRgb(n.hex);
            expect(tryAssignNeons([{ rgb, lab: rgbToLab(...rgb) }])).toEqual([NEON_PALETTE.indexOf(n)]);
        }
    });

    test('earthy sources get their own neons: gold, brown, skin and cream, gray metal, dark outline', () => {
        const expected: Array<[string, string[]]> = [
            ['#f5b800', ['gold']],
            ['#e8a317', ['gold']],
            ['#8b5a2b', ['copper']],
            ['#9c6b3c', ['copper']],
            ['#f1c27d', ['peach']],
            ['#fff3d6', ['peach', 'white']],
            ['#8a95a8', ['steel']],
            ['#808080', ['steel']],
            ['#101010', ['ink']],
            ['#ff9ec4', ['pink']],
            ['#1a9e8f', ['teal']],
            ['#8fd3ff', ['sky']],
        ];
        for (const [hex, names] of expected) {
            const rgb = hexToRgb(hex);
            const r = tryAssignNeons([{ rgb, lab: rgbToLab(...rgb) }])!;
            expect(names).toContain(NEON_PALETTE[r[0]].name);
        }
    });

    test('violet and purple sources never share a level, even when both are present', () => {
        const sources = ['#9b5cff', '#cc33ff', '#ff2950'].map((hex) => {
            const rgb = hexToRgb(hex);
            return { rgb, lab: rgbToLab(...rgb) };
        });
        const r = tryAssignNeons(sources);
        // impossible to give both purples their own neon: either null or two distinct, non-conflicting neons
        if (r === null) return;
        for (let i = 0; i < r.length; i++) {
            for (let j = i + 1; j < r.length; j++) expect(neonsConflict(NEON_PALETTE[r[i]].hex, NEON_PALETTE[r[j]].hex)).toBe(false);
        }
    });

    test('distinctness: no two neons closer than the threshold appear in any simplified image (property)', () => {
        const rnd = lcg(2024);
        for (let trial = 0; trial < 60; trial++) {
            const k = 2 + Math.floor(rnd() * 16);
            // k random flat colors, some deliberately near the close neon pairs
            const colors: number[][] = [];
            for (let i = 0; i < k; i++) {
                if (rnd() < 0.3) {
                    const n = NEON_PALETTE[Math.floor(rnd() * NEON_PALETTE.length)];
                    colors.push(hexToRgb(n.hex).map((v) => Math.max(0, Math.min(255, v + Math.floor(rnd() * 30) - 15))));
                } else colors.push([Math.floor(rnd() * 256), Math.floor(rnd() * 256), Math.floor(rnd() * 256)]);
            }
            const img = makeImage(24, 24, (x, y) => {
                const c = colors[(Math.floor(x / 4) + 6 * Math.floor(y / 4)) % k];
                return [c[0], c[1], c[2], 255];
            });
            const out = simplifyImage(img, { maxColors: 2 + Math.floor(rnd() * 14) });
            expect(new Set(out.palette).size).toBe(out.palette.length);
            for (let i = 0; i < out.palette.length; i++) {
                for (let j = i + 1; j < out.palette.length; j++) {
                    expect(deltaE(hexToLab(out.palette[i]), hexToLab(out.palette[j]))).toBeGreaterThanOrEqual(MIN_LEVEL_DELTA_E);
                }
            }
        }
    });

    test('tryAssignNeons: random source sets are one-to-one and conflict-free whenever a mapping exists (property)', () => {
        const rnd = lcg(7);
        for (let trial = 0; trial < 40; trial++) {
            const m = 1 + Math.floor(rnd() * 14);
            const sources = Array.from({ length: m }, () => {
                const rgb: [number, number, number] = [Math.floor(rnd() * 256), Math.floor(rnd() * 256), Math.floor(rnd() * 256)];
                return { rgb, lab: rgbToLab(...rgb) };
            });
            const r = tryAssignNeons(sources, sources.map(() => 1 + Math.floor(rnd() * 50)));
            expect(r).not.toBeNull();
            expect(new Set(r).size).toBe(m);
            for (let i = 0; i < m; i++) {
                for (let j = i + 1; j < m; j++) expect(neonsConflict(NEON_PALETTE[r![i]].hex, NEON_PALETTE[r![j]].hex)).toBe(false);
            }
        }
    });

    test('a 14-color level survives generation, JSON and validateLevel with base-36 cells', () => {
        // 14 flat bands, each a different neon (no near-twins), so all 14 colors survive the simplifier
        const names = ['magenta', 'cyan', 'yellow', 'orange', 'red', 'blue', 'mint', 'white', 'pink', 'copper', 'teal', 'ink', 'sky', 'chartreuse'];
        const hexes = names.map((n) => NEON_PALETTE.find((p) => p.name === n)!.hex);
        const img = makeImage(28, 14, (x) => {
            const [r, g, b] = hexToRgb(hexes[Math.floor(x / 2)]);
            return [r, g, b, 255];
        });
        const r = generateLevel({ image: img, id: 'rainbow14', name: 'Rainbow 14', difficulty: 0.9, seed: 5, maxColors: 14, candidates: 6, climb: 4, quick: true });
        const level = JSON.parse(formatLevel(r.level)) as LevelData;
        expect(level.palette.length).toBe(14);
        expect(new Set(level.palette).size).toBe(14);
        expect(/[a-d]/.test(level.cells)).toBe(true);
        expect(() => validateLevel(level)).not.toThrow();
        for (const ch of level.cells) expect(cellColor(ch)).toBeLessThan(14);
        expect(replay(level).won).toBe(true);
    });

    test('cleanup leaves no region smaller than minRegion', () => {
        const rnd = lcg(42);
        // large blobs with salt-and-pepper speckles on top
        const img = makeImage(40, 40, (x, y) => {
            const base: [number, number, number] = x < 20 ? (y < 20 ? [230, 40, 60] : [40, 90, 230]) : y < 20 ? [240, 220, 40] : [30, 200, 120];
            if (rnd() < 0.1) return [255 - base[0], 255 - base[1], 255 - base[2], 255];
            return [base[0], base[1], base[2], 255];
        });
        for (const minRegion of [2, 3, 4, 6]) {
            const out = simplifyImage(img, { maxColors: 6, minRegion });
            expect(speckles(out, minRegion)).toEqual([]);
        }
    });

    test('tiny clusters are merged away rather than kept as 2-cell colors', () => {
        // big red field with one isolated 2-cell blue spot
        const img = makeImage(20, 20, (x, y) => (y === 10 && (x === 5 || x === 6) ? [0, 0, 255, 255] : [255, 0, 0, 255]));
        const out = simplifyImage(img, { maxColors: 5, minRegion: 3 });
        expect(out.palette.length).toBe(1);
        expect(out.counts).toEqual([400]);
    });

    test('is deterministic (byte-identical output)', () => {
        const rnd = lcg(99);
        const img = makeImage(36, 36, (x, y) => [
            Math.floor(rnd() * 40 + x * 5),
            Math.floor(rnd() * 40 + y * 5),
            Math.floor(rnd() * 255),
            x + y > 60 ? 0 : 255,
        ]);
        const a = simplifyImage(img, { maxColors: 7 });
        const b = simplifyImage(img, { maxColors: 7 });
        expect(JSON.stringify({ ...a, cells: Array.from(a.cells) })).toBe(JSON.stringify({ ...b, cells: Array.from(b.cells) }));
        expect(Buffer.from(a.cells).equals(Buffer.from(b.cells))).toBe(true);
    });

    test('the output index order is by descending count', () => {
        const out = simplifyImage(antialiasedDisc(), { maxColors: 6 });
        for (let i = 1; i < out.counts.length; i++) expect(out.counts[i - 1]).toBeGreaterThanOrEqual(out.counts[i]);
    });
});

describe('png io', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-png-'));

    test('rejects images larger than 64 in either dimension', () => {
        const wide = join(dir, 'wide.png');
        writePng(wide, makeImage(65, 10, () => [255, 0, 0, 255]));
        expect(() => readPng(wide)).toThrow(/65x10/);
        const tall = join(dir, 'tall.png');
        writePng(tall, makeImage(10, 65, () => [255, 0, 0, 255]));
        expect(() => readPng(tall)).toThrow();
    });

    test('accepts a 64x64 image', () => {
        const max = join(dir, 'max.png');
        writePng(max, makeImage(64, 64, () => [255, 0, 0, 255]));
        expect(readPng(max).width).toBe(64);
    });

    test('rejects an all-transparent image', () => {
        const p = join(dir, 'empty.png');
        writePng(p, makeImage(8, 8, () => [255, 0, 0, 0]));
        expect(() => readPng(p)).toThrow(/opaque/);
        const faint = join(dir, 'faint.png');
        writePng(faint, makeImage(8, 8, () => [255, 0, 0, 127]));
        expect(() => readPng(faint)).toThrow(/opaque/);
    });

    test('round-trips pixels', () => {
        const img = makeImage(5, 3, (x, y) => [x * 40, y * 80, 7, x === 0 ? 0 : 255]);
        const p = join(dir, 'rt.png');
        writePng(p, img);
        const back = readPng(p);
        expect(back.width).toBe(5);
        expect(back.height).toBe(3);
        expect(Buffer.from(back.data).equals(Buffer.from(img.data))).toBe(true);
        rmSync(dir, { recursive: true, force: true });
    });
});

describe('levels-src/1.png', () => {
    const img = readPng(join(import.meta.dir, '../../levels-src/1.png'));

    test('is the 48x48 illustration with ~1000 colors', () => {
        expect(img.width).toBe(48);
        expect(img.height).toBe(48);
    });

    for (const maxColors of [4, 6, 8]) {
        test(`simplifies at maxColors ${maxColors}`, () => {
            const out = simplifyImage(img, { maxColors });
            expect(out.palette.length).toBeLessThanOrEqual(maxColors);
            expect(out.palette.length).toBeGreaterThanOrEqual(Math.min(3, maxColors));
            expect(new Set(out.palette).size).toBe(out.palette.length);
            for (const hex of out.palette) expect(NEON_PALETTE.some((n) => n.hex === hex)).toBe(true);
            const cellsOpaque = Array.from(out.cells).filter((c) => c !== EMPTY).length;
            expect(cellsOpaque).toBe(opaqueCount(img));
            expect(out.counts.reduce((a, b) => a + b, 0)).toBe(cellsOpaque);
            expect(out.sourceColors.length).toBe(out.palette.length);
            expect(speckles(out, 3)).toEqual([]);
            expect(out.log.length).toBeGreaterThan(3);
        });
    }
});
