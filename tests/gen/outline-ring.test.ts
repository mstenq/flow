import { describe, expect, test } from 'bun:test';
import { Rng } from '@game/rng';
import { INF, fullDist } from '@game/reach';
import { EMPTY } from '@game/types';
import { NEON_PALETTE } from '../../src/data/palette';
import { boardFromAscii, replay } from '../../tools/gen/board';
import { generateLevel } from '../../tools/gen/generate';
import { EASY_CUTOFF, outlineChance, podCaps, wideLanesFor } from '../../tools/gen/knobs';
import { PATTERNS, backgroundStyle, paintBackground } from '../../tools/gen/backgrounds';
import { addBackground, addOutlineRing, freeNeon } from '../../tools/gen/outline-ring';
import type { SimplifiedImage } from '../../tools/gen/palette';
import { neonsConflict } from '../../tools/gen/palette';
import type { RgbaImage } from '../../tools/gen/png';
import { SCENE, SPRITE } from './fixtures';

const ART_PALETTE = ['#ff2bd6', '#00f0ff', '#7dff3a', '#ffe600', '#ff7a1a', '#2f7bff'];

function simplified(ascii: string): SimplifiedImage {
    const b = boardFromAscii(ascii, ART_PALETTE);
    const palette = ART_PALETTE.slice(0, b.numColors);
    return { width: b.width, height: b.height, cells: b.cells, palette, sourceColors: palette.slice(), counts: b.counts, log: [] };
}

describe('outline ring', () => {
    test('seals the art: no art cell is reachable before the ring drains', () => {
        for (const ascii of [SPRITE, SCENE]) {
            const img = simplified(ascii);
            const out = addOutlineRing(img, new Rng(1));
            expect(out).not.toBeNull();
            if (!out) continue;
            const ring = img.palette.length;
            expect(out.palette.length).toBe(img.palette.length + 1);
            expect(out.counts[ring]).toBeGreaterThan(0);
            for (let c = 0; c < ring; c++) {
                const dist = fullDist(out.cells, out.width, out.height, c);
                for (let i = 0; i < out.cells.length; i++) if (out.cells[i] === c) expect(dist[i]).toBe(INF);
            }
            const ringDist = fullDist(out.cells, out.width, out.height, ring);
            for (let i = 0; i < out.cells.length; i++) if (out.cells[i] === ring) expect(ringDist[i]).toBeLessThan(INF);
        }
    });

    test('pads only the sides the art touches, and leaves enclosed holes empty', () => {
        // SPRITE (10x8) touches all four edges; its two 2-cell holes are enclosed by color 3.
        const img = simplified(SPRITE);
        const out = addOutlineRing(img, new Rng(2));
        if (!out) throw new Error('expected a ring');
        expect([out.width, out.height]).toEqual([12, 10]);
        const hole = (x: number, y: number) => out.cells[(y + 1) * out.width + x + 1];
        expect([hole(4, 3), hole(5, 3), hole(4, 4), hole(5, 4)]).toEqual([EMPTY, EMPTY, EMPTY, EMPTY]);

        const inset = simplified('......\n..00..\n.0110.\n..00..\n......');
        const small = addOutlineRing(inset, new Rng(2));
        expect(small && [small.width, small.height]).toEqual([6, 5]);
    });

    test('uses a new neon that conflicts with none of the art', () => {
        for (let seed = 0; seed < 50; seed++) {
            const hex = freeNeon(ART_PALETTE, new Rng(seed));
            if (!hex) throw new Error('expected a free neon');
            expect(ART_PALETTE).not.toContain(hex);
            for (const p of ART_PALETTE) expect(neonsConflict(p, hex)).toBe(false);
        }
        expect(freeNeon(NEON_PALETTE.map((n) => n.hex), new Rng(1))).toBeNull();
    });

    test('skips art that is already at the size limit and touches the edge', () => {
        const row = '0'.repeat(64);
        const full = simplified(Array.from({ length: 64 }, () => row).join('\n'));
        expect(addOutlineRing(full, new Rng(1))).toBeNull();
    });

    test('chance: none on easy levels, more on hard and few-color levels', () => {
        expect(outlineChance(EASY_CUTOFF - 0.01, 3)).toBe(0);
        expect(outlineChance(0.9, 8)).toBeGreaterThan(outlineChance(0.3, 8));
        expect(outlineChance(0.5, 3)).toBeGreaterThan(outlineChance(0.5, 8));
    });

    test('a generated level with a ring is wide, replays, and its pods respect the color caps', () => {
        const rows = ['..0000..', '.011110.', '01222210', '01222210', '.011110.', '..0000..'];
        const colors: Record<string, number[]> = { '0': [30, 60, 230], '1': [240, 230, 20], '2': [230, 30, 60] };
        const data = new Uint8Array(8 * 6 * 4);
        rows.forEach((row, y) => {
            for (let x = 0; x < 8; x++) {
                const c = colors[row[x]];
                if (c) data.set([...c, 255], (y * 8 + x) * 4);
            }
        });
        const image: RgbaImage = { width: 8, height: 6, data };
        const r = generateLevel({ image, id: 'ringed', name: 'Ringed', difficulty: 0.6, seed: 5, outline: true, background: false, candidates: 6, climb: 4, quick: true });
        const ring = r.simplified.palette.length - 1;
        expect(r.board.seals).toEqual([ring]);
        expect([r.level.width, r.level.height]).toEqual([10, 8]);
        expect(r.level.lanes).toBe(wideLanesFor(5));
        expect(replay(r.level).won).toBe(true);
        const caps = podCaps(r.board.counts);
        for (const p of r.level.columns.flat()) expect(p.capacity).toBeLessThanOrEqual(caps[p.color]);
    });
});

