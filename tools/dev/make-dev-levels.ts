/**
 * Builds the handmade dev levels (`public/levels/dev-*.json`) with correct `solution` arrays.
 *
 *   bun tools/dev/make-dev-levels.ts
 *
 * Boards are generated from simple shapes, pods are dealt deterministically (seeded), and a small DFS solver
 * (tap -> settle, memo on the Zobrist hash) picks the first arrangement that is solvable. Every level is run
 * through `validateLevel` and the stored solution is replayed on the sim to confirm a win.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lvl } from '../../tests/game/helpers';
import type { PodSpecInput } from '../../tests/game/helpers';
import { Rng } from '../../src/game/rng';
import { Sim } from '../../src/game/sim';
import { cellChar, cellColor } from '../../src/game/grid';
import { NEON_PALETTE } from '../../src/data/palette';
import { validateLevel } from '../../src/game/level';
import type { KeySpec, LevelData, PodSpec } from '../../src/game/types';

const OUT_DIR = join(import.meta.dir, '..', '..', 'public', 'levels');

// ---------------------------------------------------------------- solver

/** DFS over legal taps (each tap followed by a full settle). Returns the column list or null. */
function solve(level: LevelData, budget = 400_000): number[] | null {
    const root = Sim.fromLevel(level, { events: false });
    const seen = new Set<number>();
    const path: number[] = [];
    let nodes = 0;
    const dfs = (sim: Sim): boolean => {
        if (sim.isWon()) return true;
        if (++nodes > budget) return false;
        const key = sim.hashKey();
        if (seen.has(key)) return false;
        seen.add(key);
        for (const col of sim.legalTaps()) {
            const next = sim.clone();
            next.tap(col);
            next.settle();
            path.push(col);
            if (dfs(next)) return true;
            path.pop();
        }
        return false;
    };
    root.settle();
    return dfs(root) ? path.slice() : null;
}

/** Replay a stored solution with settled play; true when it wins. */
function replays(level: LevelData): boolean {
    const sim = Sim.fromLevel(level, { events: false });
    sim.settle();
    for (const col of level.solution) {
        if (sim.tapReason(col) !== null) return false;
        sim.tap(col);
        sim.settle();
    }
    return sim.isWon();
}

/** Fraction of random settled playouts that win (rough difficulty read-out). */
function randomWinRate(level: LevelData, runs = 200): number {
    const rng = new Rng(99);
    let wins = 0;
    for (let r = 0; r < runs; r++) {
        const sim = Sim.fromLevel(level, { events: false });
        sim.settle();
        for (;;) {
            const taps = sim.legalTaps();
            if (taps.length === 0) break;
            sim.tap(rng.pick(taps));
            sim.settle();
        }
        if (sim.isWon()) wins++;
    }
    return wins / runs;
}

// ---------------------------------------------------------------- pod dealing

function split(total: number, sizes: number[], rng: Rng): number[] {
    const out: number[] = [];
    let left = total;
    while (left > 0) {
        const want = rng.pick(sizes);
        const take = left - want < Math.min(...sizes) ? left : want;
        out.push(take);
        left -= take;
    }
    return out;
}

function countColors(rows: string[]): number[] {
    const counts = new Array<number>(NEON_PALETTE.length).fill(0);
    for (const row of rows) for (const ch of row) if (ch !== '.') counts[cellColor(ch)]++;
    return counts;
}

function dealColumns(rows: string[], numCols: number, sizes: number[], rng: Rng): PodSpec[][] {
    const pods: PodSpec[] = [];
    countColors(rows).forEach((total, color) => {
        for (const capacity of split(total, sizes, rng)) pods.push({ id: 0, color, capacity });
    });
    rng.shuffle(pods);
    const columns: PodSpec[][] = Array.from({ length: numCols }, () => []);
    pods.forEach((p, i) => columns[i % numCols]!.push(p));
    return columns;
}

function renumber(columns: PodSpec[][]): void {
    // ids in column order (1..n); remap link references through the old identity.
    const byRef = new Map<PodSpec, number>();
    let next = 1;
    for (const col of columns) for (const p of col) byRef.set(p, next++);
    for (const col of columns) {
        for (const p of col) {
            const link = (p as PodSpec & { _link?: PodSpec })._link;
            p.id = byRef.get(p)!;
            if (link) p.link = byRef.get(link)!;
        }
    }
    for (const col of columns) for (const p of col) delete (p as PodSpec & { _link?: PodSpec })._link;
}

