import { describe, expect, test } from 'bun:test';
import { LevelError, compileLevel, validateLevel } from '@game/level';
import { cellChar, cellColor, cellsToString, isBorder, parseCells } from '@game/grid';
import { EMPTY } from '@game/types';
import type { LevelData } from '@game/types';
import { lvl, podIds } from './helpers';

/** Minimal valid level with a link pair (ids 1..4). */
function valid(): LevelData {
    return lvl(`
        0011
        0.12
        ...2
    `, [
        [[0, 3], { color: 1, capacity: 1, hidden: true }],
        [{ color: 1, capacity: 2, lock: 5 }],
        [{ color: 2, capacity: 1, link: 5 }],
        [{ color: 2, capacity: 1, link: 4 }],
    ], 2, [{ id: 5, x: 1, y: 0 }]);
}

function expectError(mutate: (l: LevelData) => void, message: RegExp): void {
    const level = structuredClone(valid());
    mutate(level);
    expect(() => validateLevel(level)).toThrow(LevelError);
    expect(() => validateLevel(level)).toThrow(message);
}

describe('helpers', () => {
    test('lvl assigns ids in column order and builds a valid level', () => {
        const level = valid();
        expect(podIds(level)).toEqual([[1, 2], [3], [4], [5]]);
        expect(level.width).toBe(4);
        expect(level.height).toBe(3);
        expect(level.cells).toBe('00110.12...2');
        expect(() => validateLevel(level)).not.toThrow();
    });

    test('lvl rejects ragged and empty boards; explicit ids win', () => {
        expect(() => lvl('00\n0', [], 1)).toThrow(/ragged/);
        expect(() => lvl('   ', [], 1)).toThrow(/empty/);
        expect(lvl('0', [[{ id: 42, color: 0, capacity: 1 }]], 1).columns[0][0].id).toBe(42);
    });
});

describe('grid', () => {
    test('parseCells / cellsToString round-trip, errors on bad input', () => {
        const cells = parseCells('0.9', 3, 1);
        expect(Array.from(cells)).toEqual([0, EMPTY, 9]);
        expect(cellsToString(cells)).toBe('0.9');
        expect(() => parseCells('00', 3, 1)).toThrow(/length/);
        expect(() => parseCells('0X0', 3, 1)).toThrow(/invalid cell character 'X'/);
        expect(() => parseCells('0#0', 3, 1)).toThrow(/invalid cell character '#'/);
        expect(isBorder(4, 3, 3)).toBe(false);
        expect(isBorder(5, 3, 3)).toBe(true);
    });

    test('colors 10+ encode as base-36 letters', () => {
        const cells = parseCells('9a.jz', 5, 1);
        expect(Array.from(cells)).toEqual([9, 10, EMPTY, 19, 35]);
        expect(cellsToString(cells)).toBe('9a.jz');
        expect(cellColor('k')).toBe(20);
        expect(cellColor('.')).toBe(EMPTY);
        expect(cellColor('?')).toBe(-1);
        expect(cellChar(EMPTY)).toBe('.');
        expect(() => cellChar(36)).toThrow(/no cell character/);
    });
});

