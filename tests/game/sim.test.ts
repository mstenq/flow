import { describe, expect, test } from 'bun:test';
import { Sim } from '@game/sim';
import type { SimEvent } from '@game/types';
import { EMPTY } from '@game/types';
import { colorCounts, lvl } from './helpers';

function claims(events: SimEvent[]): [number, number][] {
    const out: [number, number][] = [];
    for (const e of events) if (e.t === 'claimed') out.push([e.x, e.y]);
    return out;
}

function count(events: SimEvent[], t: SimEvent['t']): number {
    return events.filter((e) => e.t === t).length;
}

describe('drain order', () => {
    test('golden 5×5: nearest first, tie-break bottom row then left', () => {
        const s = Sim.fromLevel(lvl(`
            00000
            00000
            00000
            00000
            00000
        `, [[[0, 25]]], 1));
        s.tap(0);
        const order: [number, number][] = [];
        for (let i = 0; i < 25; i++) order.push(...claims(s.tick()));
        expect(order).toEqual([
            // dist 1 (border), bottom row first, then left to right within a row
            [0, 4], [1, 4], [2, 4], [3, 4], [4, 4],
            [0, 3], [4, 3],
            [0, 2], [4, 2],
            [0, 1], [4, 1],
            [0, 0], [1, 0], [2, 0], [3, 0], [4, 0],
            // dist 2
            [1, 3], [2, 3], [3, 3],
            [1, 2], [3, 2],
            [1, 1], [2, 1], [3, 1],
            // dist 3
            [2, 2],
        ]);
        expect(s.isWon()).toBe(true);
    });

    test('golden 5×5 mixed: distances route through empty cells', () => {
        const s = Sim.fromLevel(lvl(`
            ..0..
            .000.
            .111.
            .1.1.
            .....
        `, [[[1, 5]], [[0, 4]]], 2));
        s.tap(1);
        const order: [number, number][] = [];
        for (let i = 0; i < 4; i++) order.push(...claims(s.tick()));
        // dist: (2,0)=1, (1,1)=2,(3,1)=2,(2,1)=2
        expect(order).toEqual([[2, 0], [1, 1], [2, 1], [3, 1]]);
        s.tap(0);
        const order1: [number, number][] = [];
        for (let i = 0; i < 5; i++) order1.push(...claims(s.tick()));
        // (1,3),(3,3),(1,2),(3,2) dist 2; (2,2) dist 3 via the empty interior cell (2,3)
        expect(order1).toEqual([[1, 3], [3, 3], [1, 2], [3, 2], [2, 2]]);
    });

    test('a lane further right sees distances updated by a claim earlier in the same tick', () => {
        const ascii = `
            .....
            .111.
            .101.
            .111.
            .....
        `;
        const s = Sim.fromLevel(lvl(ascii, [[[1, 8]], [[0, 1]]], 2));
        s.tap(0); // pod 1 (color 1) → lane 0
        s.tap(1); // pod 2 (color 0) → lane 1
        const t1 = s.tick();
        expect(claims(t1)).toEqual([[1, 3]]);
        const t2 = s.tick();
        // lane 0 opens (2,3); lane 1 claims the center in the same tick
        expect(claims(t2)).toEqual([[2, 3], [2, 2]]);
        expect(t2.find((e) => e.t === 'claimed' && e.lane === 1)).toMatchObject({ podId: 2, color: 0 });

        const r = Sim.fromLevel(lvl(ascii, [[[1, 8]], [[0, 1]]], 2));
        r.tap(1); // color 0 pod now has priority but can't reach yet
        r.tap(0);
        expect(claims(r.tick())).toEqual([[1, 3]]);
        expect(claims(r.tick())).toEqual([[2, 3]]);
        expect(claims(r.tick())).toEqual([[2, 2], [3, 3]]);
    });

    test('lane order is claim priority when two pods share a color', () => {
        const s = Sim.fromLevel(lvl('0000', [[[0, 2]], [[0, 2]]], 2));
        s.tap(1);
        s.tap(0);
        const ev = s.tick();
        expect(ev.filter((e) => e.t === 'claimed')).toMatchObject([
            { podId: 2, lane: 0, x: 0 },
            { podId: 1, lane: 1, x: 1 },
        ]);
    });
});

