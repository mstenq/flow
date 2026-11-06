import { describe, expect, test } from 'bun:test';
import { Rng } from '@game/rng';
import { Sim } from '@game/sim';
import { TEST_PALETTE } from '../game/helpers';
import { boardFromAscii, replay, toLevel, traceSolution } from '../../tools/gen/board';
import { construct } from '../../tools/gen/construct';
import { generateLevel } from '../../tools/gen/generate';
import { cacheKey } from '../../tools/gen/gen-all';
import { FILL_FIRST_EXEMPT_LEVELS, FILL_FIRST_MAX_LANES, fillFirstEligible, sampleKnobs } from '../../tools/gen/knobs';
import type { MutationRules } from '../../tools/gen/mutate';
import { mutate } from '../../tools/gen/mutate';
import { formatLevel } from '../../tools/gen/output';
import { planFromLayout } from '../../tools/gen/plan';
import { PlaySim } from '../../tools/gen/playsim';
import type { RgbaImage } from '../../tools/gen/png';
import { fixtureBoards } from './fixtures';

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

/** A fill-first construction on a fixture board (2-3 lanes). */
function buildFillFirst(seed: number) {
    const boards = fixtureBoards();
    const { name, board } = boards[seed % boards.length];
    const rng = new Rng(seed * 7919 + 13);
    const sampled = sampleKnobs(rng.next(), rng);
    const lanes = Math.min(FILL_FIRST_MAX_LANES, sampled.lanes);
    const knobs = { ...sampled, lanes, maxStalled: Math.min(sampled.maxStalled, lanes - 1), fillFirst: true };
    const built = construct(board, knobs, rng);
    return { board, built, level: toLevel(board, built.layout, { id: `${name}-${seed}`, name }) };
}

describe('PlaySim wave mode', () => {
    test('holds pods until the lanes are full, then drains them together', () => {
        const board = boardFromAscii('00011', TEST_PALETTE);
        const sim = PlaySim.create(board, 2, true);
        sim.tap(0, 3);
        sim.settle();
        expect(sim.cellsLeft).toBe(5);
        expect(sim.laneWaved[0]).toBe(0);
        sim.tap(1, 1);
        sim.settle();
        expect(sim.waveCount).toBe(1);
        expect(sim.cellsLeft).toBe(1);
        // Nothing left to assign: the last pod drains without filling the lanes (endgame release).
        sim.tap(1, 1);
        sim.settle();
        expect(sim.cellsLeft).toBe(0);
    });

    test('agrees with the real Sim tap by tap on fill-first constructions', () => {
        let waves = 0;
        for (let seed = 0; seed < 60; seed++) {
            const { board, built, level } = buildFillFirst(seed);
            expect(level.fillFirst).toBe(true);
            const play = PlaySim.create(board, level.lanes, true);
            const sim = Sim.fromLevel(level, { events: false });
            sim.settle();
            built.order.forEach((p, s) => {
                play.tap(p.color, p.capacity);
                play.settle();
                sim.tap(level.solution[s]);
                sim.settle();
                expect(play.cellsLeft).toBe(sim.cellsRemaining);
                expect(play.freeLanes()).toBe(sim.freeLaneCount());
                expect(sim.snapshot().cells).toEqual(play.cells);
            });
            expect(sim.isWon()).toBe(true);
            waves += play.waveCount;
        }
        expect(waves).toBeGreaterThan(200);
    });

    test('fill-first constructions replay, hold pods between waves, and still stall some pods', () => {
        let stalls = 0;
        let held = 0;
        for (let seed = 0; seed < 150; seed++) {
            const { board, built, level } = buildFillFirst(seed);
            expect(replay(level).won).toBe(true);
            for (let c = 0; c < board.numColors; c++) {
                expect(built.order.filter((p) => p.color === c).reduce((s, p) => s + p.capacity, 0)).toBe(board.counts[c]);
            }
            const trace = traceSolution(level, true);
            // A wave always frees a lane (until the win).
            trace.stalledAfter.slice(0, -1).forEach((s) => expect(s).toBeLessThan(level.lanes));
            stalls += trace.stalledPod.filter(Boolean).length;
            held += trace.frames.filter((f) => f.lanes.some((l) => l?.state === 'held')).length;
        }
        expect(stalls).toBeGreaterThan(30);
        expect(held).toBeGreaterThan(300);
    });
});