describe('validateLevel', () => {
    test('accepts a valid level and compiles it', () => {
        const c = compileLevel(valid());
        expect(c.numPods).toBe(5);
        expect(c.numColors).toBe(3);
        expect(c.podLink[c.podIndex.get(4)!]).toBe(c.podIndex.get(5)!);
        expect(c.podLock[c.podIndex.get(3)!]).toBe(0);
        expect(c.keyPod[0]).toBe(c.podIndex.get(3)!);
    });

    test('version, dimensions and scalars', () => {
        expectError((l) => ((l as { version: number }).version = 2), /unsupported version 2/);
        expectError((l) => (l.rulesVersion = 1.5), /rulesVersion/);
        expectError((l) => (l.width = 0), /width must be an integer/);
        expectError((l) => (l.height = 500), /height must be an integer/);
        expectError((l) => (l.lanes = 0), /lanes must be an integer >= 1/);
        expectError((l) => (l.tickMs = 0), /tickMs must be > 0/);
        expectError((l) => (l.columns = []), /columns must be a non-empty array/);
        expectError((l) => ((l as { keys: unknown }).keys = null), /keys must be an array/);
        expectError((l) => ((l as { palette: unknown }).palette = 'x'), /palette must be an array/);
        expectError((l) => ((l as { cells: unknown }).cells = 5), /cells must be a string/);
        expectError((l) => ((l as { columns: unknown[] }).columns[0] = 'x' as unknown), /column 0 must be an array/);
    });

    test('cells string must match width × height and use valid characters', () => {
        expectError((l) => (l.cells = l.cells.slice(1)), /does not match width×height 4×3 = 12/);
        expectError((l) => (l.cells = 'A' + l.cells.slice(1)), /invalid cell character/);
        expectError((l) => (l.palette = l.palette.slice(0, 2)), /uses color 2 but palette has 2 entries/);
        expectError((l) => {
            l.cells = '............';
            l.columns = [[]];
            l.keys = [];
        }, /no colored cells/);
    });

    test('per-color capacity totals must equal cell counts exactly', () => {
        expectError((l) => (l.columns[0][0].capacity = 2), /color 0: pod capacities total 2 but the board has 3 cells/);
        expectError((l) => (l.columns[0][0].capacity = 4), /color 0: pod capacities total 4/);
        expectError((l) => l.columns.push([{ id: 99, color: 7, capacity: 1 }]), /color 7: pod capacities total 1 but the board has 0/);
    });

    test('pod fields', () => {
        expectError((l) => (l.columns[1][0].id = 1), /duplicate pod id 1/);
        expectError((l) => (l.columns[0][0].id = 1.5), /non-integer id/);
        expectError((l) => (l.columns[0][0].color = 12), /invalid color 12/);
        expectError((l) => (l.columns[0][0].capacity = 0), /capacity must be an integer >= 1/);
        expectError((l) => ((l.columns[0][0] as { hidden: unknown }).hidden = false), /hidden must be true or absent/);
        expectError((l) => ((l.columns[0][0] as { lock: unknown }).lock = 'k'), /lock must be an integer/);
        expectError((l) => ((l.columns[0][0] as { link: unknown }).link = 'k'), /link must be an integer/);
        expectError((l) => ((l.columns[0][0] as { pushy: unknown }).pushy = false), /pushy must be true or absent/);
    });

    test('no combined mechanics', () => {
        expectError((l) => (l.columns[1][0].hidden = true), /pod 3 combines mechanics/);
        expectError((l) => (l.columns[2][0].lock = 5), /combines mechanics/);
        expectError((l) => (l.columns[0][1].pushy = true), /pod 2 combines mechanics/);
        expectError((l) => (l.columns[1][0].pushy = true), /pod 3 combines mechanics/);
        expectError((l) => (l.columns[2][0].pushy = true), /pod 4 combines mechanics/);
    });

    test('keys reference an existing locked pod and sit on a colored cell', () => {
        expectError((l) => (l.keys[0].x = 1) && (l.keys[0].y = 1), /sits on empty cell \(1, 1\)/);
        expectError((l) => (l.keys[0].x = 9), /outside the board/);
        expectError((l) => (l.keys[0].id = 6), /key 6 does not unlock any pod|locked by missing key 5/);
        expectError((l) => l.keys.push({ id: 5, x: 0, y: 0 }), /duplicate key id 5/);
        expectError((l) => (l.keys[0].id = 2.5), /key has a non-integer id/);
        expectError((l) => {
            l.keys.push({ id: 6, x: 1, y: 0 });
            l.columns[0][0].lock = 6;
        }, /more than one key on cell \(1, 0\)/);
        expectError((l) => {
            l.keys = [];
        }, /pod 3 is locked by missing key 5/);
        expectError((l) => {
            l.columns[0][0].lock = 5;
        }, /key 5 locks more than one pod/);
        expectError((l) => l.keys.push({ id: 8, x: 0, y: 0 }), /key 8 does not unlock any pod/);
    });

    test('links are symmetric, not self, exist, and adjacent when stacked; need 2 lanes', () => {
        expectError((l) => (l.columns[3][0].link = 1), /link is not symmetric: pod 4 → 5 but pod 5 → 1/);
        expectError((l) => (l.columns[2][0].link = 4), /links to itself/);
        expectError((l) => (l.columns[2][0].link = 77), /links to missing pod 77/);
        expectError((l) => (l.lanes = 1), /linked pods but fewer than 2 lanes/);
        expectError((l) => {
            const [p4] = l.columns[2];
            const [p5] = l.columns[3];
            l.columns.splice(2, 2);
            l.columns.push([p4, { id: 9, color: 2, capacity: 1 }, p5]);
            l.cells = l.cells.slice(0, 8) + '..22';
        }, /share column 2 but are not adjacent/);
    });

    test('solution steps must be valid column indices', () => {
        expectError((l) => (l.solution = [0, 9]), /solution step 9 is not a valid column/);
        expectError((l) => ((l as { solution: unknown }).solution = 'x'), /solution must be an array/);
    });
});
