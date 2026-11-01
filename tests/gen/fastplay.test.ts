import { describe, expect, test } from 'bun:test';
import { compileLevel } from '@game/level';
import type { RgbaImage } from '../../tools/gen/png';
import { replay } from '../../tools/gen/board';
import { fastWinRate, isFastPlayTrap, podCapacityStats, winRate } from '../../tools/gen/difficulty';
import { generateLevel } from '../../tools/gen/generate';
import { lvl } from '../game/helpers';
import { SCENE } from './fixtures';

describe('fast-play rollouts', () => {
    test('fast play is as good as settled play on a simple level', () => {
        const level = lvl('0011', [[[0, 2]], [[1, 2]]], 2, [], { solution: [0, 1] });
        expect(replay(level).won).toBe(true);
        const c = compileLevel(level);
        expect(fastWinRate(c, 'greedy', 50, 1)).toBe(1);
        expect(fastWinRate(c, 'random', 50, 1)).toBe(1);
        expect(winRate(c, 'greedy', 50, 1)).toBe(1);
    });

    test('rollouts are deterministic for a fixed seed', () => {
        const c = compileLevel(trapLevel());
        expect(fastWinRate(c, 'random', 40, 9)).toBe(fastWinRate(c, 'random', 40, 9));
    });

    test('a constructed trap: waiting wins, tapping early jams the lanes', () => {
        const level = trapLevel();
        expect(replay(level).won).toBe(true);
        const c = compileLevel(level);
        const settled = winRate(c, 'greedy', 100, 1);
        const fast = fastWinRate(c, 'greedy', 100, 1);
        expect(settled).toBeGreaterThanOrEqual(0.5);
        expect(fast).toBeLessThan(0.5 * settled);
        expect(isFastPlayTrap({ ...level.meta.stats, greedyWinRate: settled, fastGreedyWinRate: fast })).toBe(true);
    });

    test('trap flag needs a decent settled rate and a real drop', () => {
        const base = trapLevel().meta.stats;
        expect(isFastPlayTrap({ ...base, greedyWinRate: 0.9, fastGreedyWinRate: 0.4 })).toBe(true);
        expect(isFastPlayTrap({ ...base, greedyWinRate: 0.9, fastGreedyWinRate: 0.5 })).toBe(false);
        expect(isFastPlayTrap({ ...base, greedyWinRate: 0.3, fastGreedyWinRate: 0 })).toBe(false);
        expect(isFastPlayTrap({ ...base, greedyWinRate: 0.9 })).toBe(false);
    });

    test('pod capacity stats', () => {
        const level = lvl('0011', [[[0, 1], [0, 1]], [[1, 2]]], 2, [], { tickMs: 40 });
        expect(podCapacityStats(level)).toEqual({ max: 2, median: 1, longestDrainSec: 0.08 });
    });
});

describe('--max-pod', () => {
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

    for (const difficulty of [0.3, 0.8]) {
        test(`caps pods and the solution still replays (difficulty ${difficulty})`, () => {
            const free = generateLevel({ image: heart(), id: 'h', name: 'H', difficulty, seed: 5, candidates: 6, climb: 8, quick: true });
            const capped = generateLevel({ image: heart(), id: 'h', name: 'H', difficulty, seed: 5, candidates: 6, climb: 8, quick: true, maxPod: 6 });
            const cap = Math.max(...capped.level.columns.flat().map((p) => p.capacity));
            expect(cap).toBeLessThanOrEqual(6);
            expect(capped.stats.maxPodCapacity).toBe(cap);
            expect(replay(capped.level).won).toBe(true);
            // The cap actually bites on this board (uncapped pods are larger).
            expect(free.stats.maxPodCapacity ?? 0).toBeGreaterThan(6);
        });
    }
});

/** Generator-built level on the SCENE board (3 lanes, 19 pods): greedy settled play always wins, real-time greedy play almost never does. */
function trapLevel() {
    return lvl(
        SCENE,
        [
            [[1, 13], [3, 3], [3, 3], [2, 6]],
            [[5, 3], [4, 2], [3, 1], [2, 1], [4, 1]],
            [[3, 3], [2, 5], [0, 11], [0, 9], [4, 2]],
            [[1, 13], [1, 14], [5, 3], [4, 1], [4, 2]],
        ],
        3,
        [],
        { solution: [3, 3, 0, 2, 1, 2, 0, 0, 0, 1, 3, 1, 2, 3, 2, 3, 1, 2, 1] },
    );
}
