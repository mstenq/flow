import { describe, expect, test } from 'bun:test';
import {
    CUE_EVENT_TYPES,
    ClaimLimiter,
    SCALES,
    chooseKey,
    claimMidi,
    buildPatterns,
    cuesForEvent,
    intensityFromSnapshot,
    intensityLayers,
    midiToHz,
    scaleNote,
} from '@game/music';
import type { SimEvent } from '@game/types';
import { AudioDirector } from '../../src/phaser/audio/AudioDirector';
import { AudioEngine } from '../../src/phaser/audio/AudioEngine';

describe('key choice', () => {
    test('deterministic per seed, varied across seeds', () => {
        expect(chooseKey(42)).toEqual(chooseKey(42));
        const names = new Set<string>();
        const roots = new Set<number>();
        for (let s = 0; s < 200; s++) {
            const k = chooseKey(s);
            names.add(k.scale.name);
            roots.add(k.rootMidi);
            expect(k.rootMidi).toBeGreaterThanOrEqual(36);
            expect(k.rootMidi).toBeLessThan(48);
            expect(k.bpm).toBeGreaterThanOrEqual(84);
            expect(k.bpm).toBeLessThanOrEqual(108);
        }
        expect(names.size).toBe(SCALES.length);
        expect(roots.size).toBeGreaterThan(6);
    });
    test('patterns are deterministic', () => {
        expect(buildPatterns(7)).toEqual(buildPatterns(7));
        expect(buildPatterns(7).arp).toHaveLength(16);
    });
});

describe('pentatonic pitch mapping', () => {
    const key = chooseKey(3);
    test('color indices ascend and wrap an octave every 5', () => {
        for (let c = 0; c < 9; c++) expect(claimMidi(key, c + 1)).toBeGreaterThan(claimMidi(key, c));
        expect(claimMidi(key, 5)).toBe(claimMidi(key, 0) + 12);
    });
    test('every note is in the scale', () => {
        for (let c = 0; c < 10; c++) {
            const rel = (((claimMidi(key, c) - key.rootMidi) % 12) + 12) % 12;
            expect(key.scale.steps).toContain(rel);
        }
        expect(scaleNote(key, -1)).toBe(key.rootMidi - 12 + key.scale.steps[4]!);
    });
    test('colors 10..35 wrap instead of climbing past two octaves', () => {
        const top = claimMidi(key, 9);
        for (let c = 0; c < 36; c++) {
            const m = claimMidi(key, c);
            expect(m).toBeLessThanOrEqual(top);
            expect(m).toBe(claimMidi(key, c % 10));
            const rel = (((m - key.rootMidi) % 12) + 12) % 12;
            expect(key.scale.steps).toContain(rel);
        }
        for (let s = 0; s < 50; s++) expect(midiToHz(claimMidi(chooseKey(s), 19))).toBeLessThan(4000);
    });
    test('midiToHz', () => {
        expect(midiToHz(69)).toBeCloseTo(440);
        expect(midiToHz(81)).toBeCloseTo(880);
    });
});

describe('intensity -> layers', () => {
    const at = (used: number, total = 6, full = false) => intensityLayers({ lanesUsed: used, lanesTotal: total, lanesFull: full });
    test('more lanes add layers and speed', () => {
        const a = at(0);
        const b = at(3);
        const c = at(5);
        expect(a.hats).toBe(0);
        expect(b.hats).toBeGreaterThan(0);
        expect(c.hats).toBeGreaterThan(b.hats);
        expect(a.arpEvery).toBeGreaterThan(b.arpEvery);
        expect(b.arpEvery).toBeGreaterThan(c.arpEvery);
        expect(c.arp).toBeGreaterThan(a.arp);
        expect(c.cutoffHz).toBeGreaterThan(a.cutoffHz);
    });
    test('full lanes are just the top of the ramp (no extra harsh layer)', () => {
        expect(at(6, 6, true)).toEqual(at(6, 6, false));
        expect(at(2, 2, true)).toEqual(at(6, 6, true));
        expect(at(6, 6, true).cutoffHz).toBeLessThanOrEqual(4500);
    });
    test('zero lanes does not divide by zero', () => {
        expect(at(0, 0).arp).toBeGreaterThan(0);
    });
    test('snapshot derivation', () => {
        const lane = { podId: 1, color: 0, capacity: 1, remaining: 1, state: 'draining' as const, link: null };
        expect(intensityFromSnapshot({ lanes: [lane, null, lane] })).toEqual({ lanesUsed: 2, lanesTotal: 3, lanesFull: false });
        expect(intensityFromSnapshot({ lanes: [lane, lane] }).lanesFull).toBe(true);
    });
});

