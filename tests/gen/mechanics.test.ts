import { describe, expect, test } from 'bun:test';
import { Rng } from '@game/rng';
import { Sim } from '@game/sim';
import { replay, toLevel, traceSolution } from '../../tools/gen/board';
import { construct } from '../../tools/gen/construct';
import { sampleKnobs } from '../../tools/gen/knobs';
import { applyMechanics, hideShare } from '../../tools/gen/mechanics';
import { planFromLayout, stepOfPod, toLayout } from '../../tools/gen/plan';
import { fixtureBoards } from './fixtures';

function build(seed: number) {
    const boards = fixtureBoards();
    const { name, board } = boards[seed % boards.length];
    const rng = new Rng(seed * 104729 + 1);
    const knobs = { ...sampleKnobs(0.6 + rng.next() * 0.4, rng), lanes: 4, maxStalled: 2 };
    const built = construct(board, knobs, rng);
    const placed = applyMechanics(board, planFromLayout(board, built.layout), { hiddenShare: 0.3, keys: 3, pairs: 2 }, rng);
    const layout = toLayout(placed.plan)!;
    return { name, board, placed, layout, level: toLevel(board, layout, { id: `${name}-${seed}`, name }) };
}

describe('mechanics', () => {
    test('placements keep the solution winning and never combine mechanics', () => {
        let locks = 0;
        let pairs = 0;
        let hidden = 0;
        for (let seed = 0; seed < 60; seed++) {
            const { level, placed } = build(seed);
            expect(replay(level).won).toBe(true);
            for (const pod of level.columns.flat()) {
                const n = (pod.hidden ? 1 : 0) + (pod.lock !== undefined ? 1 : 0) + (pod.link !== undefined ? 1 : 0);
                expect(n).toBeLessThanOrEqual(1);
            }
            // No locked pod at the front of a column at the start.
            for (const col of level.columns) expect(col[0].lock).toBeUndefined();
            locks += placed.locks;
            pairs += placed.pairs;
            hidden += placed.hidden;
        }
        expect(locks).toBeGreaterThan(30);
        expect(pairs).toBeGreaterThan(20);
        expect(hidden).toBeGreaterThan(20);
    });

    test('hideShare hides an exact share of plain pods, never a front pod, and keeps the solution', () => {
        for (let seed = 0; seed < 20; seed++) {
            const { board, placed } = build(seed);
            const bare = { ...placed.plan, order: placed.plan.order.map((p) => ({ ...p, hidden: undefined })) };
            const plan = hideShare(bare, 0.25, new Rng(seed));
            const layout = toLayout(plan)!;
            const pods = layout.columns.flat();
            const hidden = pods.filter((p) => p.hidden).length;
            const eligible = layout.columns.reduce((n, col) => n + col.slice(1).filter((p) => p.lock === undefined && p.link === undefined).length, 0);
            expect(hidden).toBe(Math.min(eligible, Math.round(0.25 * pods.length)));
            for (const col of layout.columns) expect(col[0].hidden).toBeUndefined();
            expect(replay(toLevel(board, layout, { id: 'h', name: 'h' })).won).toBe(true);
        }
    });

    test('every key is drained strictly before its locked pod is needed', () => {
        let checked = 0;
        for (let seed = 0; seed < 60; seed++) {
            const { level, placed, board } = build(seed);
            const { drainStep } = traceSolution(level, false);
            const steps = stepOfPod(placed.plan);
            placed.plan.order.forEach((pod, i) => {
                if (pod.lock === undefined) return;
                const key = placed.plan.keys.find((k) => k.id === pod.lock)!;
                const drained = drainStep[key.y * board.width + key.x];
                expect(drained).toBeGreaterThanOrEqual(0);
                expect(drained).toBeLessThan(steps[i]);
                checked++;
            });
        }
        expect(checked).toBeGreaterThan(30);
    });

    test('linked pairs are tappable at their step (both enter lanes together)', () => {
        let checked = 0;
        for (let seed = 0; seed < 60; seed++) {
            const { level } = build(seed);
            const sim = Sim.fromLevel(level);
            sim.settle();
            for (const col of level.solution) {
                const id = sim.frontPodId(col);
                const pod = level.columns.flat().find((p) => p.id === id)!;
                expect(sim.tapReason(col)).toBeNull();
                const events = sim.tap(col);
                if (pod.link !== undefined) {
                    const tapped = events.find((e) => e.t === 'tapped');
                    expect(tapped && tapped.t === 'tapped' ? tapped.podIds.sort() : []).toEqual([pod.id, pod.link].sort());
                    checked++;
                }
                sim.settle();
            }
            expect(sim.isWon()).toBe(true);
        }
        expect(checked).toBeGreaterThan(20);
    });
});
