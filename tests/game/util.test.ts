import { beforeEach, describe, expect, test } from 'bun:test';
import { Rng, createRng, hashString, mix32, mulberry32 } from '@game/rng';
import { Zobrist, toBigHash, toNumberHash } from '@game/hash';
import {
    getRoundState,
    getRunState,
    getSceneState,
    hasSeen,
    isLevelUnlocked,
    onRunChange,
    roundActions,
    runActions,
    sceneActions,
} from '@game/state';
import { Sim } from '@game/sim';
import { lvl } from './helpers';

describe('rng', () => {
    test('mulberry32 is deterministic and in [0, 1)', () => {
        const a = mulberry32(123);
        const b = mulberry32(123);
        for (let i = 0; i < 1000; i++) {
            const v = a();
            expect(v).toBe(b());
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThan(1);
        }
        expect(mulberry32(1)()).not.toBe(mulberry32(2)());
    });

    test('helpers: int, below, float, chance, pick, shuffle, weighted, fork', () => {
        const r = createRng(7);
        for (let i = 0; i < 500; i++) {
            const n = r.int(3, 5);
            expect(n >= 3 && n <= 5 && Number.isInteger(n)).toBe(true);
            const b = r.below(4);
            expect(b >= 0 && b < 4).toBe(true);
            const f = r.float(2, 3);
            expect(f >= 2 && f < 3).toBe(true);
        }
        expect(r.chance(0)).toBe(false);
        expect(r.chance(1)).toBe(true);
        expect(r.next()).toBeLessThan(1);
        expect(['a', 'b']).toContain(r.pick(['a', 'b']));
        expect(() => r.pick([])).toThrow(/empty/);
        const arr = [1, 2, 3, 4, 5, 6];
        expect(r.shuffle(arr.slice()).sort()).toEqual(arr);
        expect(new Rng(9).shuffle(arr.slice())).toEqual(new Rng(9).shuffle(arr.slice()));
        expect(r.weighted([0, 0])).toBe(-1);
        expect(r.weighted([0, 5, 0])).toBe(1);
        const hits = [0, 0];
        for (let i = 0; i < 2000; i++) hits[r.weighted([1, 3])]++;
        expect(hits[1]).toBeGreaterThan(hits[0] * 2);
        expect(new Rng(5).fork().next()).toBe(new Rng(5).fork().next());
    });

    test('hashString / mix32 are stable', () => {
        expect(hashString('heart')).toBe(hashString('heart'));
        expect(hashString('heart')).not.toBe(hashString('Heart'));
        expect(hashString('')).toBe(0x811c9dc5);
        expect(mix32(1)).toBe(mix32(1));
        expect(mix32(1)).not.toBe(mix32(2));
    });
});

describe('hash', () => {
    test('zobrist tables are deterministic from (width, height, podCount)', () => {
        const a = new Zobrist(4, 4, 3);
        const b = new Zobrist(4, 4, 3);
        expect(a.cellA).toEqual(b.cellA);
        expect(a.featureB(1, 2, 3)).toBe(b.featureB(1, 2, 3));
        expect(new Zobrist(4, 4, 4).cellA).not.toEqual(a.cellA);
    });

    test('bigint and number forms', () => {
        expect(toBigHash(1, 0)).toBe(1n);
        expect(toBigHash(0, 1)).toBe(1n << 32n);
        expect(toBigHash(-1, -1)).toBe((1n << 64n) - 1n);
        expect(toNumberHash(-1, -1)).toBe(Number.MAX_SAFE_INTEGER);
        const s = Sim.fromLevel(lvl('01', [[[0, 1]], [[1, 1]]], 1));
        expect(s.hash()).toBe(s.hashFromScratch());
    });
});

describe('state store', () => {
    beforeEach(() => {
        runActions.reset();
        roundActions.reset();
        sceneActions.reset();
    });

    test('run state: current level, completion, settings', () => {
        const defaults = { sfx: 0.8, music: 0.6, reducedFx: false, colorBlind: false, speed: 1 as const, unlockAll: false };
        expect(getRunState()).toEqual({ currentLevelId: null, completed: {}, attempts: {}, settings: defaults, firstSeen: {}, unlockAll: false });
        runActions.setCurrentLevel('heart');
        runActions.recordAttempt('heart');
        expect(runActions.markCompleted('heart', 5000)).toEqual({ firstClear: true, improved: true, bestMs: 5000 });
        expect(getRunState().completed).toEqual({ heart: { bestMs: 5000, attempts: 1 } });
        runActions.markCompleted('heart', 9000);
        expect(getRunState().completed.heart?.bestMs).toBe(5000);
        runActions.updateSettings({ music: 0, speed: 2 });
        expect(getRunState()).toMatchObject({ currentLevelId: 'heart', settings: { ...defaults, music: 0, speed: 2 } });
        const before = getRunState();
        runActions.updateSettings({ music: 0 });
        expect(getRunState()).toBe(before);
    });

    test('run state notifies subscribers and exposes unlock + firstSeen', () => {
        let calls = 0;
        const off = onRunChange(() => calls++);
        runActions.updateSettings({ colorBlind: true });
        runActions.updateSettings({ colorBlind: true });
        expect(calls).toBe(1);
        expect(isLevelUnlocked('a', ['a', 'b'])).toBe(true);
        expect(isLevelUnlocked('b', ['a', 'b'])).toBe(false);
        runActions.markCompleted('a', 1000);
        expect(isLevelUnlocked('b', ['a', 'b'])).toBe(true);
        runActions.markSeen('tip-lock');
        expect(hasSeen('tip-lock')).toBe(true);
        expect(hasSeen('tip-pair')).toBe(false);
        runActions.setUnlockAll(true);
        expect(isLevelUnlocked('b', ['x', 'b'])).toBe(true);
        off();
    });

    test('round state: start, retry attempts, elapsed, taps, status, snapshot', () => {
        roundActions.start('heart');
        roundActions.addElapsed(100);
        roundActions.recordTap();
        expect(getRoundState()).toMatchObject({ levelId: 'heart', status: 'playing', elapsedMs: 100, taps: 1, attempts: 1 });
        roundActions.start('heart');
        expect(getRoundState()).toMatchObject({ elapsedMs: 0, taps: 0, attempts: 2 });
        roundActions.setStatus('won');
        roundActions.addElapsed(100);
        expect(getRoundState().elapsedMs).toBe(0);
        const snap = Sim.fromLevel(lvl('0', [[[0, 1]]], 1)).snapshot();
        roundActions.setSnapshot(snap);
        expect(getRoundState().snapshot).toBe(snap);
        roundActions.start('star');
        expect(getRoundState().attempts).toBe(1);
    });

    test('scene state: paused, speed, overlay', () => {
        sceneActions.setPaused(true);
        sceneActions.setSpeed(2);
        sceneActions.setOverlay('lose');
        expect(getSceneState()).toEqual({ paused: true, speed: 2, overlay: 'lose' });
    });
});