describe('claim limiter', () => {
    test('caps the rate under a burst', () => {
        const l = new ClaimLimiter(25, 5);
        let ok = 0;
        for (let i = 0; i < 1000; i++) if (l.tryAcquire(i * 0.001)) ok++; // 1000/s for 1 s
        expect(ok).toBeLessThanOrEqual(25 + 5 + 1);
        expect(ok).toBeGreaterThanOrEqual(25);
    });
    test('recovers after a burst', () => {
        const l = new ClaimLimiter(25, 5);
        for (let i = 0; i < 100; i++) l.tryAcquire(0);
        expect(l.tryAcquire(0)).toBe(false);
        expect(l.tryAcquire(1)).toBe(true);
    });
    test('survives the clock going backwards', () => {
        const l = new ClaimLimiter(25, 5);
        l.tryAcquire(100);
        expect(() => l.tryAcquire(0)).not.toThrow();
    });
});

describe('event -> cue mapping', () => {
    const samples: SimEvent[] = [
        { t: 'tapped', podIds: [1], lanes: [0] },
        { t: 'claimed', podId: 1, lane: 0, x: 0, y: 0, color: 3, path: [] },
        { t: 'keyCollected', keyId: 1, x: 0, y: 0, podId: 2 },
        { t: 'unlocked', podId: 2 },
        { t: 'revealed', podId: 2 },
        { t: 'podCompleted', podId: 1, lane: 0 },
        { t: 'won' },
        { t: 'dead' },
    ];
    test('covers every event type', () => {
        expect(new Set(samples.map((e) => e.t))).toEqual(new Set(CUE_EVENT_TYPES));
        for (const e of samples) expect(cuesForEvent(e).length).toBeGreaterThan(0);
    });
    test('claim carries its color', () => {
        expect(cuesForEvent(samples[1]!)).toEqual([{ sfx: 'claim', color: 3 }]);
    });
});

describe('AudioDirector without WebAudio', () => {
    test('is a safe no-op', () => {
        const d = new AudioDirector();
        const snap = { lanes: [null, null], columns: [] } as never;
        expect(() => {
            d.unlock();
            d.installUnlock();
            d.setVolumes({ music: 0.5, sfx: 0.2 });
            d.onLevelStart(5);
            d.onEvents([{ t: 'tapped', podIds: [1], lanes: [0] }], snap);
            d.onDenied('noLane');
            d.onUiClick();
            d.onPauseChanged(true);
            d.onPauseChanged(false);
            d.onWin();
            d.onOverload();
            d.onLevelExit();
            d.dispose();
        }).not.toThrow();
        expect(d.getVolumes()).toEqual({ music: 0.5, sfx: 0.2 });
    });
});

describe('AudioDirector hookup rules', () => {
    function spied() {
        const engine = new AudioEngine();
        const calls: string[] = [];
        engine.pause = () => void calls.push('suspend');
        engine.resume = () => void calls.push('resume');
        engine.setMusicDuck = (d: number) => void calls.push(`duck:${d}`);
        const director = new AudioDirector(engine);
        const cues: string[] = [];
        director.sfx.play = (cue) => void cues.push(cue.sfx);
        return { director, calls, cues };
    }
    const snap = { lanes: [null, null], columns: [] } as never;

    test('pausing mutes music but never suspends the context (UI clicks must stay audible)', () => {
        const { director, calls } = spied();
        director.onPauseChanged(true);
        expect(calls).toEqual(['duck:0']);
        director.onPauseChanged(false);
        expect(calls).toEqual(['duck:0', 'duck:1']);
    });

    test('only a hidden tab suspends the context', () => {
        const { director, calls } = spied();
        director.onVisibilityChanged(true);
        director.onVisibilityChanged(false);
        expect(calls).toEqual(['suspend', 'resume']);
    });

    test('visual-timed events are left to the visual hooks, which fire once', () => {
        const { director, cues } = spied();
        director.onLevelStart(1);
        director.onEvents(
            [
                { t: 'claimed', podId: 1, lane: 0, x: 0, y: 0, color: 2, path: [] },
                { t: 'unlocked', podId: 1 },
                { t: 'podCompleted', podId: 1, lane: 0 },
                { t: 'won' },
            ],
            snap,
            true,
        );
        expect(cues).toEqual(['claim']);
        director.onGooArrived();
        director.onKeyArrived();
        director.onPodLaunched();
        director.onWin();
        director.onWin();
        director.onOverload();
        expect(cues).toEqual(['claim', 'tick', 'lockShatter', 'podComplete', 'win']);
    });

    test('without visual timing the sim events play immediately (old behaviour)', () => {
        const { director, cues } = spied();
        director.onEvents([{ t: 'unlocked', podId: 1 }, { t: 'won' }], snap);
        expect(cues).toEqual(['lockShatter', 'win']);
    });
});
