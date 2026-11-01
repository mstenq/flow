import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    CURATED_LEVELS,
    DEFAULT_CURVE,
    appendToLevelsJson,
    difficultyAt,
    formatEntry,
    levelName,
    listPngs,
    nameParts,
    planAdditions,
    uniqueNames,
} from '../../tools/gen/add-levels';
import { LEVELS_SRC, idFromFile, loadEntries } from '../../tools/gen/output';
import { writePng, type RgbaImage } from '../../tools/gen/png';

function solid(w: number, h: number, pixel: (x: number, y: number) => [number, number, number]): RgbaImage {
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) data.set([...pixel(x, y), 255], (y * w + x) * 4);
    }
    return { width: w, height: h, data };
}

describe('level names', () => {
    test('derived from the file name', () => {
        const cases: Array<[string, string]> = [
            ['15_burger.png', 'Burger'],
            ['07_bread.png', 'Bread'],
            ['100_taco_dish.png', 'Taco Dish'],
            ['44_frenchfries.png', 'French Fries'],
            ['bell_pepper.png', 'Bell Pepper'],
            ['bell_pepper_p.png', 'Bell Pepper (Alt)'],
            ['gr-milk.png', 'Milk'],
            ['ra-Miso.png', 'Miso Ramen'],
            ['pa-croissant.png', 'Croissant'],
            ['cereal1.png', 'Cereal 1'],
            ['credit_card_2.png', 'Credit Card 2'],
            ['power_strip_typeA.png', 'Power Strip Type A'],
            ['chopping board.png', 'Chopping Board'],
            ['vanilla_or_lemon_ice_cream.png', 'Vanilla or Lemon Ice Cream'],
        ];
        for (const [file, name] of cases) expect(levelName(file)).toBe(name);
    });

    test('parts flag numeric prefixes, categories and _p variants', () => {
        expect(nameParts('15_burger.png')).toMatchObject({ base: 'Burger', numericPrefix: true, alt: false });
        expect(nameParts('fish_p.png')).toMatchObject({ base: 'Fish', alt: true });
        expect(nameParts('gr-meat.png')).toMatchObject({ base: 'Meat', categoryPrefix: true });
    });

    test('unique across variants, and independent of input order', () => {
        const files = ['bell_pepper.png', 'bell_pepper_p.png', '88_salmon.png', 'salmon.png', 'salmon_p.png', 'gr-ketchup.png', 'ketchup.png', '28_cookies.png', 'cookies.png'];
        const names = uniqueNames(files);
        const values = [...names.values()].map((n) => n.toLowerCase());
        expect(new Set(values).size).toBe(files.length);
        expect(names.get('bell_pepper.png')).toBe('Bell Pepper');
        expect(names.get('bell_pepper_p.png')).toBe('Bell Pepper (Alt)');
        expect(names.get('salmon.png')).toBe('Salmon');
        expect(names.get('ketchup.png')).toBe('Ketchup');
        const shuffled = uniqueNames([...files].reverse());
        for (const f of files) expect(shuffled.get(f)).toBe(names.get(f));
    });

    test('names already taken by existing levels are avoided', () => {
        const names = uniqueNames(['heart.png', 'heart_p.png'], ['Heart']);
        expect(names.get('heart.png')).not.toBe('Heart');
        expect(names.get('heart_p.png')).not.toBe('Heart');
        expect(names.get('heart.png')).not.toBe(names.get('heart_p.png'));
    });

    test('levels.json has unique names and ids', () => {
        const entries = loadEntries(); // throws on duplicate ids
        const names = entries.map((e) => e.name.toLowerCase());
        expect(new Set(names).size).toBe(names.length);
    });

    test('every PNG in levels-src gets a unique name and id', () => {
        const files = listPngs(LEVELS_SRC);
        const names = [...uniqueNames(files).values()].map((n) => n.toLowerCase());
        expect(new Set(names).size).toBe(files.length);
        expect(new Set(files.map(idFromFile)).size).toBe(files.length);
    });
});

describe('difficulty curve', () => {
    test('starts easy and ramps to ~0.7 over the first ~90 levels', () => {
        expect(difficultyAt(0)).toBe(0.15);
        expect(difficultyAt(DEFAULT_CURVE.ramp - 1)).toBe(0.7);
        for (let i = 1; i < DEFAULT_CURVE.ramp; i++) expect(difficultyAt(i)).toBeGreaterThanOrEqual(difficultyAt(i - 1));
        expect(DEFAULT_CURVE.ramp).toBeGreaterThanOrEqual(80);
        expect(DEFAULT_CURVE.ramp).toBeLessThanOrEqual(100);
    });

    test('then a sawtooth between ~0.35 and ~0.9: a hard one, then a breather', () => {
        const { ramp, period } = DEFAULT_CURVE;
        const tail = Array.from({ length: period * 5 }, (_, i) => difficultyAt(ramp + i));
        expect(Math.min(...tail)).toBe(0.35);
        expect(Math.max(...tail)).toBe(0.9);
        for (let t = 0; t < 5; t++) {
            const tooth = tail.slice(t * period, (t + 1) * period);
            expect(tooth[0]).toBe(0.35);
            expect(tooth[period - 1]).toBe(0.9);
            for (let i = 1; i < period; i++) expect(tooth[i]).toBeGreaterThan(tooth[i - 1]);
        }
    });

    test('--from / --to / --ramp / --lo / --hi shape it', () => {
        const c = { from: 0.2, to: 0.5, ramp: 10, lo: 0.4, hi: 0.6, period: 3 };
        expect(difficultyAt(0, c)).toBe(0.2);
        expect(difficultyAt(9, c)).toBe(0.5);
        expect([10, 11, 12, 13].map((i) => difficultyAt(i, c))).toEqual([0.4, 0.5, 0.6, 0.4]);
        expect(difficultyAt(0, { ...c, ramp: 1 })).toBe(0.5);
    });
});

