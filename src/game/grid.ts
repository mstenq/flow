/** Board storage helpers: cell parsing, per-color cell lists (swap-remove). Pure TS. */
import { EMPTY } from './types';

/** Color ids encode as one base-36 character: '0'..'9' = 0..9, 'a'..'z' = 10..35. '.' = empty. */
export const CELL_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Color id for one cell character, `EMPTY` for '.', or -1 if the character is invalid. */
export function cellColor(ch: string): number {
    if (ch === '.') return EMPTY;
    return CELL_CHARS.indexOf(ch);
}

/** Cell character for a color id (or '.' for `EMPTY`). */
export function cellChar(color: number): string {
    if (color === EMPTY) return '.';
    const ch = CELL_CHARS[color];
    if (ch === undefined) throw new Error(`color ${color} has no cell character (max ${CELL_CHARS.length - 1})`);
    return ch;
}

/** Parse the level `cells` string (see `CELL_CHARS`) into a `Uint8Array` (EMPTY = 255). */
export function parseCells(cells: string, width: number, height: number): Uint8Array {
    const n = width * height;
    if (cells.length !== n) {
        throw new Error(`cells length ${cells.length} does not match width×height ${width}×${height} = ${n}`);
    }
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        const c = cellColor(cells[i]);
        if (c < 0) {
            throw new Error(`invalid cell character '${cells[i]}' at index ${i} (x=${i % width}, y=${Math.floor(i / width)})`);
        }
        out[i] = c;
    }
    return out;
}

/** Inverse of `parseCells`. */
export function cellsToString(cells: Uint8Array): string {
    let s = '';
    for (let i = 0; i < cells.length; i++) s += cellChar(cells[i]);
    return s;
}

export function isBorder(i: number, width: number, height: number): boolean {
    const x = i % width;
    const y = (i - x) / width;
    return x === 0 || y === 0 || x === width - 1 || y === height - 1;
}

/**
 * Per-color lists of remaining cell indices packed in one array.
 * Color c occupies `list[offset[c] .. offset[c] + count[c])`; `pos[i]` is the slot of cell i.
 * `offset` is static per level; `list`, `pos`, `count` are mutable sim state.
 */
export interface ColorLists {
    offset: Int32Array;
    list: Int32Array;
    pos: Int32Array;
    count: Int32Array;
}

export function buildColorLists(cells: Uint8Array, numColors: number): ColorLists {
    const n = cells.length;
    const count = new Int32Array(numColors);
    for (let i = 0; i < n; i++) {
        if (cells[i] !== EMPTY) count[cells[i]]++;
    }
    const offset = new Int32Array(numColors + 1);
    for (let c = 0; c < numColors; c++) offset[c + 1] = offset[c] + count[c];
    const fill = offset.slice(0, numColors);
    const list = new Int32Array(n);
    const pos = new Int32Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
        const c = cells[i];
        if (c === EMPTY) continue;
        list[fill[c]] = i;
        pos[i] = fill[c];
        fill[c]++;
    }
    return { offset, list, pos, count };
}

/** Swap-remove cell `i` (of color `c`) from its color list. */
export function removeFromColorList(
    list: Int32Array,
    pos: Int32Array,
    offset: Int32Array,
    count: Int32Array,
    c: number,
    i: number,
): void {
    const slot = pos[i];
    const last = offset[c] + count[c] - 1;
    const moved = list[last];
    list[slot] = moved;
    pos[moved] = slot;
    pos[i] = -1;
    count[c]--;
}
