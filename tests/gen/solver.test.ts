import { describe, expect, test } from 'bun:test';
import { Sim } from '@game/sim';
import { lvl } from '../game/helpers';
import { Solver, solveLevel } from '../../tools/gen/solver';
import { deadEndRatio, minLanes, winRate } from '../../tools/gen/difficulty';
import { compileLevel } from '@game/level';

function wins(level: Parameters<typeof Sim.fromLevel>[0], solution: number[]): boolean {
    const sim = Sim.fromLevel(level, { events: false });
    sim.settle();
    for (const col of solution) {
        if (!sim.canTap(col)) return false;
        sim.tap(col);
        sim.settle();
    }
    return sim.isWon();
}

// Outer ring of 0 around a core of 1. Column 0 offers the core first.
const RING = `
    0000
    0110
    0110
    0000
`;

describe('solver', () => {
    test('solves a trivial puzzle', () => {
        const level = lvl(RING, [[[0, 12]], [[1, 4]]], 1);
        const r = solveLevel(level, 1000);
        expect(r.status).toBe('solved');
        expect(wins(level, r.solution)).toBe(true);
    });

    test('finds the order that avoids the jam (park the buried color last)', () => {
        // One lane: tapping the core pod first stalls forever. The solver must drain the ring first.
        const level = lvl(RING, [[[1, 4], [0, 6]], [[0, 6]]], 1);
        const r = solveLevel(level, 1000);
        expect(r.status).toBe('solved');
        expect(r.solution[0]).toBe(1);
        expect(wins(level, r.solution)).toBe(true);
    });

    test('a two-lane puzzle that needs a deliberate park', () => {
        // The ring pod (12) is behind the core pod in column 0; column 1 only has the core remainder.
        // With 2 lanes: park core(2), drain ring, then the last core pod.
        const level = lvl(RING, [[[1, 2], [0, 12]], [[1, 2]]], 2);
        const r = solveLevel(level, 1000);
        expect(r.status).toBe('solved');
        expect(wins(level, r.solution)).toBe(true);
    });

    test('proves a known-unsolvable fixture unsolvable', () => {
        // One lane, and the only front pod is the buried core: it stalls and nothing can free the lane.
        const level = lvl(RING, [[[1, 4], [0, 12]]], 1);
        const r = solveLevel(level, 1000);
        expect(r.status).toBe('unsolvable');
        // Two buried pods in front, two lanes: both stall.
        const level2 = lvl(RING, [[[1, 2], [0, 12]], [[1, 2]]], 1);
        expect(solveLevel(level2, 1000).status).toBe('unsolvable');
    });

    test('returns unknown when the budget runs out', () => {
        const columns = [
            [[0, 2], [0, 2], [0, 2]],
            [[0, 2], [0, 2], [0, 2]],
            [[1, 1], [1, 1], [1, 1], [1, 1]],
        ] as [number, number][][];
        const level = lvl(RING, columns, 1);
        // Budget 1 cannot even expand the root's children.
        const r = solveLevel(level, 1);
        expect(['unknown', 'solved']).toContain(r.status);
        expect(solveLevel(level, 10_000).status).toBe('solved');
    });

    test('memo is reused across calls', () => {
        const level = lvl(RING, [[[1, 4], [0, 6]], [[0, 6]]], 1);
        const solver = new Solver(level);
        const first = solver.solve(solver.start(), 1000);
        const second = solver.solve(solver.start(), 1000);
        expect(second.status).toBe('solved');
        expect(second.nodes).toBeLessThanOrEqual(first.nodes);
    });
});

describe('difficulty measures', () => {
    test('a forgiving level is always won; a trap level is not', () => {
        const easy = lvl(RING, [[[0, 12]], [[1, 4]]], 2);
        expect(winRate(compileLevel(easy), 'random', 50, 1)).toBe(1);
        const trap = lvl(RING, [[[1, 4], [0, 6]], [[0, 6]]], 1);
        const rate = winRate(compileLevel(trap), 'random', 200, 1);
        expect(rate).toBeGreaterThan(0.2);
        expect(rate).toBeLessThan(0.8);
        expect(deadEndRatio(compileLevel(trap), [1, 0, 0], 500)).toBeCloseTo(0.5, 5);
    });

    test('minLanes finds the smallest solvable lane count', () => {
        const level = lvl(RING, [[[1, 2], [0, 12]], [[1, 2]]], 3, [], { solution: [] });
        expect(minLanes(level, 1000)).toEqual({ lanes: 2, proven: true });
    });
});
