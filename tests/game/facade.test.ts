import { describe, expect, test } from 'bun:test';
import { GameFacade, MAX_TICKS_PER_ADVANCE, gameFacade } from '@game/gameFacade';
import { LevelError } from '@game/level';
import type { SimEvent } from '@game/types';
import { lvl } from './helpers';

function claimsIn(events: SimEvent[]): number {
    return events.filter((e) => e.t === 'claimed').length;
}

/** 10 cells of one color, one pod: each tick claims exactly one cell until it completes. */
const longLevel = () => lvl('0000000000', [[[0, 10]]], 1, [], { tickMs: 40, solution: [0] });

describe('gameFacade', () => {
    test('throws before a level is loaded; advance is a no-op', () => {
        const f = new GameFacade();
        expect(f.loaded).toBe(false);
        expect(f.level).toBe(null);
        expect(f.advance(100)).toEqual([]);
        expect(f.nextHint()).toBe(null);
        expect(() => f.tap(0)).toThrow(/no level loaded/);
        expect(() => f.restart()).toThrow(/no level loaded/);
        expect(() => f.snapshot()).toThrow(/no level loaded/);
        expect(f.stepMs).toBe(50);
        expect(gameFacade).toBeInstanceOf(GameFacade);
    });

    test('load validates the level', () => {
        const f = new GameFacade();
        const bad = lvl('00', [[[0, 1]]], 1);
        expect(() => f.load(bad)).toThrow(LevelError);
    });

    test('fixed-timestep accumulator runs one tick per tickMs, carrying remainders', () => {
        const f = new GameFacade();
        f.load(longLevel());
        expect(f.tap(0).ok).toBe(true);
        expect(claimsIn(f.advance(39))).toBe(0);
        expect(f.tickAlpha).toBeCloseTo(39 / 40);
        expect(claimsIn(f.advance(1))).toBe(1);
        expect(f.tickAlpha).toBe(0);
        expect(claimsIn(f.advance(100))).toBe(2); // 100 = 2 ticks + 20 carried
        expect(f.tickAlpha).toBeCloseTo(0.5);
        expect(claimsIn(f.advance(20))).toBe(1);
        expect(f.snapshot().ticks).toBe(4);
        expect(f.advance(0)).toEqual([]);
        expect(f.advance(-5)).toEqual([]);
        expect(f.advance(Number.NaN)).toEqual([]);
    });

    test('2x speed halves the tick duration and keeps the tick fraction', () => {
        const f = new GameFacade();
        f.load(longLevel());
        f.tap(0);
        f.advance(20); // half a tick at 1x
        f.setSpeed(2);
        expect(f.getSpeed()).toBe(2);
        expect(f.stepMs).toBe(20);
        expect(f.tickAlpha).toBeCloseTo(0.5);
        expect(claimsIn(f.advance(10))).toBe(1);
        expect(claimsIn(f.advance(40))).toBe(2);
        f.setSpeed(2);
        f.setSpeed(1);
        expect(f.stepMs).toBe(40);
        expect(claimsIn(f.advance(40))).toBe(1);
    });

    test('a slow pace stretches the tick and stacks with 2x', () => {
        const f = new GameFacade();
        f.load(longLevel());
        f.tap(0);
        f.advance(20); // half a tick at 1x
        f.setPace(0.5);
        expect(f.stepMs).toBe(80);
        expect(f.tickAlpha).toBeCloseTo(0.5);
        expect(claimsIn(f.advance(40))).toBe(1);
        f.setSpeed(2);
        expect(f.stepMs).toBe(40);
        f.setPace(0);
        expect(f.stepMs).toBe(40);
    });

    test('pause freezes the clock; taps still apply', () => {
        const f = new GameFacade();
        f.load(longLevel());
        f.setPaused(true);
        expect(f.isPaused()).toBe(true);
        expect(f.tap(0).ok).toBe(true);
        expect(f.advance(1000)).toEqual([]);
        expect(f.snapshot().ticks).toBe(0);
        f.setPaused(false);
        expect(claimsIn(f.advance(40))).toBe(1);
    });

    test('burst cap: a huge dt runs at most MAX_TICKS_PER_ADVANCE ticks and drops the backlog', () => {
        const f = new GameFacade();
        f.load(longLevel());
        f.tap(0);
        const ev = f.advance(60_000);
        expect(f.snapshot().ticks).toBe(MAX_TICKS_PER_ADVANCE);
        expect(claimsIn(ev)).toBe(MAX_TICKS_PER_ADVANCE);
        expect(f.tickAlpha).toBe(0);
        expect(claimsIn(f.advance(39))).toBe(0);

        const g = new GameFacade({ maxTicksPerAdvance: 2 });
        g.load(longLevel());
        g.tap(0);
        g.advance(1000);
        expect(g.snapshot().ticks).toBe(2);
    });

    test('tab hidden: paused time never accumulates, and a late huge frame is still capped', () => {
        const f = new GameFacade();
        f.load(longLevel());
        f.tap(0);
        f.advance(20);
        f.setPaused(true); // the pause overlay opens when the page is hidden
        f.advance(120_000);
        f.advance(120_000);
        f.setPaused(false);
        expect(f.snapshot().ticks).toBe(0);
        expect(f.tickAlpha).toBeCloseTo(0.5, 5); // the 20 ms before the pause are all that is banked
        expect(claimsIn(f.advance(20))).toBe(1);
        // Even if the browser hands over one enormous delta after a resume, the burst is capped.
        f.advance(120_000);
        expect(f.snapshot().ticks).toBe(1 + MAX_TICKS_PER_ADVANCE);
    });

    test('illegal taps return reasons', () => {
        const f = new GameFacade();
        f.load(lvl(`
            0111
            .121
            .111
        `, [
            [[0, 1]],
            [{ color: 2, capacity: 1, lock: 1 }],
            [[1, 8]],
            [],
        ], 1, [{ id: 1, x: 0, y: 0 }]));
        expect(f.tap(3)).toEqual({ ok: false, reason: 'empty' });
        expect(f.tap(1)).toEqual({ ok: false, reason: 'locked' });
        expect(f.tapReason(1)).toBe('locked');
        const ok = f.tap(0);
        expect(ok).toEqual({ ok: true, events: [{ t: 'tapped', podIds: [1], lanes: [0] }] });
        expect(f.tap(2)).toEqual({ ok: false, reason: 'noLane' });

        const g = new GameFacade();
        g.load(lvl('0011', [[{ color: 0, capacity: 2, link: 3 }], [[1, 1], { color: 1, capacity: 1, link: 1 }]], 2));
        expect(g.tap(0)).toEqual({ ok: false, reason: 'partnerUnavailable' });
    });

    test('settle/dead/won queries and debug helpers', () => {
        const f = new GameFacade();
        f.load(lvl(`
            0111
            .101
            .111
        `, [[[0, 2]], [[1, 8]]], 1));
        expect(f.isSettled()).toBe(true);
        f.tap(0);
        expect(f.isSettled()).toBe(false);
        expect(claimsIn(f.stepTick())).toBe(1);
        const ev = f.settleNow();
        expect(ev.some((e) => e.t === 'dead')).toBe(true);
        expect(f.isDead()).toBe(true);
        expect(f.isWon()).toBe(false);
        f.restart();
        expect(f.isDead()).toBe(false);
        expect(f.taps).toEqual([]);
        expect(f.snapshot().ticks).toBe(0);
    });

    test('claimed events from the facade carry exit paths', () => {
        const f = new GameFacade();
        f.load(longLevel());
        f.tap(0);
        const ev = f.advance(40);
        expect(ev[0]).toMatchObject({ t: 'claimed', path: [{ x: 0, y: 0 }, { x: 0, y: -1 }] });
    });

    test('nextHint follows the stored solution until the player deviates', () => {
        const level = lvl('0011', [[[0, 1], [0, 1]], [[1, 2]]], 2, [], { solution: [1, 0, 0] });
        const f = new GameFacade();
        f.load(level);
        expect(f.nextHint()).toBe(1);
        f.tap(1);
        expect(f.nextHint()).toBe(0);
        f.tap(0);
        f.advance(1000);
        expect(f.nextHint()).toBe(0);
        f.tap(0);
        expect(f.nextHint()).toBe(null); // solution exhausted
        expect(f.taps).toEqual([1, 0, 0]);

        f.restart();
        expect(f.nextHint()).toBe(1);
        f.tap(0); // deviates
        expect(f.nextHint()).toBe(null);
        const denied = f.tap(5);
        expect(denied.ok).toBe(false);
        expect(f.taps).toEqual([0]);
        f.load(level);
        expect(f.nextHint()).toBe(1);
        expect(f.isPaused()).toBe(false);
    });

    test('load keeps speed, clears pause', () => {
        const f = new GameFacade();
        f.setSpeed(2);
        f.setPaused(true);
        f.load(longLevel());
        expect(f.getSpeed()).toBe(2);
        expect(f.isPaused()).toBe(false);
        expect(f.stepMs).toBe(20);
        expect(f.level?.tickMs).toBe(40);
    });

    test('distAt exposes dist_c for the debug overlay (-1 = unreachable)', () => {
        const f = new GameFacade();
        f.load(lvl('0110', [[[0, 2]], [[1, 2]]], 2, [], { solution: [0, 1] }));
        expect(f.distAt(0, 0, 0)).toBe(1);
        expect(f.distAt(1, 1, 0)).toBe(1);
        const g = new GameFacade();
        g.load(lvl('00\n01\n00', [[[0, 5]], [[1, 1]]], 2));
        expect(g.distAt(1, 1, 1)).toBe(1);
        const h = new GameFacade();
        h.load(lvl('000\n010\n000', [[[0, 8]], [[1, 1]]], 2));
        expect(h.distAt(1, 1, 1)).toBe(-1);
    });
});
