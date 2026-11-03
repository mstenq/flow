import { describe, expect, test } from 'bun:test';
import { Rng } from '@game/rng';
import { Sim } from '@game/sim';
import type { LevelData, PodSpec } from '@game/types';
import { lvl } from '../game/helpers';
import { replay, toLevel, traceSolution } from '../../tools/gen/board';
import type { Board } from '../../tools/gen/board';
import { boardFromAscii } from '../../tools/gen/board';
import { construct } from '../../tools/gen/construct';
import { EASY_CUTOFF, MAX_PUSHY, MIN_PUSHY_LANES, pushyCountFor, sampleKnobs } from '../../tools/gen/knobs';
import { addPushy, applyMechanics, isPlainPod } from '../../tools/gen/mechanics';
import type { MutationRules } from '../../tools/gen/mutate';
import { mutate } from '../../tools/gen/mutate';
import type { Plan } from '../../tools/gen/plan';
import { clonePlan, planFromLayout, pushyCount, stepOfPod, toLayout } from '../../tools/gen/plan';
import { solveLevel } from '../../tools/gen/solver';
import { generateLevel } from '../../tools/gen/generate';
import type { RgbaImage } from '../../tools/gen/png';
import { TEST_PALETTE } from '../game/helpers';
import { fixtureBoards } from './fixtures';

/** Every pod carries at most one mechanic, and no pushy pod starts at a column front. */
function expectPushyRules(level: LevelData): void {
    for (const col of level.columns) {
        expect(col[0].pushy).toBeUndefined();
        for (const p of col) {
            if (!p.pushy) continue;
            expect(p.hidden).toBeUndefined();
            expect(p.lock).toBeUndefined();
            expect(p.link).toBeUndefined();
        }
    }
}

/** Plan order matches the sim's real lane-entry order (toLayout renumbers pods 1..N in plan order). */
function expectSynced(board: Board, plan: Plan): void {
    const layout = toLayout(plan)!;
    expect(planFromLayout(board, layout).order.map((p) => p.id)).toEqual(layout.columns.flat().map((_, i) => i + 1));
}

function build(seed: number, pushy: number) {
    const boards = fixtureBoards();
    const { name, board } = boards[seed % boards.length];
    const rng = new Rng(seed * 7919 + 3);
    const knobs = { ...sampleKnobs(0.5 + rng.next() * 0.4, rng), lanes: 4, maxStalled: 2 };
    const built = construct(board, knobs, rng);
    const placed = applyMechanics(board, planFromLayout(board, built.layout), { hiddenShare: 0.3, keys: 2, pairs: 1, pushy }, rng);
    const layout = toLayout(placed.plan)!;
    return { board, placed, layout, level: toLevel(board, layout, { id: `${name}-${seed}`, name }) };
}

describe('pushy count', () => {
    test('uniform 0..MAX_PUSHY from the seed, deterministic, the same for 4 and 5 lanes', () => {
        const hist = new Array<number>(MAX_PUSHY + 1).fill(0);
        const N = 3000;
        for (let seed = 0; seed < N; seed++) {
            const n = pushyCountFor(0.5, seed * 2654435761, 5);
            expect(n).toBe(pushyCountFor(0.5, seed * 2654435761, 5));
            expect(pushyCountFor(0.5, seed * 2654435761, MIN_PUSHY_LANES)).toBe(n);
            hist[n]++;
        }
        expect(MAX_PUSHY).toBe(5);
        for (const h of hist) {
            expect(h / N).toBeGreaterThan(0.12);
            expect(h / N).toBeLessThan(0.21);
        }
    });

    test('none below 4 lanes or below the easy cutoff', () => {
        for (let seed = 1; seed < 400; seed++) {
            for (const lanes of [1, 2, 3]) expect(pushyCountFor(0.9, seed, lanes)).toBe(0);
            expect(pushyCountFor(EASY_CUTOFF - 0.01, seed, 5)).toBe(0);
            expect(pushyCountFor(0, seed, 4)).toBe(0);
        }
    });
});

