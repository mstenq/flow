import { describe, expect, test } from 'bun:test';
import { DEV_LEVELS, difficultyTier, mergeLevelEntries, nextLevelId, parseLevelIndex, repeatEntries } from '@game/levelList';
import { parseFlags } from '@game/urlParams';

describe('levelList', () => {
    test('parseLevelIndex keeps well-formed entries only', () => {
        expect(parseLevelIndex(null)).toEqual([]);
        expect(parseLevelIndex({})).toEqual([]);
        const out = parseLevelIndex([{ id: 'a', name: 'A', width: 3, height: 4, difficulty: 0.5, lanes: 3 }, { name: 'no id' }, 7, { id: 'b' }]);
        expect(out.map((e) => e.id)).toEqual(['a', 'b']);
        expect(out[0]!.lanes).toBe(3);
        expect(out[1]).toEqual({ id: 'b', name: 'b', width: 0, height: 0, difficulty: 0, lanes: 0 });
    });

    test('difficultyTier slices 0..1 into tiers 1..5', () => {
        expect([0, 0.19, 0.2, 0.45, 0.6, 0.79, 0.8, 1, 1.4, -1].map(difficultyTier)).toEqual([1, 1, 2, 3, 4, 4, 5, 5, 5, 1]);
    });

    test('mergeLevelEntries appends dev levels, deduped', () => {
        const idx = parseLevelIndex([{ id: 'x' }, { id: 'dev-basic' }]);
        expect(mergeLevelEntries(idx, false).map((e) => e.id)).toEqual(['x', 'dev-basic']);
        const merged = mergeLevelEntries(idx, true).map((e) => e.id);
        expect(merged).toEqual(['x', 'dev-basic', ...DEV_LEVELS.map((e) => e.id).filter((id) => id !== 'dev-basic')]);
    });

    test('nextLevelId', () => {
        const list = mergeLevelEntries(parseLevelIndex([{ id: 'x' }, { id: 'y' }]), false);
        expect(nextLevelId(list, 'x')).toBe('y');
        expect(nextLevelId(list, 'y')).toBe(null);
        expect(nextLevelId(list, 'nope')).toBe(null);
    });
});

describe('repeatEntries (?fakelevels=N)', () => {
    const base = parseLevelIndex([
        { id: 'a', name: 'A', width: 2, height: 1, difficulty: 0.1, palette: ['#ff0000'], cells: '00' },
        { id: 'b', name: 'B', width: 1, height: 1, difficulty: 0.2 },
        { id: 'c', name: 'C' },
    ]);

    test('repeats in order up to N with unique ids', () => {
        const out = repeatEntries(base, 8);
        expect(out).toHaveLength(8);
        expect(out.map((e) => e.id)).toEqual(['a', 'b', 'c', 'a~1', 'b~1', 'c~1', 'a~2', 'b~2']);
        expect(new Set(out.map((e) => e.id)).size).toBe(8);
        expect(out[3]!.name).toBe('A 2');
        expect(out[3]!.cells).toBe('00');
    });

    test('400 entries from 12, and no-ops when already long enough or empty', () => {
        const twelve = Array.from({ length: 12 }, (_, i) => ({ ...base[0]!, id: `l${i}` }));
        const out = repeatEntries(twelve, 400);
        expect(out).toHaveLength(400);
        expect(new Set(out.map((e) => e.id)).size).toBe(400);
        expect(repeatEntries(base, 2)).toHaveLength(3);
        expect(repeatEntries([], 10)).toEqual([]);
    });

    test('parsing a ~0.5 MB index is fast', () => {
        const cells = '0123456789abcdefghij'.repeat(60);
        const json = JSON.stringify(Array.from({ length: 400 }, (_, i) => ({ id: `l${i}`, name: `L${i}`, width: 40, height: 30, difficulty: 0.5, palette: ['#ff2bd6', '#00f0ff'], cells })));
        expect(json.length).toBeGreaterThan(450_000);
        const t0 = performance.now();
        const parsed = parseLevelIndex(JSON.parse(json));
        expect(performance.now() - t0).toBeLessThan(150);
        expect(parsed).toHaveLength(400);
        expect(parsed[399]!.cells).toBe(cells);
    });
});

describe('urlParams flags', () => {
    test('autoplay and speed', () => {
        expect(parseFlags('?autoplay=1').autoplay).toBe('solution');
        expect(parseFlags('?autoplay=random').autoplay).toBe('random');
        expect(parseFlags('?autoplay=0').autoplay).toBe('off');
        expect(parseFlags('').autoplay).toBe('off');
        expect(parseFlags('?speed=2').speed).toBe(2);
        expect(parseFlags('?speed=3').speed).toBe(1);
        expect(parseFlags('').pace).toBe(1);
        expect(parseFlags('?speed=0.33').pace).toBe(0.33);
        expect(parseFlags('?speed=0.33').speed).toBe(1);
        expect(parseFlags('?speed=2').pace).toBe(1);
        expect(parseFlags('?speed=0.01').pace).toBe(1);
        expect(parseFlags('?speed=abc').pace).toBe(1);
    });
});
