import { describe, expect, test } from 'bun:test';
import { Sim } from '@game/sim';
import type { LevelData, SimEvent } from '@game/types';
import type { PodSpecInput } from './helpers';
import { lvl } from './helpers';

function fillFirst(ascii: string, columns: PodSpecInput[][], lanes: number): LevelData {
    return lvl(ascii, columns, lanes, [], { fillFirst: true });
}

function has(events: SimEvent[], t: SimEvent['t']): boolean {
    return events.some((e) => e.t === t);
}

function expectHashOk(s: Sim): void {
    expect(s.hash()).toBe(s.hashFromScratch());
}

describe('fill-first lanes', () => {
    test('nothing drains until every lane is full', () => {
        const s = Sim.fromLevel(fillFirst('00011', [[[0, 2], [0, 1]], [[1, 2]]], 2));
        expect(s.snapshot().fillFirst).toBe(true);
        s.tap(0);
        s.settle();
        expect(s.cellsRemaining).toBe(5);
        const view = s.snapshot();
        expect(view.wave).toBe(false);
        expect(view.lanes[0]?.state).toBe('held');
        expect(view.settled).toBe(true);
        expect(view.dead).toBe(false);
        expectHashOk(s);

        expect(has(s.tap(1), 'waveStarted')).toBe(true);
        expect(s.snapshot().wave).toBe(true);
        expect(s.snapshot().lanes[0]?.state).toBe('draining');
        expectHashOk(s);
        const ev = s.settle();
        expect(has(ev, 'waveEnded')).toBe(true);
        expect(s.cellsRemaining).toBe(1);
        expect(s.snapshot().wave).toBe(false);
        expectHashOk(s);
    });

    test('with nothing left to tap, a partly filled board drains anyway', () => {
        const s = Sim.fromLevel(fillFirst('00011', [[[0, 2], [0, 1]], [[1, 2]]], 2));
        s.tap(0);
        s.tap(1);
        s.settle();
        // One pod left in the queue, two lanes: tapping it leaves a lane empty, but no legal tap remains.
        expect(has(s.tap(0), 'waveStarted')).toBe(true);
        expect(has(s.settle(), 'won')).toBe(true);
    });

    test('pods tapped mid-wave are held until the next wave', () => {
        const s = Sim.fromLevel(fillFirst('000000111', [[[0, 1], [0, 4], [0, 1]], [[1, 2], [1, 1]]], 2));
        s.tap(0); // red 1
        s.tap(1); // white 2: lanes full, wave starts
        s.tick(); // red 1 completes, white claims one
        expect(s.freeLaneCount()).toBe(1);
        s.tap(0); // red 4 into the freed lane, mid-wave
        expect(s.snapshot().lanes[0]?.state).toBe('held');
        const ev = s.tick(); // white completes: the wave is over, red 4 never moved
        expect(has(ev, 'waveEnded')).toBe(true);
        expect(s.colorRemaining(0)).toBe(5);
        expect(s.snapshot().wave).toBe(false);
        s.settle();
        expect(s.colorRemaining(0)).toBe(5);
        expect(s.isDead()).toBe(false);
        expectHashOk(s);

        expect(has(s.tap(1), 'waveStarted')).toBe(true); // white 1 fills the lanes again
        s.settle();
        expect(s.colorRemaining(0)).toBe(1);
        expect(s.colorRemaining(1)).toBe(0);
        s.tap(0);
        expect(has(s.settle(), 'won')).toBe(true);
    });

    test('a stalled pod ends the wave; filling the empty lane starts the next', () => {
        const s = Sim.fromLevel(fillFirst(`
            111
            101
            111
        `, [[[0, 1]], [[1, 1], [1, 7]]], 2));
        s.tap(0); // red center: nothing reachable yet
        s.tap(1); // white 1: takes a corner, which opens nothing
        const ev = s.settle();
        expect(has(ev, 'waveEnded')).toBe(true);
        expect(s.colorRemaining(1)).toBe(7);
        const view = s.snapshot();
        expect(view.wave).toBe(false);
        expect(view.lanes[0]?.state).toBe('stalled');
        expect(view.lanes[1]).toBeNull();
        expect(view.dead).toBe(false);

        expect(has(s.tap(1), 'waveStarted')).toBe(true);
        expect(has(s.settle(), 'won')).toBe(true);
        expectHashOk(s);
    });

    test('a full board of stalled pods with no wave left is dead', () => {
        const s = Sim.fromLevel(fillFirst(`
            111
            101
            111
        `, [[[0, 1]], [[1, 1], [1, 7]]], 1));
        const ev = [...s.tap(0), ...s.settle()];
        expect(has(ev, 'waveStarted')).toBe(false);
        expect(has(ev, 'dead')).toBe(true);
        expect(s.isDead()).toBe(true);
    });

    test('hash tells a running wave from a held lane', () => {
        const a = Sim.fromLevel(fillFirst('000000111', [[[0, 1], [0, 4], [0, 1]], [[1, 2], [1, 1]]], 2));
        a.tap(0);
        a.tap(1);
        const b = a.clone();
        expect(b.hashKey()).toBe(a.hashKey());
        a.tick();
        a.tap(0);
        expectHashOk(a);
        expect(a.snapshot().lanes[0]?.state).toBe('held');
    });

    test('other levels report a running wave and never hold pods', () => {
        const s = Sim.fromLevel(lvl('00011', [[[0, 2], [0, 1]], [[1, 2]]], 2));
        s.tap(0);
        const view = s.snapshot();
        expect(view.fillFirst).toBe(false);
        expect(view.wave).toBe(true);
        expect(view.lanes[0]?.state).toBe('draining');
        s.settle();
        expect(s.cellsRemaining).toBe(3);
    });
});
