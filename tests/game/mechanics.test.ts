import { describe, expect, test } from 'bun:test';
import { Sim } from '@game/sim';
import type { SimEvent } from '@game/types';
import { lvl } from './helpers';

function ofType<T extends SimEvent['t']>(events: SimEvent[], t: T): Extract<SimEvent, { t: T }>[] {
    return events.filter((e): e is Extract<SimEvent, { t: T }> => e.t === t);
}

describe('locked pods + keys', () => {
    test('not tappable → key cell drained → keyCollected + unlocked → tappable', () => {
        const s = Sim.fromLevel(lvl('0011', [[[0, 2]], [{ color: 1, capacity: 2, lock: 7 }]], 2, [{ id: 7, x: 1, y: 0 }]));
        expect(s.legalTaps()).toEqual([0]);
        expect(s.tapReason(1)).toBe('locked');
        expect(() => s.tap(1)).toThrow(/locked/);
        expect(s.snapshot().columns[1][0]).toMatchObject({ color: null, capacity: null, locked: true, lock: 7 });

        s.tap(0);
        const t1 = s.tick();
        expect(ofType(t1, 'keyCollected')).toEqual([]);
        expect(s.tapReason(1)).toBe('locked');
        const t2 = s.tick();
        expect(t2).toEqual([
            { t: 'claimed', podId: 1, lane: 0, x: 1, y: 0, color: 0, path: [] },
            { t: 'keyCollected', keyId: 7, x: 1, y: 0, podId: 2 },
            { t: 'unlocked', podId: 2 },
            { t: 'podCompleted', podId: 1, lane: 0 },
        ]);
        expect(s.snapshot().keys).toEqual([]);
        expect(s.snapshot().columns[1][0]).toEqual({
            id: 2,
            color: 1,
            capacity: 2,
            hidden: false,
            locked: false,
            lock: null,
            link: null,
            pushy: false,
        });
        expect(s.legalTaps()).toEqual([1]);
        s.tap(1);
        s.settle();
        expect(s.isWon()).toBe(true);
    });

    test('a key collected while its pod is deep in a column unlocks it; it becomes tappable at the front', () => {
        const s = Sim.fromLevel(lvl('0011', [[[0, 2]], [[1, 1], { color: 1, capacity: 1, lock: 3 }]], 1, [{ id: 3, x: 0, y: 0 }]));
        s.tap(0);
        const ev = s.tick();
        expect(ofType(ev, 'unlocked')).toEqual([{ t: 'unlocked', podId: 3 }]);
        expect(s.snapshot().columns[1][1]).toMatchObject({ id: 3, color: 1, capacity: 1, locked: false });
        s.settle();
        s.tap(1);
        s.settle();
        expect(s.legalTaps()).toEqual([1]);
        s.tap(1);
        s.settle();
        expect(s.isWon()).toBe(true);
    });

    test('a locked pod at the front with no way to get its key is dead once settled', () => {
        const s = Sim.fromLevel(lvl(`
            111
            101
            111
        `, [[{ color: 0, capacity: 1, lock: 1 }], [[1, 8]]], 1, [{ id: 1, x: 1, y: 1 }]));
        expect(s.legalTaps()).toEqual([1]);
        s.tap(1);
        s.settle();
        expect(s.isDead()).toBe(true);
    });
});

describe('hidden pods', () => {
    test('revealed only when at the front, event emitted once; front-at-start reveals silently', () => {
        const s = Sim.fromLevel(lvl('0000', [[
            { color: 0, capacity: 1, hidden: true },
            [0, 1],
            { color: 0, capacity: 1, hidden: true },
            { color: 0, capacity: 1, hidden: true },
        ]], 1));
        const snap = s.snapshot();
        expect(snap.columns[0][0]).toMatchObject({ id: 1, color: 0, capacity: 1, hidden: false });
        expect(snap.columns[0][2]).toMatchObject({ id: 3, color: null, capacity: null, hidden: true });

        const all: SimEvent[] = [];
        all.push(...s.tap(0));
        expect(ofType(all, 'revealed')).toEqual([]);
        all.push(...s.settle());
        const tap2 = s.tap(0);
        expect(ofType(tap2, 'revealed')).toEqual([{ t: 'revealed', podId: 3 }]);
        expect(s.snapshot().columns[0][0]).toMatchObject({ id: 3, color: 0, hidden: false });
        expect(s.snapshot().columns[0][1]).toMatchObject({ id: 4, hidden: true });
        all.push(...tap2);
        all.push(...s.settle());
        const tap3 = s.tap(0);
        expect(ofType(tap3, 'revealed')).toEqual([{ t: 'revealed', podId: 4 }]);
        all.push(...tap3);
        all.push(...s.settle());
        all.push(...s.tap(0));
        all.push(...s.settle());
        expect(ofType(all, 'revealed').map((e) => e.podId)).toEqual([3, 4]);
        expect(s.isWon()).toBe(true);
    });

    test('tap events: tapped first, then revealed', () => {
        const s = Sim.fromLevel(lvl('00', [[[0, 1], { color: 0, capacity: 1, hidden: true }]], 2));
        expect(s.tap(0)).toEqual([
            { t: 'tapped', podIds: [1], lanes: [0] },
            { t: 'revealed', podId: 2 },
        ]);
    });
});