describe('pushy plan plumbing', () => {
    test('toLayout skips pushy pods in the solution and rejects a pushy front', () => {
        const plan: Plan = {
            lanes: 4,
            numCols: 2,
            keys: [],
            order: [
                { id: 1, color: 0, capacity: 2 },
                { id: 2, color: 1, capacity: 2, pushy: true },
                { id: 3, color: 0, capacity: 2 },
            ],
            col: [0, 0, 1],
        };
        const layout = toLayout(plan)!;
        expect(layout.solution).toEqual([0, 1]);
        expect(layout.columns[0][1].pushy).toBe(true);
        expect(stepOfPod(plan)).toEqual([0, 0, 1]);
        expect(toLayout({ ...plan, col: [1, 0, 1] })).toBeNull();
    });
});

describe('addPushy / applyMechanics', () => {
    test('placements keep the solution winning, stay exclusive and keep the plan synced to the sim', () => {
        let placed = 0;
        for (let seed = 0; seed < 30; seed++) {
            const { board, placed: p, level } = build(seed, 3);
            expect(replay(level).won).toBe(true);
            expectPushyRules(level);
            expectSynced(board, p.plan);
            expect(p.pushy).toBe(pushyCount(p.plan));
            expect(level.solution.length).toBe(level.columns.flat().length - p.pushy - p.pairs);
            placed += p.pushy;
        }
        expect(placed).toBeGreaterThan(50);
    });

    test('addPushy on a winning plan keeps it winning (or leaves it untouched)', () => {
        let added = 0;
        for (let seed = 0; seed < 20; seed++) {
            const { board, placed } = build(seed, 0);
            const plan = clonePlan(placed.plan);
            const before = JSON.stringify(plan);
            const ok = addPushy(board, plan, new Rng(seed));
            if (!ok) {
                expect(JSON.stringify(plan)).toBe(before);
                continue;
            }
            added++;
            expect(pushyCount(plan)).toBe(1);
            const layout = toLayout(plan)!;
            const level = toLevel(board, layout, { id: 'p', name: 'p' });
            expect(replay(level).won).toBe(true);
            expectPushyRules(level);
            expectSynced(board, plan);
        }
        expect(added).toBeGreaterThan(15);
    });

    test('the trace reports pushy drops and pushy pods in the queue', () => {
        let drops = 0;
        for (let seed = 0; seed < 10; seed++) {
            const { level } = build(seed, 3);
            const trace = traceSolution(level, true);
            const pushyIds = new Set(level.columns.flat().filter((p) => p.pushy).map((p) => p.id));
            const pushed = trace.frames.flatMap((f) => f.pushed);
            expect(new Set(pushed)).toEqual(pushyIds);
            expect(trace.frames[0].columns.flat().filter((p) => p.pushy).length).toBe(pushyIds.size);
            drops += pushed.length;
        }
        expect(drops).toBeGreaterThan(10);
    });
});

describe('climb mutations with pushy pods', () => {
    test('lanes never drop below 4 while the plan has pushy pods, and pushy-move keeps the count', () => {
        const { board, placed } = build(4, 3);
        expect(pushyCount(placed.plan)).toBeGreaterThan(0);
        const rules: MutationRules = {
            hidden: false,
            locks: false,
            pairs: false,
            pushy: true,
            maxHiddenShare: 0,
            maxLocks: 0,
            minPairs: 0,
            maxPairs: 0,
            minLanes: 2,
            maxLanes: 4,
        };
        const rng = new Rng(99);
        let moved = 0;
        for (let k = 0; k < 600; k++) {
            const mut = mutate(board, placed.plan, rng, 1, rules);
            if (!mut) continue;
            expect(mut.plan.lanes).toBeGreaterThanOrEqual(MIN_PUSHY_LANES);
            expect(mut.plan.order.every((p) => !p.pushy || isPlainPod({ ...p, pushy: undefined }))).toBe(true);
            if (mut.kind !== 'pushy-move') continue;
            expect(pushyCount(mut.plan)).toBe(pushyCount(placed.plan));
            moved++;
        }
        expect(moved).toBeGreaterThan(0);
    });
});

// 5x5: ring of 0 (16), layer of 1 (8), core of 2 (1).
const ONION = `
    00000
    01110
    01210
    01110
    00000
`;

