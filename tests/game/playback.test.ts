import { describe, expect, test } from 'bun:test';
import { GameFacade } from '@game/gameFacade';
import { computeLayout } from '@game/layout';
import type { SimEvent, ViewState } from '@game/types';
import { PlaybackRunner, enqueuePlayback } from '../../src/phaser/PlaybackRunner';
import type { PlaybackTargets } from '../../src/phaser/PlaybackRunner';
import { lvl } from './helpers';

/** Fake views that just record the calls the runner makes (the runner only needs the interface). */
function fakes(snapshot: () => ViewState) {
    const log: string[] = [];
    const launches: { points: { x: number; y: number }[]; color: number; onArrive?: () => void }[] = [];
    let flying = 0;
    const layout = computeLayout({ width: 4, height: 1, columns: 2, lanes: 2 });
    const targets = {
        layout,
        palette: [0xff0000, 0x00ff00],
        board: {
            sync: () => log.push('board.sync'),
            onClaimed: (e: { x: number; y: number }) => log.push(`board.claimed ${e.x},${e.y}`),
        },
        goo: {
            launch: (l: (typeof launches)[number]) => {
                launches.push(l);
                log.push('goo.launch');
            },
            activeCount: 0,
        },
        lanes: {
            sync: () => log.push('lanes.sync'),
            slotCenter: (l: number) => ({ x: 100 + l, y: 850 }),
            flash: (l: number) => log.push(`lanes.flash ${l}`),
            pulse: (l: number) => log.push(`lanes.pulse ${l}`),
        },
        queue: {
            sync: () => log.push('queue.sync'),
            onTapped: (ids: number[]) => log.push(`queue.tapped ${ids.join(',')}`),
            onUnlocked: (id: number) => log.push(`queue.unlocked ${id}`),
            podCenter: () => ({ x: 300, y: 1000 }),
            get flyingCount() {
                return flying;
            },
        },
        getSnapshot: snapshot,
    };
    return { targets: targets as unknown as PlaybackTargets, log, launches, setFlying: (n: number) => (flying = n) };
}

function setup() {
    const level = lvl('0011', [[[0, 2]], [[1, 2]]], 2, [], { solution: [0, 1] });
    const facade = new GameFacade();
    facade.load(level);
    return { facade, ...fakes(() => facade.snapshot()) };
}