describe('linked pairs', () => {
    test('side by side with a gap column: tapping either moves both, tapped pod gets the leftmost lane', () => {
        const level = lvl('00112', [[{ color: 0, capacity: 2, link: 3 }], [[2, 1]], [{ color: 1, capacity: 2, link: 1 }]], 3);
        const s = Sim.fromLevel(level);
        expect(s.legalTaps()).toEqual([0, 1, 2]);
        const ev = s.tap(2);
        expect(ev).toEqual([{ t: 'tapped', podIds: [3, 1], lanes: [0, 1] }]);
        expect(s.columnLength(0)).toBe(0);
        expect(s.columnLength(2)).toBe(0);
        const lanes = s.snapshot().lanes;
        expect(lanes[0]).toMatchObject({ podId: 3, link: 1, state: 'draining' });
        expect(lanes[1]).toMatchObject({ podId: 1, link: 3 });
        s.tick();
        const t2 = s.tick();
        expect(ofType(t2, 'podCompleted')).toEqual([
            { t: 'podCompleted', podId: 3, lane: 0 },
            { t: 'podCompleted', podId: 1, lane: 1 },
        ]);

        const b = Sim.fromLevel(level);
        expect(b.tap(0)).toEqual([{ t: 'tapped', podIds: [1, 3], lanes: [0, 1] }]);
    });

    test('stacked consecutively: front tap moves both', () => {
        const s = Sim.fromLevel(lvl('011112', [[{ color: 0, capacity: 1, link: 2 }, { color: 1, capacity: 4, link: 1 }, [2, 1]]], 2));
        expect(s.tap(0)).toEqual([{ t: 'tapped', podIds: [1, 2], lanes: [0, 1] }]);
        expect(s.columnLength(0)).toBe(1);
        expect(s.frontPodId(0)).toBe(3);
    });

    test('needs 2 free lanes', () => {
        const s = Sim.fromLevel(lvl(`
            1112
            1012
            1112
        `, [[[0, 1]], [{ color: 1, capacity: 8, link: 4 }], [[2, 2]], [{ color: 2, capacity: 1, link: 2 }]], 3));
        expect(s.tapReason(1)).toBe(null);
        s.tap(0); // stalls (enclosed)
        s.tap(2);
        expect(s.freeLaneCount()).toBe(1);
        expect(s.tapReason(1)).toBe('noLane');
        expect(s.tapReason(3)).toBe('noLane');
    });

    test('partner must be at the front of another column', () => {
        const s = Sim.fromLevel(lvl('00111', [[{ color: 0, capacity: 1, link: 3 }], [[1, 1], { color: 1, capacity: 1, link: 1 }], [[0, 1]], [[1, 1]]], 4));
        expect(s.tapReason(0)).toBe('partnerUnavailable');
        expect(s.legalTaps()).toEqual([1, 2, 3]);
        s.tap(1);
        expect(s.tapReason(0)).toBe(null);
        expect(s.tapReason(1)).toBe(null);
    });

    test('holds the lane, full and waiting, until the partner is full; both leave in the same tick', () => {
        const s = Sim.fromLevel(lvl('0111', [[{ color: 0, capacity: 1, link: 2 }], [{ color: 1, capacity: 3, link: 1 }]], 2));
        s.tap(0);
        const t1 = s.tick();
        expect(ofType(t1, 'podCompleted')).toEqual([]);
        let snap = s.snapshot();
        expect(snap.lanes[0]).toMatchObject({ podId: 1, remaining: 0, state: 'waiting' });
        expect(snap.lanes[1]).toMatchObject({ podId: 2, remaining: 2, state: 'draining' });
        expect(s.isSettled()).toBe(false);
        s.tick();
        snap = s.snapshot();
        expect(snap.lanes[0]?.state).toBe('waiting');
        const t3 = s.tick();
        expect(ofType(t3, 'podCompleted')).toEqual([
            { t: 'podCompleted', podId: 1, lane: 0 },
            { t: 'podCompleted', podId: 2, lane: 1 },
        ]);
        expect(s.snapshot().lanes).toEqual([null, null]);
        expect(ofType(t3, 'won')).toHaveLength(1);
    });

    test('a waiting pod whose partner stalls keeps both lanes; settled', () => {
        const s = Sim.fromLevel(lvl(`
            0111
            .121
            .111
        `, [[{ color: 0, capacity: 1, link: 2 }], [{ color: 2, capacity: 1, link: 1 }], [[1, 8]]], 2));
        s.tap(0);
        s.settle();
        const snap = s.snapshot();
        expect(snap.lanes[0]?.state).toBe('waiting');
        expect(snap.lanes[1]?.state).toBe('stalled');
        expect(s.isSettled()).toBe(true);
        expect(s.isDead()).toBe(true);
    });

    test('a partner further left in the lanes than the pod that fills last still completes together', () => {
        // pod 2 (cap 1) fills first in lane 0 when tapped from column 1, partner fills later in lane 1
        const s = Sim.fromLevel(lvl('0111', [[{ color: 1, capacity: 3, link: 2 }], [{ color: 0, capacity: 1, link: 1 }]], 2));
        expect(s.tap(1)).toEqual([{ t: 'tapped', podIds: [2, 1], lanes: [0, 1] }]);
        const ev = s.settle();
        expect(ofType(ev, 'podCompleted').map((e) => e.lane)).toEqual([0, 1]);
        expect(s.isWon()).toBe(true);
    });
});

