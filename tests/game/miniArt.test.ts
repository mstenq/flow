import { describe, expect, test } from 'bun:test';
import { CELL_CHARS } from '@game/grid';
import { miniCellPx, miniColorAt } from '../../src/phaser/view/miniArt';

describe('mini art cell decoding', () => {
    test("base-36 cells: '0'-'9' are 0-9 and 'a'-'z' are 10-35", () => {
        const cells = CELL_CHARS;
        for (let i = 0; i < 36; i++) expect(miniColorAt(cells, 36, i)).toBe(i);
        expect(miniColorAt('a.f', 20, 0)).toBe(10);
        expect(miniColorAt('a.f', 20, 2)).toBe(15);
    });

    test('empty, invalid, out-of-range and palette-overflow cells are skipped', () => {
        expect(miniColorAt('.', 5, 0)).toBe(-1);
        expect(miniColorAt('?A', 20, 0)).toBe(-1);
        expect(miniColorAt('?A', 20, 1)).toBe(-1);
        expect(miniColorAt('01', 5, 5)).toBe(-1);
        expect(miniColorAt('9', 5, 0)).toBe(-1);
        expect(miniColorAt('k', 20, 0)).toBe(-1); // 'k' = 20 is past a 20-color palette
        expect(miniColorAt('j', 20, 0)).toBe(19);
    });

    test('cell pixel size stays whole and bounded', () => {
        expect(miniCellPx(48, 48)).toBe(8);
        expect(miniCellPx(1, 1)).toBeGreaterThanOrEqual(2);
    });
});