describe('levels.json editing', () => {
    const raw = `[\n  { "file": "heart.png", "name": "Heart", "difficulty": 0.1 },\n  { "file": "a.png", "id": "x", "name": "A", "difficulty": 0.2 }\n]\n`;

    test('appends without touching existing text', () => {
        const next = appendToLevelsJson(raw, [formatEntry({ file: 'b.png', name: 'B', difficulty: 0.15 })]);
        expect(next.startsWith(raw.slice(0, raw.lastIndexOf('}') + 1))).toBe(true);
        const parsed = JSON.parse(next);
        expect(parsed.length).toBe(3);
        expect(parsed[2]).toEqual({ file: 'b.png', name: 'B', difficulty: 0.15 });
        expect(parsed.slice(0, 2)).toEqual(JSON.parse(raw));
    });

    test('works on an empty file and with nothing to add', () => {
        expect(JSON.parse(appendToLevelsJson('[]\n', [formatEntry({ file: 'b.png', name: 'B', difficulty: 0.15 })]))).toHaveLength(1);
        expect(appendToLevelsJson(raw, [])).toBe(raw);
    });

    test('explicit ids are written when needed', () => {
        expect(JSON.parse(`[${formatEntry({ file: 'b.png', id: 'b-2', name: 'B', difficulty: 0.3 })}]`)[0].id).toBe('b-2');
    });
});

describe('planAdditions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-add-'));
    // simple (2 colors, small) < medium (3 colors) < complex (many colors, big)
    writePng(join(dir, 'simple.png'), solid(8, 8, (x) => (x < 4 ? [255, 0, 0] : [0, 0, 255])));
    writePng(join(dir, 'medium_thing.png'), solid(16, 16, (x, y) => (y < 5 ? [255, 0, 0] : y < 10 ? [0, 255, 255] : x < 8 ? [255, 230, 0] : [60, 60, 60])));
    writePng(
        join(dir, 'complex.png'),
        solid(32, 32, (x, y) => {
            const palette: Array<[number, number, number]> = [[255, 0, 0], [0, 255, 255], [255, 230, 0], [255, 100, 200], [60, 60, 60], [20, 200, 80], [250, 250, 250], [160, 90, 40]];
            return palette[(Math.floor(x / 8) + 4 * Math.floor(y / 16)) % 8];
        }),
    );
    writePng(join(dir, 'complex_p.png'), solid(32, 32, (x) => [(x * 8) % 256, 40, 200]));
    writePng(join(dir, 'already.png'), solid(8, 8, () => [255, 0, 0]));

    const existing = [{ file: 'already.png', name: 'Already', difficulty: 0.3 }];
    const base = { dir, existing, curve: DEFAULT_CURVE, offset: 0 };

    test('adds only unlisted PNGs, simplest first, with curve difficulties', () => {
        const plan = planAdditions(base);
        expect(plan.skipped).toEqual([]);
        expect(plan.levels.map((l) => l.file)).not.toContain('already.png');
        expect(plan.levels).toHaveLength(4);
        const scores = plan.levels.map((l) => l.score);
        expect([...scores].sort((a, b) => a - b)).toEqual(scores);
        expect(plan.levels[0].file).toBe('simple.png');
        expect(plan.levels.map((l) => l.difficulty)).toEqual(plan.levels.map((_, i) => difficultyAt(i)));
        expect(plan.levels[0].difficulty).toBe(0.15);
        for (const l of plan.levels) expect(l.score).toBe(l.colors * l.cells);
    });

    test('names and ids are unique and a glob filters', () => {
        const plan = planAdditions(base);
        expect(new Set(plan.levels.map((l) => l.name)).size).toBe(plan.levels.length);
        expect(new Set(plan.levels.map((l) => l.id)).size).toBe(plan.levels.length);
        const only = planAdditions({ ...base, glob: 'complex*' });
        expect(only.levels.map((l) => l.file).sort()).toEqual(['complex.png', 'complex_p.png']);
        expect(only.levels.find((l) => l.file === 'complex_p.png')!.name).toBe('Complex (Alt)');
    });

    test('is idempotent: once the plan is appended, a second plan is empty and existing entries are untouched', () => {
        const first = planAdditions(base);
        const added = first.levels.map((l) => ({ file: l.file, name: l.name, difficulty: l.difficulty }));
        const second = planAdditions({ ...base, existing: [...existing, ...added] });
        expect(second.levels).toEqual([]);
        // a top-up continues the curve from `offset`
        writePng(join(dir, 'later.png'), solid(8, 8, (x) => (x < 4 ? [0, 255, 0] : [255, 0, 255])));
        const top = planAdditions({ ...base, existing: [...existing, ...added], offset: 4 });
        expect(top.levels.map((l) => l.file)).toEqual(['later.png']);
        expect(top.levels[0].difficulty).toBe(difficultyAt(4));
        rmSync(dir, { recursive: true, force: true });
    });

    test('hand-made opening levels are not part of the default offset', () => {
        expect(CURATED_LEVELS).toBe(12);
    });
});
