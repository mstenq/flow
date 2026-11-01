/**
 * AudioEngine: one lazily created AudioContext plus the bus graph
 *   sfxGain / musicGain -> master -> compressor (limiter) -> destination
 * Every method is a safe no-op before `unlock()` or when WebAudio is missing (SSR, bun tests, old browsers).
 */
import { DEFAULT_VOLUMES, clamp01 } from '../../game/music';
import type { VolumeSettings } from '../../game/music';

type AudioContextCtor = typeof AudioContext;

function getCtor(): AudioContextCtor | null {
    if (typeof window === 'undefined') return null;
    const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
    return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export class AudioEngine {
    ctx: AudioContext | null = null;
    sfxBus: GainNode | null = null;
    musicBus: GainNode | null = null;
    private volumes: VolumeSettings = { ...DEFAULT_VOLUMES };
    private paused = false;
    /** 0..1 multiplier on the music bus (the pause menu mutes music while SFX keep sounding). */
    private musicDuck = 1;
    private noise: AudioBuffer | null = null;
    private unlockInstalled = false;
    private readonly createdListeners: (() => void)[] = [];
    private disposed = false;

    get available(): boolean {
        return getCtor() !== null;
    }

    /** True once a context exists and is running. */
    get running(): boolean {
        return this.ctx !== null && this.ctx.state === 'running';
    }

    /** Run `fn` once the context exists (e.g. start music that was requested before the first gesture). */
    onContextCreated(fn: () => void): void {
        this.createdListeners.push(fn);
    }

    /** Create the context (first call) and try to resume it. Call from a user gesture. */
    unlock(): void {
        if (this.disposed) return;
        try {
            this.ensure();
            if (this.ctx && !this.paused && this.ctx.state !== 'running') void this.ctx.resume().catch(() => {});
        } catch {
            // WebAudio unavailable or blocked: stay silent.
        }
    }

    /** Attach one-shot pointer/touch/key listeners that call `unlock()`. Safe to call repeatedly. */
    installUnlock(target?: EventTarget): void {
        if (this.unlockInstalled || typeof window === 'undefined') return;
        this.unlockInstalled = true;
        const t = target ?? window;
        const events = ['pointerdown', 'touchend', 'keydown'];
        const handler = () => {
            this.unlock();
            if (!this.running) return; // keep listening until it actually runs
            for (const e of events) t.removeEventListener(e, handler);
        };
        for (const e of events) t.addEventListener(e, handler, { passive: true } as AddEventListenerOptions);
    }

    private ensure(): AudioContext | null {
        if (this.ctx) return this.ctx;
        const Ctor = getCtor();
        if (!Ctor) return null;
        const ctx = new Ctor();
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -14;
        comp.knee.value = 12;
        comp.ratio.value = 12;
        comp.attack.value = 0.003;
        comp.release.value = 0.2;
        const master = ctx.createGain();
        master.gain.value = 0.85;
        const sfx = ctx.createGain();
        const music = ctx.createGain();
        sfx.gain.value = this.volumes.sfx;
        music.gain.value = this.volumes.music * this.musicDuck;
        sfx.connect(master);
        music.connect(master);
        master.connect(comp);
        comp.connect(ctx.destination);
        this.ctx = ctx;
        this.sfxBus = sfx;
        this.musicBus = music;
        for (const fn of this.createdListeners) fn();
        return ctx;
    }

    /** Settings shape for the settings screen: both 0..1. */
    getVolumes(): VolumeSettings {
        return { ...this.volumes };
    }

    setVolumes(v: Partial<VolumeSettings>): void {
        if (v.music !== undefined) this.volumes.music = clamp01(v.music);
        if (v.sfx !== undefined) this.volumes.sfx = clamp01(v.sfx);
        const ctx = this.ctx;
        if (!ctx || !this.sfxBus || !this.musicBus) return;
        this.sfxBus.gain.setTargetAtTime(this.volumes.sfx, ctx.currentTime, 0.02);
        this.musicBus.gain.setTargetAtTime(this.volumes.music * this.musicDuck, ctx.currentTime, 0.02);
    }

    /** Duck (0..1) the music bus without touching SFX. 0 = muted. Ramped, click-free. */
    setMusicDuck(duck: number): void {
        this.musicDuck = clamp01(duck);
        const ctx = this.ctx;
        if (!ctx || !this.musicBus) return;
        this.musicBus.gain.setTargetAtTime(this.volumes.music * this.musicDuck, ctx.currentTime, 0.06);
    }

    /** Suspend the whole context (tab hidden). The pause menu must NOT use this: UI clicks have to stay audible. */
    pause(): void {
        this.paused = true;
        if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend().catch(() => {});
    }

    resume(): void {
        this.paused = false;
        if (this.ctx && this.ctx.state !== 'running') void this.ctx.resume().catch(() => {});
    }

    get isPaused(): boolean {
        return this.paused;
    }

    /** Shared 2 s white-noise buffer (cached per context). */
    noiseBuffer(): AudioBuffer | null {
        const ctx = this.ctx;
        if (!ctx) return null;
        if (this.noise) return this.noise;
        const len = ctx.sampleRate * 2;
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = buf.getChannelData(0);
        let s = 0x1234567;
        for (let i = 0; i < len; i++) {
            s = (Math.imul(s, 1664525) + 1013904223) | 0; // cheap LCG, no Math.random needed
            d[i] = (s >>> 8) / 8388608 - 1;
        }
        this.noise = buf;
        return buf;
    }

    dispose(): void {
        this.disposed = true;
        const ctx = this.ctx;
        this.ctx = null;
        this.sfxBus = null;
        this.musicBus = null;
        this.noise = null;
        if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => {});
    }
}