describe('pushy pods', () => {
    test('drops into a free lane by itself when the pod ahead of it is tapped', () => {
        const s = Sim.fromLevel(lvl(`
            0011
        `, [[[0, 2], { color: 1, capacity: 2, pushy: true }]], 2));
        expect(s.snapshot().columns[0][1]).toMatchObject({ id: 2, pushy: true });
        expect(s.tap(0)).toEqual([
            { t: 'tapped', podIds: [1], lanes: [0] },
            { t: 'pushed', podId: 2, lane: 1 },
        ]);
        expect(s.snapshot().columns[0]).toEqual([]);
        expect(s.snapshot().lanes.map((l) => l?.podId)).toEqual([1, 2]);
        s.settle();
        expect(s.isWon()).toBe(true);
    });

    test('waits at the front while every lane is busy, then takes the lane in the tick it frees (before any tap)', () => {
        const s = Sim.fromLevel(lvl(`
            0122
        `, [[[0, 1], { color: 2, capacity: 2, pushy: true }], [[1, 1]]], 1));
        s.tap(0);
        expect(s.snapshot().columns[0][0]).toMatchObject({ id: 2, pushy: true });
        expect(s.tapReason(0)).toBe('noLane');
        expect(s.tick()).toEqual([
            { t: 'claimed', podId: 1, lane: 0, x: 0, y: 0, color: 0, path: [] },
            { t: 'podCompleted', podId: 1, lane: 0 },
            { t: 'pushed', podId: 2, lane: 0 },
        ]);
        // The freed lane went to the pushy pod, so column 1 cannot be tapped until it drains.
        expect(s.tapReason(1)).toBe('noLane');
        s.settle();
        s.tap(1);
        s.settle();
        expect(s.isWon()).toBe(true);
    });

    test('a pushy pod whose color is buried becomes a forced stall: dead', () => {
        // Color 1 is walled in by color 0. Draining one cell frees the only lane, the pushy pod takes it, and
        // nothing is left that could open the wall.
        const dead = Sim.fromLevel(lvl(`
            000
            010
            000
        `, [[[0, 1], { color: 1, capacity: 1, pushy: true }], [[0, 7]]], 1));
        dead.tap(0);
        dead.settle();
        expect(dead.snapshot().lanes[0]).toMatchObject({ podId: 2, state: 'stalled' });
        expect(dead.isDead()).toBe(true);
    });

    test('several waiting pushy pods take free lanes lowest column first; a drop can expose another pushy pod', () => {
        const s = Sim.fromLevel(lvl(`
            0123
        `, [
            [[0, 1], { color: 1, capacity: 1, pushy: true }, { color: 2, capacity: 1, pushy: true }],
            [{ color: 3, capacity: 1, pushy: true }],
        ], 3));
        // At start column 1's front is pushy and lanes are free, so it starts in a lane (no event at construction).
        expect(s.snapshot().lanes.map((l) => l?.podId ?? null)).toEqual([4, null, null]);
        expect(s.tap(0)).toEqual([
            { t: 'tapped', podIds: [1], lanes: [1] },
            { t: 'pushed', podId: 2, lane: 2 },
        ]);
        expect(s.snapshot().columns[0][0]).toMatchObject({ id: 3, pushy: true });
        const ev = s.tick();
        expect(ofType(ev, 'pushed')).toEqual([{ t: 'pushed', podId: 3, lane: 0 }]);
        s.settle();
        expect(s.isWon()).toBe(true);
    });

    test('a pushy drop reveals the hidden pod behind it', () => {
        const s = Sim.fromLevel(lvl('012', [[[0, 1], { color: 1, capacity: 1, pushy: true }, { color: 2, capacity: 1, hidden: true }]], 3));
        expect(s.tap(0)).toEqual([
            { t: 'tapped', podIds: [1], lanes: [0] },
            { t: 'pushed', podId: 2, lane: 1 },
            { t: 'revealed', podId: 3 },
        ]);
    });

    test('settled play and hashes stay consistent through auto-drops', () => {
        const s = Sim.fromLevel(lvl(`
            0011
            2233
        `, [[[0, 2], { color: 1, capacity: 2, pushy: true }], [[2, 2], { color: 3, capacity: 2, pushy: true }]], 2));
        s.tap(0);
        expect(s.hash()).toBe(s.hashFromScratch());
        s.settle();
        expect(s.hash()).toBe(s.hashFromScratch());
        s.tap(1);
        s.settle();
        expect(s.hash()).toBe(s.hashFromScratch());
        expect(s.isWon()).toBe(true);
    });
});
