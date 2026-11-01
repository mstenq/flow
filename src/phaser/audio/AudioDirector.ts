/**
 * AudioDirector: the hookup surface for the game. Maps sim events / UI moments to SFX and music intensity.
 * All methods are safe no-ops without WebAudio (SSR, bun tests) or before `unlock()`.
 */
import { cuesForEvents, intensityFromSnapshot, chooseKey } from '../../game/music';
import type { IntensityInput, VolumeSettings } from '../../game/music';
import type { SimEvent, TapDenial, ViewState } from '../../game/types';
import { AudioEngine } from './AudioEngine';
import { MusicEngine } from './MusicEngine';
import { Sfx } from './Sfx';

const CALM: IntensityInput = { lanesUsed: 0, lanesTotal: 1, lanesFull: false };

/** Events whose sound belongs to a later visual moment when the caller uses the visual hooks (see `onEvents`). */
const VISUAL_TIMED: ReadonlySet<SimEvent['t']> = new Set(['unlocked', 'podCompleted', 'won', 'dead']);

export class AudioDirector {
    readonly engine: AudioEngine;
    readonly sfx: Sfx;
    readonly music: MusicEngine;
    private finished = false;
    private wasFull = false;
    private gamePaused = false;
    private hidden = false;
    private schedulerPaused = false;
    private visibilityInstalled = false;
    /** Seed of the level being played (music starts for it as soon as the context exists, e.g. after a deep link). */
    private activeSeed: number | null = null;

    constructor(engine: AudioEngine = new AudioEngine()) {
        this.engine = engine;
        this.sfx = new Sfx(engine);
        this.music = new MusicEngine(engine);
        this.music.setKeyListener((k) => this.sfx.setKey(k));
        engine.onContextCreated(() => {
            if (this.activeSeed !== null && !this.finished && !this.music.playing) this.music.start(this.activeSeed);
        });
    }

    /** Call from the first pointer event (or use `installUnlock()` once at boot). */
    unlock(): void {
        this.engine.unlock();
    }

    installUnlock(target?: EventTarget): void {
        this.engine.installUnlock(target);
    }

    setVolumes(v: Partial<VolumeSettings>): void {
        this.engine.setVolumes(v);
    }

    getVolumes(): VolumeSettings {
        return this.engine.getVolumes();
    }

    /**
     * Dispatch a batch of sim events plus the post-batch snapshot (drives music intensity).
     * With `visualTimed`, the sounds that belong to a later animation (`unlocked`, `podCompleted`, `won`, `dead`)
     * are skipped here: the caller fires them from `onKeyArrived` / `onPodLaunched` / `onWin` / `onOverload` instead.
     */
    onEvents(events: readonly SimEvent[], snapshot: ViewState, visualTimed = false): void {
        if (!this.finished) {
            const ongoing = events.filter((e) => e.t !== 'won' && e.t !== 'dead' && !(visualTimed && VISUAL_TIMED.has(e.t)));
            for (const cue of cuesForEvents(ongoing)) this.sfx.play(cue);
            const intensity = intensityFromSnapshot(snapshot);
            this.music.setIntensity(intensity);
            if (intensity.lanesFull && !this.wasFull) this.sfx.play({ sfx: 'lanesFullWarning' });
            this.wasFull = intensity.lanesFull;
        }
        if (visualTimed) return;
        for (const e of events) {
            if (e.t === 'won') this.onWin();
            else if (e.t === 'dead') this.onOverload();
        }
    }

    /** A goo blob landed in its lane pod (visual moment). */
    onGooArrived(): void {
        if (!this.finished) this.sfx.play({ sfx: 'tick' });
    }

    /** A completed pod launched out of its lane (visual moment). */
    onPodLaunched(): void {
        if (!this.finished) this.sfx.play({ sfx: 'podComplete' });
    }

    /** A collected key reached its lock (visual moment). */
    onKeyArrived(): void {
        if (!this.finished) this.sfx.play({ sfx: 'lockShatter' });
    }

    onDenied(_reason?: TapDenial): void {
        this.sfx.play({ sfx: 'denied' });
    }

    onUiClick(): void {
        this.sfx.play({ sfx: 'uiClick' });
    }

    /** Level (re)start: pick the key from the seed and start the music. */
    onLevelStart(seed: number): void {
        this.finished = false;
        this.wasFull = false;
        this.activeSeed = seed;
        this.music.setIntensity(CALM); // a retry after a full-lanes overload must not start tense
        this.sfx.setKey(chooseKey(seed));
        this.music.start(seed);
    }

    /** Idempotent per level (also triggered by a `won` event in `onEvents`). */
    onWin(): void {
        if (this.finished) return;
        this.finished = true;
        this.activeSeed = null;
        this.sfx.play({ sfx: 'win' });
        this.music.resolve();
    }

    /** Idempotent per level (also triggered by a `dead` event in `onEvents`). */
    onOverload(): void {
        if (this.finished) return;
        this.finished = true;
        this.activeSeed = null;
        this.sfx.play({ sfx: 'overload' });
        this.music.stop();
    }

    /**
     * Pause menu: stop the music scheduler and mute the music bus. The context keeps running so UI clicks in the
     * pause and settings menus still sound.
     */
    onPauseChanged(paused: boolean): void {
        this.gamePaused = paused;
        this.engine.setMusicDuck(paused ? 0 : 1);
        this.syncScheduler();
    }

    /** Tab hidden / shown: suspend the whole context while hidden (nothing is audible or scheduled then). */
    onVisibilityChanged(hidden: boolean): void {
        this.hidden = hidden;
        if (hidden) this.engine.pause();
        else this.engine.resume();
        this.syncScheduler();
    }

    /** Forward `visibilitychange` to `onVisibilityChanged`. Safe to call repeatedly. */
    installVisibility(): void {
        if (this.visibilityInstalled || typeof document === 'undefined') return;
        this.visibilityInstalled = true;
        document.addEventListener('visibilitychange', () => this.onVisibilityChanged(document.hidden));
    }

    private syncScheduler(): void {
        const shouldPause = this.gamePaused || this.hidden;
        if (shouldPause === this.schedulerPaused) return;
        this.schedulerPaused = shouldPause;
        if (shouldPause) this.music.pause();
        else this.music.resume();
    }

    /** Leaving the level (back to menu): stop music without a win/lose sting. */
    onLevelExit(): void {
        this.activeSeed = null;
        this.music.stop();
    }

    /** Observable resources, for the headless leak check. */
    stats(): { music: ReturnType<MusicEngine['stats']>; contextState: string; visibilityListeners: number } {
        return { music: this.music.stats(), contextState: this.engine.ctx?.state ?? 'none', visibilityListeners: this.visibilityInstalled ? 1 : 0 };
    }

    dispose(): void {
        this.music.dispose();
        this.engine.dispose();
    }
}

export const audioDirector = new AudioDirector();