function linkPods(a: PodSpec, b: PodSpec): void {
    (a as PodSpec & { _link?: PodSpec })._link = b;
    (b as PodSpec & { _link?: PodSpec })._link = a;
    a.link = 0;
    b.link = 0;
}

function toInputs(columns: PodSpec[][]): PodSpecInput[][] {
    return columns.map((col) => col.map((p) => p as PodSpecInput));
}

// ---------------------------------------------------------------- builders

function ringBoard(size: number, colors: number[]): string[] {
    const rows: string[] = [];
    for (let y = 0; y < size; y++) {
        let row = '';
        for (let x = 0; x < size; x++) {
            const ring = Math.min(x, y, size - 1 - x, size - 1 - y);
            row += cellChar(colors[Math.min(ring, colors.length - 1)]!);
        }
        rows.push(row);
    }
    return rows;
}

function finish(level: LevelData, tries: number): LevelData {
    validateLevel(level);
    const solution = solve(level);
    if (solution === null) throw new Error(`${level.id}: unsolvable arrangement (tries=${tries})`);
    const solved: LevelData = { ...level, solution };
    validateLevel(solved);
    if (!replays(solved)) throw new Error(`${level.id}: stored solution does not replay to a win`);
    return solved;
}

/** 10x10, 3 colors, concentric rings: 0 outside, 1, 2, then 0 again and 1 in the core -> strict order dependence. */
function makeBasic(): LevelData {
    const rows = ringBoard(10, [0, 1, 2, 0, 1]);
    for (let seed = 1; seed < 400; seed++) {
        const rng = new Rng(seed);
        const columns = dealColumns(rows, 4, [8, 12, 16, 20], rng);
        renumber(columns);
        const level = lvl(rows.join('\n'), toInputs(columns), 3, [], { id: 'dev-basic', name: 'Dev Basic', tickMs: 60 });
        const solution = solve(level);
        if (solution === null) continue;
        const rate = randomWinRate({ ...level, solution });
        if (rate > 0.5) continue; // want order to matter
        console.log(`dev-basic: seed ${seed}, random win rate ${(rate * 100).toFixed(0)}%`);
        return finish(level, seed);
    }
    throw new Error('dev-basic: no solvable arrangement found');
}

/** 12x12 with hidden pod, locked pod + key, side-by-side link and stacked link. */
function makeMechanics(): LevelData {
    // Four quadrant blobs plus a core of color 4, with an empty notch top-middle.
    const rows: string[] = [];
    for (let y = 0; y < 12; y++) {
        let row = '';
        for (let x = 0; x < 12; x++) {
            const inCore = Math.abs(x - 5.5) + Math.abs(y - 5.5) <= 3;
            let c = (y < 6 ? 0 : 2) + (x < 6 ? 0 : 1);
            if (inCore) c = 4;
            if (y === 0 && x >= 5 && x <= 6) row += '.';
            else if (y === 11 && (x === 0 || x === 11)) row += '.';
            else row += cellChar(c);
        }
        rows.push(row);
    }
    const sizes = [4, 6, 8];
    for (let seed = 1; seed < 5000; seed++) {
        const rng = new Rng(seed);
        const columns = dealColumns(rows, 4, sizes, rng);
        if (columns.some((c) => c.length < 4)) continue;
        // Stacked link: positions 1,2 of column 0. Side-by-side link: position 0 of column 1 and 2.
        linkPods(columns[0]![1]!, columns[0]![2]!);
        linkPods(columns[1]![0]!, columns[2]![0]!);
        // Hidden: front-adjacent pod of column 3 (revealed when it reaches the front).
        columns[3]![1]!.hidden = true;
        // Locked pod deeper in column 1, key on a random cell of another color.
        const locked = columns[1]![2]!;
        const keyId = 0;
        locked.lock = keyId;
        const keyCells: { x: number; y: number; c: number }[] = [];
        for (let y = 0; y < 12; y++) {
            for (let x = 0; x < 12; x++) {
                const ch = rows[y]![x]!;
                if (ch !== '.' && cellColor(ch) !== locked.color) keyCells.push({ x, y, c: cellColor(ch) });
            }
        }
        const kc = rng.pick(keyCells);
        const keys: KeySpec[] = [{ id: keyId, x: kc.x, y: kc.y }];
        renumber(columns);
        const level = lvl(rows.join('\n'), toInputs(columns), 4, keys, { id: 'dev-mechanics', name: 'Dev Mechanics', tickMs: 60 });
        try {
            validateLevel(level);
        } catch {
            continue;
        }
        const solution = solve(level, 60_000);
        if (solution === null) continue;
        console.log(`dev-mechanics: seed ${seed}, ${solution.length} taps`);
        return finish(level, seed);
    }
    throw new Error('dev-mechanics: no solvable arrangement found');
}