/** Every art cell (colors below `firstSeal`) is unreachable for its own color. */
function artSealed(img: SimplifiedImage, firstSeal: number): boolean {
    for (let c = 0; c < firstSeal; c++) {
        const dist = fullDist(img.cells, img.width, img.height, c);
        for (let i = 0; i < img.cells.length; i++) if (img.cells[i] === c && dist[i] !== INF) return false;
    }
    return true;
}

const INSET = `
    ........
    ...00...
    ..0110..
    .012210.
    .01..10.
    ..0110..
    ........
`;

describe('background fill', () => {
    test('paints every outside empty cell in new colors, seals the art and leaves enclosed holes empty', () => {
        const img = simplified(INSET);
        for (let seed = 0; seed < 20; seed++) {
            const out = addBackground(img, new Rng(seed));
            if (!out) throw new Error('expected a background');
            const fill = img.palette.length;
            expect([out.width, out.height]).toEqual([img.width, img.height]);
            expect(artSealed(out, fill)).toBe(true);
            const holes = out.cells.filter((v) => v === EMPTY).length;
            expect(holes).toBe(2);
            const added = out.counts.slice(fill);
            expect(added.reduce((a, b) => a + b, 0)).toBe(img.cells.filter((v) => v === EMPTY).length - holes);
            for (const hex of out.palette.slice(fill)) {
                expect(img.palette).not.toContain(hex);
                for (const p of img.palette) expect(neonsConflict(p, hex)).toBe(false);
            }
            expect(new Set(out.palette).size).toBe(out.palette.length);
        }
    });

    test('stacks outside a ring in a third color', () => {
        // Two empty cells of margin, so the background wraps the ring instead of the ring touching the board edge.
        const img = simplified(`
            ..........
            ..........
            ....00....
            ...0110...
            ..012210..
            ..........
            ..........
        `);
        const ringed = addOutlineRing(img, new Rng(1));
        if (!ringed) throw new Error('expected a ring');
        const both = addBackground(ringed, new Rng(2));
        if (!both) throw new Error('expected a background');
        expect(both.palette.length).toBeGreaterThanOrEqual(img.palette.length + 2);
        expect(new Set(both.palette).size).toBe(both.palette.length);
        expect(artSealed(both, img.palette.length)).toBe(true);
        // The ring is behind the background: unreachable for its color until the background drains.
        expect(artSealed(both, img.palette.length + 1)).toBe(true);
    });

    test('skips art with no outside empty cell', () => {
        expect(addBackground(simplified(SCENE), new Rng(1))).toBeNull();
        const framed = addOutlineRing(simplified(SCENE), new Rng(1));
        if (!framed) throw new Error('expected a frame');
        expect(addBackground(framed, new Rng(1))).toBeNull();
    });

    test('falls back to a single color when only one neon is free, and to none when none is', () => {
        const all = NEON_PALETTE.map((n) => n.hex);
        const cells = Array.from({ length: 40 }, (_, i) => i);
        const one = paintBackground(8, 5, cells, all.slice(1).filter((h) => !neonsConflict(h, all[0])), backgroundStyle(false), new Rng(1));
        expect(one?.pattern).toBe('solid');
        expect(one?.colors).toEqual([all[0]]);
        expect(paintBackground(8, 5, cells, all, backgroundStyle(false), new Rng(1))).toBeNull();
    });

    test('a generated level with a background is wide and replays', () => {
        const rows = ['........', '..0000..', '.011110.', '.012210.', '.011110.', '..0000..', '........'];
        const colors: Record<string, number[]> = { '0': [30, 60, 230], '1': [240, 230, 20], '2': [230, 30, 60] };
        const data = new Uint8Array(8 * 7 * 4);
        rows.forEach((row, y) => {
            for (let x = 0; x < 8; x++) {
                const c = colors[row[x]];
                if (c) data.set([...c, 255], (y * 8 + x) * 4);
            }
        });
        const image: RgbaImage = { width: 8, height: 7, data };
        const r = generateLevel({ image, id: 'bg', name: 'Bg', difficulty: 0.6, seed: 9, outline: false, background: true, candidates: 6, climb: 4, quick: true });
        const seals = r.board.seals ?? [];
        expect(seals.length).toBeGreaterThanOrEqual(1);
        expect(seals[seals.length - 1]).toBe(r.simplified.palette.length - 1);
        expect(r.level.lanes).toBe(wideLanesFor(9));
        expect(replay(r.level).won).toBe(true);
    });
});

