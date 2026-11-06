import { describe, expect, test } from 'bun:test';
import { GameFacade } from '@game/gameFacade';
import { solutionSteps } from '@game/solutionGuide';
import { lvl } from './helpers';

const partial = `
    0111
    .101
    .111
`;

describe('solutionSteps', () => {
    test('describes each tap: column, pod, and whether it clears or stalls', () => {
        const level = lvl(partial, [[[0, 2]], [[1, 8]]], 2, [], { solution: [0, 1] });
        expect(solutionSteps(level)).toEqual([
            { column: 0, pod: { color: 0, capacity: 2, hidden: false, lock: null }, partner: null, outcome: 'stalls' },
            { column: 1, pod: { color: 1, capacity: 8, hidden: false, lock: null }, partner: null, outcome: 'clears' },
        ]);
    });

    test('a linked partner rides along with its column', () => {
        const level = lvl('0011', [[{ color: 0, capacity: 2, link: 2 }], [{ color: 1, capacity: 2, link: 1 }]], 2, [], { solution: [0] });
        const [step] = solutionSteps(level);
        expect(step?.partner).toEqual({ color: 1, capacity: 2, hidden: false, lock: null, column: 1 });
        expect(step?.outcome).toBe('clears');
    });

    test('marks pods that started hidden or locked', () => {
        const level = lvl('0011', [[[0, 1], { color: 1, capacity: 2, hidden: true }, { color: 0, capacity: 1, lock: 5 }]], 1, [{ id: 5, x: 0, y: 0 }], {
            solution: [0, 0, 0],
        });
        const steps = solutionSteps(level);
        expect(steps.map((s) => [s.pod.hidden, s.pod.lock])).toEqual([
            [false, null],
            [true, null],
            [false, 5],
        ]);
    });

    test('fill-first: a pod that waits for the lanes to fill says so', () => {
        const level = lvl('0011', [[[0, 2]], [[1, 2]]], 2, [], { solution: [0, 1], fillFirst: true });
        expect(solutionSteps(level).map((s) => s.outcome)).toEqual(['waits', 'clears']);
    });

    test('stops at the first tap the stored solution cannot make', () => {
        const level = lvl('0011', [[{ color: 1, capacity: 2, lock: 5 }], [[0, 2]]], 2, [{ id: 5, x: 0, y: 0 }], { solution: [0, 1] });
        expect(solutionSteps(level)).toEqual([]);
    });
});

describe('gameFacade.solutionGuide', () => {
    test('tracks the step the round is on until the player leaves the path', () => {
        const level = lvl('0011', [[[0, 1], [0, 1]], [[1, 2]]], 2, [], { solution: [1, 0, 0] });
        const f = new GameFacade();
        f.load(level);
        const guide = f.solutionGuide();
        expect(guide.steps.map((s) => s.column)).toEqual([1, 0, 0]);
        expect(guide.current).toBe(0);
        f.tap(1);
        expect(f.solutionGuide().current).toBe(1);
        expect(f.solutionGuide().steps).toBe(guide.steps);
        f.restart();
        f.tap(0);
        expect(f.solutionGuide().current).toBe(null);
        f.restart();
        expect(f.solutionGuide().current).toBe(0);
    });
});
