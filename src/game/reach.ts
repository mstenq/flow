/**
 * Per-color BFS distance maps to the outside of the grid.
 *
 * Outside the grid is distance 0; border cells passable for color c have dist 1. A cell is passable for c
 * if it is EMPTY or color c. Impassable / unreachable cells hold `INF`.
 *
 * All maps for a level live in one `Int16Array` of size `numColors × n`; color c starts at `base = c × n`.
 * Fixed neighbor order everywhere: up, left, right, down.
 */
import type { Point } from './types';
import { EMPTY } from './types';

/** Sentinel distance for unreachable / impassable cells. Boards are capped well below this many cells. */
export const INF = 0x7fff;

/** Full multi-source BFS for color `c` into `dist[base .. base + n)`. `queue` is scratch of length ≥ n. */
export function buildDist(
    cells: Uint8Array,
    width: number,
    height: number,
    c: number,
    dist: Int16Array,
    base: number,
    queue: Int32Array,
): void {
    const n = width * height;
    dist.fill(INF, base, base + n);
    let tail = 0;
    for (let i = 0; i < n; i++) {
        const v = cells[i];
        if (v !== EMPTY && v !== c) continue;
        const x = i % width;
        const y = (i - x) / width;
        if (x !== 0 && y !== 0 && x !== width - 1 && y !== height - 1) continue;
        dist[base + i] = 1;
        queue[tail++] = i;
    }
    bfs(cells, width, height, c, dist, base, queue, 0, tail);
}

/**
 * Cell `i` just became EMPTY (it was some color other than `c`). Lower `dist_c` around it.
 * Removing an obstacle can only decrease distances, so a BFS relaxation from `i` is exact.
 */
export function relaxOpened(
    cells: Uint8Array,
    width: number,
    height: number,
    c: number,
    dist: Int16Array,
    base: number,
    i: number,
    queue: Int32Array,
): void {
    const x = i % width;
    const y = (i - x) / width;
    let best: number;
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        best = 1;
    } else {
        best = dist[base + i - width];
        const l = dist[base + i - 1];
        if (l < best) best = l;
        const r = dist[base + i + 1];
        if (r < best) best = r;
        const d = dist[base + i + width];
        if (d < best) best = d;
        best += 1;
    }
    if (best >= dist[base + i]) return;
    dist[base + i] = best;
    queue[0] = i;
    bfs(cells, width, height, c, dist, base, queue, 0, 1);
}

function bfs(
    cells: Uint8Array,
    width: number,
    height: number,
    c: number,
    dist: Int16Array,
    base: number,
    queue: Int32Array,
    head: number,
    tail: number,
): void {
    while (head < tail) {
        const u = queue[head++];
        const nd = dist[base + u] + 1;
        const x = u % width;
        if (u >= width) tail = visit(cells, c, dist, base, queue, tail, u - width, nd);
        if (x > 0) tail = visit(cells, c, dist, base, queue, tail, u - 1, nd);
        if (x < width - 1) tail = visit(cells, c, dist, base, queue, tail, u + 1, nd);
        if (u < (height - 1) * width) tail = visit(cells, c, dist, base, queue, tail, u + width, nd);
    }
}

function visit(
    cells: Uint8Array,
    c: number,
    dist: Int16Array,
    base: number,
    queue: Int32Array,
    tail: number,
    v: number,
    nd: number,
): number {
    if (nd >= dist[base + v]) return tail;
    const cv = cells[v];
    if (cv !== EMPTY && cv !== c) return tail;
    dist[base + v] = nd;
    queue[tail] = v;
    return tail + 1;
}

/**
 * Exit path for a reachable cell: the cell itself, then strictly decreasing dist (first matching neighbor in
 * up/left/right/down order) to a border cell, then one point outside the grid marking the exit side.
 */
export function tracePath(dist: Int16Array, base: number, width: number, height: number, i: number): Point[] {
    let x = i % width;
    let y = (i - x) / width;
    const path: Point[] = [{ x, y }];
    let d = dist[base + i];
    let cur = i;
    while (d > 1) {
        const want = d - 1;
        if (y > 0 && dist[base + cur - width] === want) {
            cur -= width;
            y--;
        } else if (x > 0 && dist[base + cur - 1] === want) {
            cur -= 1;
            x--;
        } else if (x < width - 1 && dist[base + cur + 1] === want) {
            cur += 1;
            x++;
        } else {
            cur += width;
            y++;
        }
        d = want;
        path.push({ x, y });
    }
    path.push(exitPoint(x, y, width, height));
    return path;
}

function exitPoint(x: number, y: number, width: number, height: number): Point {
    if (y === 0) return { x, y: -1 };
    if (x === 0) return { x: -1, y };
    if (x === width - 1) return { x: width, y };
    return { x, y: height };
}

/** Reference (non-incremental) distance map for one color. Used by tests. */
export function fullDist(cells: Uint8Array, width: number, height: number, c: number): Int16Array {
    const n = width * height;
    const dist = new Int16Array(n);
    buildDist(cells, width, height, c, dist, 0, new Int32Array(n));
    return dist;
}
