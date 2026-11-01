/**
 * Test helpers for building tiny levels inline. Shared by sim and generator tests.
 *
 * ```ts
 * const level = lvl(`
 *     0011
 *     0.12
 * `, [
 *     [[0, 3], { color: 1, capacity: 3, hidden: true }],   // column 0: front first
 *     [{ color: 2, capacity: 1, lock: 5 }],                // column 1
 * ], 2, [{ id: 5, x: 1, y: 0 }]);
 * ```
 *
 * Pod ids are assigned automatically as 1, 2, 3, … in column order (column 0 front→back, then column 1, …),
 * unless a pod spec gives an explicit `id`. Use `podIds(level)` to look them up.
 */
import type { KeySpec, LevelData, PodSpec } from '@game/types';
import { MAX_COLORS, RULES_VERSION } from '@game/level';
import { cellColor } from '@game/grid';

/** `[color, capacity]` shorthand, or a PodSpec with optional `id`. */
export type PodSpecInput = [color: number, capacity: number] | (Omit<PodSpec, 'id'> & { id?: number });

export const TEST_PALETTE = [
    '#ff2bd6',
    '#00f0ff',
    '#7dff3a',
    '#ffe600',
    '#ff7a1a',
    '#ff2950',
    '#9b5cff',
    '#2f7bff',
    '#00ffa8',
    '#f4f1ff',
];

/** Parse ASCII rows (`.` empty, `0-9` colors). Leading/trailing blank lines and indentation are ignored. */
export function parseAscii(ascii: string): { width: number; height: number; cells: string } {
    const rows = ascii
        .split('\n')
        .map((r) => r.trim())
        .filter((r) => r.length > 0);
    if (rows.length === 0) throw new Error('lvl: empty board');
    const width = rows[0].length;
    for (const r of rows) {
        if (r.length !== width) throw new Error(`lvl: ragged row "${r}" (expected width ${width})`);
    }
    return { width, height: rows.length, cells: rows.join('') };
}

export function pod(input: PodSpecInput, autoId: number): PodSpec {
    if (Array.isArray(input)) return { id: autoId, color: input[0], capacity: input[1] };
    const { id, ...rest } = input;
    return { id: id ?? autoId, ...rest };
}

/** Build a `LevelData` from ASCII rows. `overrides` replaces any top-level field (e.g. `tickMs`, `solution`). */
export function lvl(
    ascii: string,
    columns: PodSpecInput[][],
    lanes: number,
    keys: KeySpec[] = [],
    overrides: Partial<LevelData> = {},
): LevelData {
    const { width, height, cells } = parseAscii(ascii);
    let next = 1;
    const cols = columns.map((column) => column.map((input) => pod(input, next++)));
    return {
        version: 1,
        rulesVersion: RULES_VERSION,
        id: 'test',
        name: 'Test',
        width,
        height,
        palette: TEST_PALETTE.slice(),
        cells,
        keys,
        lanes,
        tickMs: 50,
        columns: cols,
        solution: [],
        meta: {
            seed: 0,
            targetDifficulty: 0,
            difficulty: 0,
            stats: {
                randomWinRate: 0,
                greedyWinRate: 0,
                deadEndRatio: 0,
                minLanes: 0,
                branching: 0,
                hiddenShare: 0,
                lockCount: 0,
                pairCount: 0,
            },
            generatorVersion: 'test',
            sourceHash: '',
        },
        ...overrides,
    };
}

/** Pod ids per column, front first. */
export function podIds(level: LevelData): number[][] {
    return level.columns.map((column) => column.map((p) => p.id));
}

/** Count of each color in an ASCII board, indexed by color. */
export function colorCounts(ascii: string): number[] {
    const { cells } = parseAscii(ascii);
    const counts = new Array<number>(MAX_COLORS).fill(0);
    for (const ch of cells) {
        if (ch !== '.') counts[cellColor(ch)]++;
    }
    return counts;
}