describe('fill-first plumbing', () => {
    test('the flag survives plan round trips and is written right after lanes', () => {
        const { board, built, level } = buildFillFirst(1);
        expect(planFromLayout(board, built.layout).fillFirst).toBe(true);
        const keys = Object.keys(level);
        expect(keys[keys.indexOf('lanes') + 1]).toBe('fillFirst');
        expect(formatLevel(level)).toContain(`"lanes": ${level.lanes},\n  "fillFirst": true,\n  "tickMs"`);
        const plain = toLevel(board, { ...built.layout, fillFirst: undefined }, { id: 'p', name: 'p' });
        expect('fillFirst' in plain).toBe(false);
        expect(formatLevel(plain)).not.toContain('fillFirst');
    });

    test('lane mutations never cross the fill-first boundary', () => {
        const { board, built } = buildFillFirst(2);
        const ff = planFromLayout(board, built.layout);
        const rules: MutationRules = {
            hidden: false,
            locks: false,
            pairs: false,
            pushy: false,
            maxHiddenShare: 0,
            maxLocks: 0,
            minPairs: 0,
            maxPairs: 0,
            minLanes: 2,
            maxLanes: 4,
            fillFirstLanes: FILL_FIRST_MAX_LANES,
        };
        const rng = new Rng(7);
        const four = { ...ff, lanes: 4, fillFirst: undefined };
        let laneMoves = 0;
        for (let k = 0; k < 400; k++) {
            const a = mutate(board, ff, rng, k % 2 === 0 ? 1 : -1, rules);
            if (a) expect(a.plan.lanes).toBeLessThanOrEqual(FILL_FIRST_MAX_LANES);
            if (a?.kind.startsWith('lanes')) laneMoves++;
            const b = mutate(board, four, rng, k % 2 === 0 ? 1 : -1, rules);
            if (b) expect(b.plan.lanes).toBe(4);
        }
        expect(laneMoves).toBeGreaterThan(0);
    });
});

describe('fill-first eligibility', () => {
    test('the first levels in levels.json order are exempt, everything else (and unlisted PNGs) is eligible', () => {
        expect(FILL_FIRST_EXEMPT_LEVELS).toBe(3);
        for (let i = 0; i < FILL_FIRST_EXEMPT_LEVELS; i++) expect(fillFirstEligible(i)).toBe(false);
        expect(fillFirstEligible(FILL_FIRST_EXEMPT_LEVELS)).toBe(true);
        expect(fillFirstEligible(200)).toBe(true);
        expect(fillFirstEligible(-1)).toBe(true);
    });

    test('eligibility is part of the gen:all cache key', () => {
        const src = new URL('../../levels-src/heart.png', import.meta.url).pathname;
        const e = { file: 'heart.png', name: 'Heart', difficulty: 0.1 };
        expect(cacheKey(e, src, true)).not.toBe(cacheKey(e, src, false));
    });

    const opts = { image: heart(), id: 'heart', name: 'Heart', candidates: 6, climb: 6, quick: true };

    test('an eligible level with 2-3 lanes is fill-first and replays to a win; 4 lanes is not', () => {
        const seen = new Set<number>();
        for (const [difficulty, seed] of [[0.2, 1], [0.5, 2], [0.8, 3], [0.15, 11]] as const) {
            const r = generateLevel({ ...opts, difficulty, seed, fillFirst: true });
            expect(r.level.fillFirst === true).toBe(r.level.lanes <= FILL_FIRST_MAX_LANES);
            expect(replay(r.level).won).toBe(true);
            seen.add(r.level.lanes);
        }
        expect([...seen].some((l) => l <= FILL_FIRST_MAX_LANES)).toBe(true);
    }, 120_000);

    test('a forced 3-lane eligible level is fill-first, a level that is not eligible never is', () => {
        const ff = generateLevel({ ...opts, difficulty: 0.5, seed: 4, lanes: 3, fillFirst: true });
        expect(ff.level.fillFirst).toBe(true);
        expect(replay(ff.level).won).toBe(true);
        const plain = generateLevel({ ...opts, difficulty: 0.5, seed: 4, lanes: 3 });
        expect(plain.level.fillFirst).toBeUndefined();
    }, 60_000);

    test('a fixed 5-lane level never gets the flag', () => {
        const wide = generateLevel({ ...opts, difficulty: 0.6, seed: 5, lanes: 5, fillFirst: true });
        expect(wide.level.lanes).toBe(5);
        expect(wide.level.fillFirst).toBeUndefined();
        const sealed = generateLevel({ ...opts, difficulty: 0.6, seed: 5, outline: true, background: false, fillFirst: true });
        expect(sealed.log.some((l) => l.startsWith('outline ring:'))).toBe(true);
        expect(sealed.level.lanes).toBe(5);
        expect(sealed.level.fillFirst).toBeUndefined();
    }, 60_000);
});