describe('solver with pushy pods', () => {
    // One lane. Column 0: half the ring, then a pushy core pod. Column 1: the other half, then the middle layer.
    // Tapping column 0 first drains half the ring, then the pushy core drops into the freed lane while the core is
    // still buried behind layer 1, stalls forever and blocks the only lane. Winning: column 1 twice, then column 0.
    const trap = (): LevelData =>
        lvl(
            ONION,
            [
                [[0, 8], { color: 2, capacity: 1, pushy: true }],
                [[0, 8], [1, 8]],
            ],
            1,
        );

    test('a pushy pod forces a loss for the naive order', () => {
        const sim = Sim.fromLevel(trap(), { events: false });
        sim.settle();
        sim.tap(0);
        sim.settle();
        expect(sim.isDead()).toBe(true);
    });

    test('the solver finds the order that drains the layer before the pushy pod drops', () => {
        const level = trap();
        const r = solveLevel(level, 1000);
        expect(r.status).toBe('solved');
        expect(r.solution).toEqual([1, 1, 0]);
        const solved = { ...level, solution: r.solution };
        expect(replay(solved).won).toBe(true);
        // 4 pods, 3 taps: the pushy pod enters by itself, last.
        const board = boardFromAscii(ONION, TEST_PALETTE);
        const order = planFromLayout(board, { lanes: 1, columns: level.columns, keys: [], solution: r.solution }).order;
        expect(order.map((p: PodSpec) => p.id)).toEqual([3, 4, 1, 2]);
    });

    test('a pushy level with no way around the drop is proven unsolvable', () => {
        // Same pods, but the layer sits behind the pushy pod: whatever is tapped, the core drops while buried.
        const level = lvl(
            ONION,
            [
                [[0, 8], { color: 2, capacity: 1, pushy: true }, [1, 8]],
                [[0, 8]],
            ],
            1,
        );
        expect(solveLevel(level, 1000).status).toBe('unsolvable');
    });
});

/** 12×10 heart: dark outline, red fill, pale highlight (as in determinism.test.ts). */
function heart(): RgbaImage {
    const rows = [
        '..ooo..ooo..',
        '.orrrooorrro',
        'orwwwrrrrrro',
        'orwwrrrrrrro',
        'orwrrrrrrrro',
        '.orrrrrrrro.',
        '..orrrrrro..',
        '...orrrro...',
        '....orro....',
        '.....oo.....',
    ];
    const colors: Record<string, number[]> = { o: [92, 10, 26], r: [232, 40, 60], w: [255, 224, 230] };
    const data = new Uint8Array(12 * 10 * 4);
    rows.forEach((row, y) => {
        for (let x = 0; x < 12; x++) {
            const c = colors[row[x]];
            if (c) data.set([...c, 255], (y * 12 + x) * 4);
        }
    });
    return { width: 12, height: 10, data };
}

describe('generateLevel with pushy pods', () => {
    const target = 0.5;
    let seed = 1;
    while (pushyCountFor(target, seed, 5) < 4) seed++;
    const opts = { image: heart(), id: 'heart', name: 'Heart', difficulty: target, seed, candidates: 6, climb: 6, quick: true };

    test('a 5-lane level gets its pushy pods, exclusive, and replays its stored solution to a win', () => {
        const r = generateLevel({ ...opts, lanes: 5 });
        const pushy = r.level.columns.flat().filter((p) => p.pushy).length;
        expect(pushy).toBeGreaterThan(0);
        expect(pushy).toBeLessThanOrEqual(pushyCountFor(target, seed, 5));
        expect(r.level.meta.stats.pushyCount).toBe(pushy);
        expect(replay(r.level).won).toBe(true);
        expectPushyRules(r.level);
        expect(r.level.solution.length).toBeLessThan(r.level.columns.flat().length);
    }, 60_000);

    test('a 3-lane level gets none', () => {
        const r = generateLevel({ ...opts, lanes: 3 });
        expect(r.level.columns.flat().some((p) => p.pushy)).toBe(false);
        expect(r.level.meta.stats.pushyCount).toBe(0);
        expect(replay(r.level).won).toBe(true);
    }, 60_000);
});
