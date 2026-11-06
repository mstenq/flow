import { describe, expect, test } from 'bun:test';
import { Sim } from '@game/sim';
import { emptyLaneCount, waitingToFill } from '@game/waveState';
import { lvl } from './helpers';

describe('waitingToFill', () => {
    test('true only on a fill-first board with empty lanes and no wave running', () => {
        const ff = Sim.fromLevel(lvl('0011', [[[0, 2]], [[1, 2]]], 2, [], { fillFirst: true }));
        expect(waitingToFill(ff.snapshot())).toBe(true);
        expect(emptyLaneCount(ff.snapshot())).toBe(2);
        ff.tap(0);
        expect(emptyLaneCount(ff.snapshot())).toBe(1);
        expect(waitingToFill(ff.snapshot())).toBe(true);
        ff.tap(1);
        expect(waitingToFill(ff.snapshot())).toBe(false); // the wave runs
    });

    test('never on a normal level', () => {
        const normal = Sim.fromLevel(lvl('0011', [[[0, 2]], [[1, 2]]], 2));
        expect(waitingToFill(normal.snapshot())).toBe(false);
    });
});
