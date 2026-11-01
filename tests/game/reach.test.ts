import { describe, expect, test } from 'bun:test';
import { Sim } from '@game/sim';
import { INF, buildDist, fullDist, relaxOpened, tracePath } from '@game/reach';
import { parseCells } from '@game/grid';
import { EMPTY } from '@game/types';
import { Rng } from '@game/rng';
import { lvl } from './helpers';

describe('reachability', () => {
    test('outside is 0: border cells passable for c get dist 1, own color passes through', () => {
        const s = Sim.fromLevel(lvl(`
            00000
            00000
            00000
            00000
            00000
        `, [[[0, 25]]], 1));
        expect(s.distAt(0, 0, 0)).toBe(1);
        expect(s.distAt(0, 4, 2)).toBe(1);
        expect(s.distAt(0, 1, 1)).toBe(2);
        // Deep cell in a solid blob touching the edge is reachable.
        expect(s.distAt(0, 2, 2)).toBe(3);
        expect(s.hasReachable(0)).toBe(true);
        expect(s.reachableCount(0)).toBe(25);
    });

    test('a cell enclosed by another color is unreachable until the enclosing color drains', () => {
        const s = Sim.fromLevel(lvl(`
            00000
            01110
            01210
            01110
            00000
        `, [[[0, 16]], [[1, 8]], [[2, 1]]], 3));
        expect(s.distAt(2, 2, 2)).toBe(INF);
        expect(s.distAt(1, 1, 1)).toBe(INF);
        expect(s.hasReachable(1)).toBe(false);
        expect(s.hasReachable(2)).toBe(false);
        expect(s.reachableCount(2)).toBe(0);

        s.tap(2);
        s.settle();
        expect(s.cellAt(2, 2)).toBe(2); // still enclosed: pod stalls
        expect(s.snapshot().lanes[0]?.state).toBe('stalled');

        s.tap(0);
        s.settle();
        expect(s.distAt(1, 1, 1)).toBe(2);
        expect(s.distAt(2, 2, 2)).toBe(INF);
        expect(s.hasReachable(1)).toBe(true);

        s.tap(1);
        s.settle();
        expect(s.isWon()).toBe(true);
    });

    test('unknown colors have nothing reachable', () => {
        const s = Sim.fromLevel(lvl('0', [[[0, 1]]], 1));
        expect(s.hasReachable(7)).toBe(false);
        expect(s.reachableCount(7)).toBe(0);
        expect(s.colorRemaining(7)).toBe(0);
    });

    test('incremental relaxation matches a full rebuild (reach module, 500 seeds)', () => {
        for (let seed = 1; seed <= 500; seed++) {
            const rng = new Rng(seed);
            const w = rng.int(1, 14);
            const h = rng.int(1, 14);
            const k = rng.int(1, 6);
            const n = w * h;
            let str = '';
            for (let i = 0; i < n; i++) str += rng.chance(0.15) ? '.' : String(rng.below(k));
            const cells = parseCells(str, w, h);
            const dist = new Int16Array(k * n);
            const queue = new Int32Array(n);
            for (let c = 0; c < k; c++) buildDist(cells, w, h, c, dist, c * n, queue);
            const order = rng.shuffle(Array.from({ length: n }, (_, i) => i));
            for (const i of order) {
                const d = cells[i];
                if (d === EMPTY) continue;
                cells[i] = EMPTY;
                for (let c = 0; c < k; c++) {
                    if (c !== d) relaxOpened(cells, w, h, c, dist, c * n, i, queue);
                }
                if (!rng.chance(0.3)) continue;
                for (let c = 0; c < k; c++) {
                    expect(Array.from(dist.subarray(c * n, (c + 1) * n))).toEqual(Array.from(fullDist(cells, w, h, c)));
                }
            }
            for (let c = 0; c < k; c++) {
                expect(Array.from(dist.subarray(c * n, (c + 1) * n))).toEqual(Array.from(fullDist(cells, w, h, c)));
            }
        }
    });

    test('incremental distances inside the sim match a full BFS after every tick (500 seeds)', () => {
        for (let seed = 1; seed <= 500; seed++) {
            const rng = new Rng(seed * 7919);
            const w = rng.int(2, 12);
            const h = rng.int(2, 12);
            const k = rng.int(2, 6);
            const rows: string[] = [];
            const counts = new Array<number>(k).fill(0);
            for (let y = 0; y < h; y++) {
                let row = '';
                for (let x = 0; x < w; x++) {
                    if (rng.chance(0.1)) {
                        row += '.';
                        continue;
                    }
                    // Clumpy boards make enclosures common.
                    const c = x > 0 && rng.chance(0.5) ? Number(row[x - 1] === '.' ? 0 : row[x - 1]) : rng.below(k);
                    counts[c]++;
                    row += String(c);
                }
                rows.push(row);
            }
            const columns = counts.flatMap((count, c) => (count > 0 ? [[[c, count] as [number, number]]] : []));
            if (columns.length === 0) continue;
            const sim = Sim.fromLevel(lvl(rows.join('\n'), columns, columns.length), { events: false });
            for (let col = 0; col < columns.length; col++) sim.tap(col);
            let guard = 0;
            while (!sim.isWon() && guard++ < 5000) {
                sim.tick();
                const cells = parseCells(cellString(sim), w, h);
                for (let c = 0; c < k; c++) {
                    if (sim.colorRemaining(c) === 0) continue;
                    expect(sim.distMap(c)).toEqual(fullDist(cells, w, h, c));
                }
                expect(sim.hash()).toBe(sim.hashFromScratch());
            }
            expect(sim.isWon()).toBe(true);
        }
    });
});