describe('PlaybackRunner', () => {
    test('nothing happens until events are pumped; then views react and refresh from the snapshot', () => {
        const { facade, targets, log } = setup();
        const runner = new PlaybackRunner(targets);
        expect(runner.pump()).toBe(true); // initial forced sync
        expect(log).toEqual(['board.sync', 'lanes.sync', 'queue.sync']);
        log.length = 0;
        expect(runner.pump()).toBe(false);

        const result = facade.tap(0);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        enqueuePlayback(result.events);
        expect(log).toEqual([]);
        expect(runner.isIdle()).toBe(false);
        runner.pump();
        expect(log).toEqual(['queue.tapped 1', 'lanes.flash 0', 'board.sync', 'lanes.sync', 'queue.sync']);
        runner.dispose();
    });

    test('pushed reuses the tapped flight for the pod and flashes its lane', () => {
        const { targets, log } = setup();
        const runner = new PlaybackRunner(targets);
        runner.pump();
        log.length = 0;
        runner.enqueue([{ t: 'pushed', podId: 7, lane: 1 }]);
        runner.pump();
        expect(log).toEqual(['queue.tapped 7', 'lanes.flash 1', 'board.sync', 'lanes.sync', 'queue.sync']);
        runner.dispose();
    });

    test('waveStarted dismisses the banner quickly and releases the lanes after the views sync', () => {
        const { targets, log } = setup();
        const banner = { show: (n: number) => log.push(`banner.show ${n}`), hide: (q?: boolean) => log.push(`banner.hide ${q === true}`) };
        (targets.lanes as unknown as Record<string, unknown>).release = (l: number[]) => log.push(`lanes.release ${l.join(',')}`);
        (targets.lanes as unknown as Record<string, unknown>).setInvite = (on: boolean) => log.push(`lanes.invite ${on}`);
        (targets as unknown as Record<string, unknown>).banner = banner;
        const runner = new PlaybackRunner(targets);
        runner.pump();
        log.length = 0;
        runner.enqueue([{ t: 'waveStarted', lanes: [0, 1] }, { t: 'waveEnded' }]);
        runner.pump();
        expect(log).toEqual(['banner.hide true', 'board.sync', 'lanes.sync', 'queue.sync', 'lanes.invite false', 'banner.hide false', 'lanes.release 0,1']);
        runner.dispose();
    });

    test('a fill-first board waiting for lanes shows the banner with the empty count and pulses the slots', () => {
        const level = lvl('0011', [[[0, 2]], [[1, 2]]], 2, [], { fillFirst: true });
        const facade = new GameFacade();
        facade.load(level);
        const { targets, log } = fakes(() => facade.snapshot());
        (targets.lanes as unknown as Record<string, unknown>).setInvite = (on: boolean) => log.push(`lanes.invite ${on}`);
        (targets as unknown as Record<string, unknown>).banner = {
            show: (n: number) => log.push(`banner.show ${n}`),
            hide: () => log.push('banner.hide'),
        };
        const runner = new PlaybackRunner(targets);
        runner.pump();
        expect(log.slice(-2)).toEqual(['lanes.invite true', 'banner.show 2']);
        const result = facade.tap(0);
        if (!result.ok) throw new Error('tap failed');
        log.length = 0;
        runner.enqueue(result.events);
        runner.pump();
        expect(log.slice(-2)).toEqual(['lanes.invite true', 'banner.show 1']);
        const second = facade.tap(1);
        if (!second.ok) throw new Error('tap failed');
        log.length = 0;
        runner.enqueue(second.events);
        runner.pump();
        expect(log.slice(-2)).toEqual(['lanes.invite false', 'banner.hide']);
        runner.dispose();
    });

    test('claims run concurrently: every claimed event launches goo that ends at its lane slot', () => {
        const { facade, targets, log, launches } = setup();
        const runner = new PlaybackRunner(targets);
        runner.pump();
        facade.tap(0);
        facade.tap(1);
        const events = facade.advance(50); // one tick: both lanes claim
        const claims = events.filter((e): e is Extract<SimEvent, { t: 'claimed' }> => e.t === 'claimed');
        expect(claims).toHaveLength(2);
        log.length = 0;
        runner.enqueue(events);
        runner.pump();
        expect(launches).toHaveLength(2);
        for (const [i, launch] of launches.entries()) {
            const lane = claims[i]!.lane;
            expect(launch.points[launch.points.length - 1]).toEqual({ x: 100 + lane, y: 850 });
            expect(launch.points.length).toBeGreaterThanOrEqual(2);
            launch.onArrive?.();
        }
        expect(log.filter((l) => l.startsWith('board.claimed'))).toHaveLength(2);
        expect(log.filter((l) => l.startsWith('lanes.pulse'))).toHaveLength(2);
        runner.dispose();
    });

    test('exit points are pulled in near the board edge, not a full cell outside', () => {
        const { facade, targets, launches } = setup();
        const { layout } = targets;
        const runner = new PlaybackRunner(targets);
        runner.pump();
        facade.tap(0);
        runner.enqueue(facade.advance(50));
        runner.pump();
        const pts = launches[0]!.points;
        const exit = pts[pts.length - 2]!;
        const edge = pts[pts.length - 3]!;
        const reach = Math.hypot(exit.x - edge.x, exit.y - edge.y);
        expect(reach).toBeCloseTo(layout.board.cell / 2 + 10, 5);
        runner.dispose();
    });

    test('won fires the hook; idle waits for goo and flying pods', () => {
        const { facade, targets, setFlying } = setup();
        let won = 0;
        const runner = new PlaybackRunner(targets, { onWon: () => won++ });
        runner.pump();
        facade.tap(0);
        facade.tap(1);
        const events = facade.advance(200);
        expect(events.some((e) => e.t === 'won')).toBe(true);
        runner.enqueue(events);
        runner.pump();
        expect(won).toBe(1);
        expect(runner.isIdle()).toBe(true);
        setFlying(1);
        expect(runner.isIdle()).toBe(false);
        runner.dispose();
    });

    test('enqueuePlayback after dispose is a no-op', () => {
        const { targets } = setup();
        const runner = new PlaybackRunner(targets);
        runner.dispose();
        expect(() => enqueuePlayback([{ t: 'won' }])).not.toThrow();
        expect(runner.isIdle()).toBe(true);
    });
});