describe('lanes, settle, dead', () => {
    const partial = `
        0111
        .101
        .111
    `;

    test('a partial pod stays in its lane; lanes full + nothing to claim = dead', () => {
        const s = Sim.fromLevel(lvl(partial, [[[0, 2]], [[1, 8]]], 1));
        expect(s.isSettled()).toBe(true);
        expect(s.isDead()).toBe(false);
        s.tap(0);
        expect(s.isSettled()).toBe(false);
        const ev = s.settle();
        expect(claims(ev)).toEqual([[0, 0]]);
        expect(count(ev, 'dead')).toBe(1);
        const snap = s.snapshot();
        expect(snap.lanes[0]).toEqual({ podId: 1, color: 0, capacity: 2, remaining: 1, state: 'stalled', link: null });
        expect(s.legalTaps()).toEqual([]);
        expect(s.tapReason(1)).toBe('noLane');
        expect(s.isSettled()).toBe(true);
        expect(s.isDead()).toBe(true);
        expect(snap.dead).toBe(true);
        expect(snap.won).toBe(false);
        // dead is emitted once
        expect(count(s.tick(), 'dead')).toBe(0);
        expect(count(s.settle(), 'dead')).toBe(0);
    });

    test('with a second lane the stalled pod resumes once its color opens up', () => {
        const s = Sim.fromLevel(lvl(partial, [[[0, 2]], [[1, 8]]], 2));
        s.tap(0);
        s.settle();
        expect(s.snapshot().lanes[0]?.state).toBe('stalled');
        expect(s.isDead()).toBe(false);
        expect(s.legalTaps()).toEqual([1]);
        s.tap(1);
        expect(s.snapshot().lanes[0]?.state).toBe('stalled');
        expect(s.snapshot().lanes[1]?.state).toBe('draining');
        const ev = s.settle();
        expect(count(ev, 'podCompleted')).toBe(2);
        expect(count(ev, 'won')).toBe(1);
        expect(s.isWon()).toBe(true);
        expect(s.isDead()).toBe(false);
        expect(s.snapshot().won).toBe(true);
    });

    test('pods complete and free their lane; completion event carries the lane', () => {
        const s = Sim.fromLevel(lvl('000', [[[0, 1], [0, 2]]], 1));
        s.tap(0);
        const ev = s.tick();
        expect(ev).toEqual([
            { t: 'claimed', podId: 1, lane: 0, x: 0, y: 0, color: 0, path: [] },
            { t: 'podCompleted', podId: 1, lane: 0 },
        ]);
        expect(s.snapshot().lanes).toEqual([null]);
        expect(s.legalTaps()).toEqual([0]);
    });

    test('tap goes into the leftmost free lane', () => {
        const s = Sim.fromLevel(lvl('0011', [[[0, 1], [0, 1]], [[1, 2]]], 3));
        s.tap(0);
        s.tap(1);
        s.tick(); // lane 0 completes
        const ev = s.tap(0);
        expect(ev).toEqual([{ t: 'tapped', podIds: [2], lanes: [0] }]);
    });

    test('illegal taps throw and report reasons', () => {
        const s = Sim.fromLevel(lvl('00', [[[0, 2]], []], 1));
        expect(s.tapReason(1)).toBe('empty');
        expect(s.tapReason(-1)).toBe('empty');
        expect(s.tapReason(5)).toBe('empty');
        expect(s.tapReason(0.5)).toBe('empty');
        expect(() => s.tap(1)).toThrow(/empty/);
        expect(s.canTap(0)).toBe(true);
        expect(s.frontPodId(1)).toBe(-1);
        expect(s.frontColor(1)).toBe(-1);
        expect(s.frontCapacity(1)).toBe(-1);
        expect(s.frontCapacity(0)).toBe(2);
        expect(s.columnLength(0)).toBe(1);
        expect(s.columnLength(1)).toBe(0);
    });

    test('ticks on a settled board are no-ops', () => {
        const s = Sim.fromLevel(lvl('0', [[[0, 1]]], 1));
        const h = s.hash();
        expect(s.tick()).toEqual([]);
        expect(s.hash()).toBe(h);
        expect(s.ticks).toBe(1);
    });

    test('win when the board is empty, emitted once', () => {
        const s = Sim.fromLevel(lvl(`
            01
            10
        `, [[[0, 2]], [[1, 2]]], 2));
        expect(s.cellsRemaining).toBe(4);
        s.tap(0);
        s.tap(1);
        const ev = s.settle();
        expect(count(ev, 'won')).toBe(1);
        expect(ev[ev.length - 1]).toEqual({ t: 'won' });
        expect(s.isWon()).toBe(true);
        expect(s.cellsRemaining).toBe(0);
        expect(s.snapshot().cells.every((c) => c === EMPTY)).toBe(true);
        expect(s.snapshot().lanes).toEqual([null, null]);
        expect(s.tick()).toEqual([]);
        expect(s.legalTaps()).toEqual([]);
    });

    test('level whose front pods are all locked is dead from the start', () => {
        const s = Sim.fromLevel(lvl('01', [[{ color: 0, capacity: 1, lock: 1 }], [{ color: 1, capacity: 1, lock: 2 }]], 1, [
            { id: 1, x: 1, y: 0 },
            { id: 2, x: 0, y: 0 },
        ]));
        expect(s.isDead()).toBe(true);
        expect(s.tick()).toEqual([{ t: 'dead' }]);
    });
});