function cellString(sim: Sim): string {
    let s = '';
    for (let y = 0; y < sim.height; y++) {
        for (let x = 0; x < sim.width; x++) {
            const v = sim.cellAt(x, y);
            s += v === EMPTY ? '.' : String(v);
        }
    }
    return s;
}

describe('claim paths', () => {
    test('path steps through strictly decreasing dist to the border, then exits the grid', () => {
        const level = lvl(`
            11111
            1...1
            1.0.1
            1...1
            11.11
        `, [[[0, 1]], [[1, 15]]], 2);
        const s = Sim.fromLevel(level, { emitPaths: true });
        s.tap(0);
        const ev = s.tick();
        const claim = ev.find((e) => e.t === 'claimed');
        if (claim?.t !== 'claimed') throw new Error('expected claim');
        expect(claim.path).toEqual([
            { x: 2, y: 2 },
            { x: 2, y: 3 },
            { x: 2, y: 4 },
            { x: 2, y: 5 },
        ]);
    });

    test('exit point marks each side; neighbor order is up, left, right, down', () => {
        const cells = parseCells('000', 3, 1);
        const d = fullDist(cells, 3, 1, 0);
        expect(tracePath(d, 0, 3, 1, 0)).toEqual([{ x: 0, y: 0 }, { x: 0, y: -1 }]);
        const tall = parseCells('0.0', 1, 3);
        const td = fullDist(tall, 1, 3, 0);
        expect(tracePath(td, 0, 1, 3, 1)).toEqual([{ x: 0, y: 1 }, { x: -1, y: 1 }]);
        const sq = parseCells('1111' + '1001' + '1001' + '1111', 4, 4);
        const sd = fullDist(sq, 4, 4, 0);
        // (2,1) is enclosed for color 0
        expect(sd[1 * 4 + 2]).toBe(INF);
        const right = parseCells('11.' + '1..' + '111', 3, 3);
        const rd = fullDist(right, 3, 3, 0);
        expect(tracePath(rd, 0, 3, 3, 4)).toEqual([{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 }]);
        const down = parseCells('111' + '1.1' + '1.1', 3, 3);
        const dd = fullDist(down, 3, 3, 0);
        expect(tracePath(dd, 0, 3, 3, 4)).toEqual([{ x: 1, y: 1 }, { x: 1, y: 2 }, { x: 1, y: 3 }]);
    });

    test('without emitPaths, claimed events carry an empty path', () => {
        const s = Sim.fromLevel(lvl('00', [[[0, 2]]], 1));
        s.tap(0);
        const ev = s.tick();
        expect(ev[0]).toMatchObject({ t: 'claimed', path: [] });
    });
});
