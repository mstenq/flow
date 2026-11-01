import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RgbaImage } from '../../tools/gen/png';
import { writePng } from '../../tools/gen/png';
import { generateLevel } from '../../tools/gen/generate';
import { formatLevel, runOne } from '../../tools/gen/output';
import { replay } from '../../tools/gen/board';

/** 12×10 heart: dark outline, red fill, pale highlight. */
function heart(): RgbaImage {
    const rows = [
        '..ooo..ooo..',
        '.orrrooorrro',
        'orwwwrrrrrro',
        'orwwrrrrrrro',
        'orwrrrrrrrro',
        '.orrrrrrrro.',
        '..orrrrrro..',
        '...orrrro...',
        '....orro....',
        '.....oo.....',
    ];
    const colors: Record<string, number[]> = { o: [92, 10, 26], r: [232, 40, 60], w: [255, 224, 230] };
    const data = new Uint8Array(12 * 10 * 4);
    rows.forEach((row, y) => {
        for (let x = 0; x < 12; x++) {
            const c = colors[row[x]];
            if (c) data.set([...c, 255], (y * 12 + x) * 4);
        }
    });
    return { width: 12, height: 10, data };
}

const opts = { id: 'heart', name: 'Heart', candidates: 6, climb: 4, quick: true, sourceHash: 'abc' };

describe('determinism', () => {
    test('same input and seed give byte-identical JSON', () => {
        const a = generateLevel({ ...opts, image: heart(), difficulty: 0.6, seed: 42 });
        const b = generateLevel({ ...opts, image: heart(), difficulty: 0.6, seed: 42 });
        expect(formatLevel(a.level)).toBe(formatLevel(b.level));
        expect(replay(a.level).won).toBe(true);
        expect(JSON.parse(formatLevel(a.level))).toEqual(a.level);
    });

    test('a different seed explores a different level', () => {
        const a = generateLevel({ ...opts, image: heart(), difficulty: 0.6, seed: 1 });
        const b = generateLevel({ ...opts, image: heart(), difficulty: 0.6, seed: 2 });
        expect(formatLevel(a.level)).not.toBe(formatLevel(b.level));
    });

    test('runOne writes the same file twice from a PNG on disk', () => {
        const dir = mkdtempSync(join(tmpdir(), 'flow-gen-'));
        try {
            const png = join(dir, 'heart.png');
            writePng(png, heart());
            const run = (sub: string) => {
                const out = join(dir, sub);
                runOne({ png, id: 'heart', name: 'Heart', difficulty: 0.15, seed: 3, report: false, outDir: out, quick: true });
                return readFileSync(join(out, 'heart.json'), 'utf8');
            };
            const first = run('a');
            expect(run('b')).toBe(first);
            const level = JSON.parse(first);
            expect(level.meta.targetDifficulty).toBe(0.15);
            // Easy levels carry no mechanics.
            expect(level.keys).toEqual([]);
            expect(level.columns.flat().some((p: { hidden?: boolean; link?: number }) => p.hidden || p.link)).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