describe('background patterns', () => {
    const W = 24;
    const H = 20;
    const cells = Array.from({ length: W * H }, (_, i) => i);

    test('every pattern paints bands in range on every cell and is deterministic', () => {
        for (const def of PATTERNS) {
            for (let colors = def.minColors; colors <= def.maxColors; colors++) {
                const a = def.make(new Rng(7), { width: W, height: H, colors, cells });
                const b = def.make(new Rng(7), { width: W, height: H, colors, cells });
                const seen = new Set<number>();
                for (const i of cells) {
                    const x = i % W;
                    const band = a(x, (i - x) / W);
                    expect(band).toBe(b(x, (i - x) / W));
                    expect(Number.isInteger(band) && band >= 0 && band < colors).toBe(true);
                    seen.add(band);
                }
                // A full board shows every band of the pattern.
                expect([def.name, seen.size]).toEqual([def.name, colors]);
            }
        }
    });

    test('easy levels only get plain 2-color patterns', () => {
        const style = backgroundStyle(true);
        const easy = new Set(PATTERNS.filter((p) => style.families.includes(p.family)).map((p) => p.name));
        expect(style.families).not.toContain('gradient');
        for (let seed = 0; seed < 40; seed++) {
            const out = paintBackground(W, H, cells, ART_PALETTE, style, new Rng(seed));
            if (!out) throw new Error('expected a background');
            expect(easy.has(out.pattern) || out.pattern === 'solid').toBe(true);
            expect(out.colors.length).toBeLessThanOrEqual(2);
        }
    });

    test('picks a variety of patterns', () => {
        const names = new Set<string>();
        for (let seed = 0; seed < 200; seed++) names.add(paintBackground(W, H, cells, ART_PALETTE, backgroundStyle(false), new Rng(seed))?.pattern ?? 'none');
        expect(names.size).toBeGreaterThan(20);
        expect(names.has('none')).toBe(false);
    });
});