describe('snapshot', () => {
    test('exposes board, lanes, columns, keys and flags', () => {
        const level = lvl(`
            001
            12.
        `, [
            [[0, 2], { color: 1, capacity: 1, hidden: true }],
            [{ color: 1, capacity: 1, lock: 9 }],
            [[2, 1]],
        ], 2, [{ id: 9, x: 1, y: 0 }]);
        const s = Sim.fromLevel(level);
        const snap = s.snapshot();
        expect(snap.width).toBe(3);
        expect(snap.height).toBe(2);
        expect(Array.from(snap.cells)).toEqual([0, 0, 1, 1, 2, EMPTY]);
        expect(snap.keys).toEqual([{ id: 9, x: 1, y: 0, podId: 3 }]);
        expect(snap.lanes).toEqual([null, null]);
        expect(snap.columns).toEqual([
            [
                { id: 1, color: 0, capacity: 2, hidden: false, locked: false, lock: null, link: null, pushy: false },
                { id: 2, color: null, capacity: null, hidden: true, locked: false, lock: null, link: null, pushy: false },
            ],
            [{ id: 3, color: null, capacity: null, hidden: false, locked: true, lock: 9, link: null, pushy: false }],
            [{ id: 4, color: 2, capacity: 1, hidden: false, locked: false, lock: null, link: null, pushy: false }],
        ]);
        expect(snap.settled).toBe(true);
        expect(snap.dead).toBe(false);
        expect(snap.ticks).toBe(0);
        expect([s.width, s.height, s.columnCount, s.laneCount]).toEqual([3, 2, 3, 2]);
        expect(s.colorRemaining(1)).toBe(2);
        expect(colorCounts(`
            001
            12.
        `).slice(0, 3)).toEqual([2, 2, 1]);
        // snapshot cells are a copy
        snap.cells[0] = EMPTY;
        expect(s.cellAt(0, 0)).toBe(0);
    });
});

describe('determinism and cloning', () => {
    const ascii = `
        0012
        0112
        2210
        .010
    `;
    const columns: [number, number][][] = [
        [[0, 3], [1, 2]],
        [[2, 4], [0, 3]],
        [[1, 3]],
    ];

    function run(taps: number[], emitPaths = true): { events: SimEvent[]; hash: bigint } {
        const s = Sim.fromLevel(lvl(ascii, columns, 2), { emitPaths });
        const events: SimEvent[] = [];
        for (const col of taps) {
            events.push(...s.tap(col));
            events.push(...s.settle());
        }
        return { events, hash: s.hash() };
    }

    test('same taps give the same event stream and hash', () => {
        const taps = [0, 1, 0, 2, 1];
        const a = run(taps);
        const b = run(taps);
        expect(a.events).toEqual(b.events);
        expect(a.hash).toBe(b.hash);
        expect(a.events.some((e) => e.t === 'won')).toBe(true);
    });

    test('clone() is independent', () => {
        const s = Sim.fromLevel(lvl(ascii, columns, 2));
        s.tap(0);
        s.tick();
        const c = s.clone();
        expect(c.hash()).toBe(s.hash());
        expect(c.snapshot()).toEqual(s.snapshot());
        const before = s.snapshot();
        const h = s.hash();
        c.settle();
        c.tap(1);
        c.settle();
        expect(s.snapshot()).toEqual(before);
        expect(s.hash()).toBe(h);
        expect(c.hash()).not.toBe(h);
        // the original continues identically to a fresh replay
        s.settle();
        const fresh = Sim.fromLevel(lvl(ascii, columns, 2));
        fresh.tap(0);
        fresh.settle();
        expect(s.hash()).toBe(fresh.hash());
        expect(s.ticks).toBe(fresh.ticks);
    });

    test('events: false gives the same state with empty event arrays', () => {
        const a = Sim.fromLevel(lvl(ascii, columns, 2));
        const b = Sim.fromLevel(lvl(ascii, columns, 2), { events: false });
        for (const col of [0, 1, 0, 2, 1]) {
            a.tap(col);
            a.settle();
            expect(b.tap(col)).toEqual([]);
            expect(b.settle()).toEqual([]);
            expect(b.hash()).toBe(a.hash());
        }
        expect(b.tick()).toEqual([]);
        expect(b.clone().isWon()).toBe(true);
    });

    test('hash is path-independent and matches a from-scratch recompute', () => {
        const level = lvl(`
            0..1
        `, [[[0, 1]], [[1, 1]]], 2);
        const a = Sim.fromLevel(level);
        const b = Sim.fromLevel(level);
        const start = a.hash();
        a.tap(0);
        expect(a.hash()).not.toBe(start);
        expect(a.hash()).toBe(a.hashFromScratch());
        a.settle();
        a.tap(1);
        a.settle();
        b.tap(1);
        b.settle();
        b.tap(0);
        b.settle();
        expect(a.hash()).toBe(b.hash());
        expect(a.hashKey()).toBe(b.hashKey());
        expect(a.hash()).toBe(a.hashFromScratch());
        expect(Number.isSafeInteger(a.hashKey())).toBe(true);
    });

    test('hashKey distinguishes lane positions and remaining counts', () => {
        const level = lvl('0011', [[[0, 2]], [[1, 2]]], 2);
        const a = Sim.fromLevel(level);
        a.tap(0);
        a.tap(1);
        const b = Sim.fromLevel(level);
        b.tap(1);
        b.tap(0);
        expect(a.hashKey()).not.toBe(b.hashKey());
        const c = a.clone();
        c.tick();
        expect(c.hashKey()).not.toBe(a.hashKey());
        expect(c.hash()).toBe(c.hashFromScratch());
    });
});