/** 40x40 Voronoi blobs, 7 colors, for the performance check. */
function makeBig(): LevelData {
    const size = 40;
    const colors = 7;
    const rng = new Rng(7);
    const sites = Array.from({ length: 46 }, (_, i) => ({ x: rng.float(0, size), y: rng.float(0, size), c: i % colors }));
    const rows: string[] = [];
    for (let y = 0; y < size; y++) {
        let row = '';
        for (let x = 0; x < size; x++) {
            const r = Math.hypot(x - 19.5, y - 19.5);
            if (r > 20.5 || (r < 3 && x < 20)) {
                row += '.';
                continue;
            }
            let best = 0;
            let bestD = Infinity;
            sites.forEach((s, i) => {
                const d = Math.hypot(x - s.x, y - s.y);
                if (d < bestD) {
                    bestD = d;
                    best = i;
                }
            });
            row += cellChar(sites[best]!.c);
        }
        rows.push(row);
    }
    for (let seed = 1; seed < 400; seed++) {
        const r2 = new Rng(seed);
        const columns = dealColumns(rows, 5, [24, 32, 44, 60], r2);
        renumber(columns);
        const level = lvl(rows.join('\n'), toInputs(columns), 5, [], { id: 'dev-big', name: 'Dev Big', tickMs: 40 });
        const solution = solve(level, 50_000);
        if (solution === null) continue;
        console.log(`dev-big: seed ${seed}, ${solution.length} taps`);
        return finish(level, seed);
    }
    throw new Error('dev-big: no solvable arrangement found');
}

/**
 * 18x18 Voronoi blobs in all 20 palette colors (base-36 cells, full neon palette), for checking pods, lanes, goo and
 * color-blind glyphs with every color. Two sites per color so same-hue colors touch each other.
 */
function makeColors(): LevelData {
    const size = 18;
    const colors = NEON_PALETTE.length;
    const rng = new Rng(11);
    const sites = Array.from({ length: colors * 2 }, (_, i) => ({ x: rng.float(0, size), y: rng.float(0, size), c: i % colors }));
    const rows: string[] = [];
    for (let y = 0; y < size; y++) {
        let row = '';
        for (let x = 0; x < size; x++) {
            if (Math.hypot(x - 8.5, y - 8.5) > 9.2) {
                row += '.';
                continue;
            }
            let best = 0;
            let bestD = Infinity;
            sites.forEach((site, i) => {
                const d = Math.hypot(x - site.x, y - site.y);
                if (d < bestD) {
                    bestD = d;
                    best = i;
                }
            });
            row += cellChar(sites[best]!.c);
        }
        rows.push(row);
    }
    for (let seed = 1; seed < 400; seed++) {
        const r2 = new Rng(seed);
        const columns = dealColumns(rows, 6, [4, 6, 8], r2);
        renumber(columns);
        const level = lvl(rows.join('\n'), toInputs(columns), 5, [], {
            id: 'dev-colors',
            name: 'Dev Colors',
            tickMs: 50,
            palette: NEON_PALETTE.map((c) => c.hex),
        });
        const solution = solve(level, 150_000);
        if (solution === null) continue;
        console.log(`dev-colors: seed ${seed}, ${solution.length} taps`);
        return finish(level, seed);
    }
    throw new Error('dev-colors: no solvable arrangement found');
}

mkdirSync(OUT_DIR, { recursive: true });
const only = process.argv[2];
for (const make of [makeBasic, makeMechanics, makeBig, makeColors]) {
    if (only && !make.name.toLowerCase().includes(only)) continue;
    const level = make();
    const file = join(OUT_DIR, `${level.id}.json`);
    writeFileSync(file, `${JSON.stringify(level)}\n`);
    console.log(`wrote ${file} (${level.width}x${level.height}, ${level.solution.length} taps, ${level.columns.length} columns, ${level.lanes} lanes)`);
}
