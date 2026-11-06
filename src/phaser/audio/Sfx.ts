/** One-shot sound effects. Every call is a no-op until the engine's context exists. */
import { ClaimLimiter, claimMidi, chooseKey, midiToHz } from '../../game/music';
import type { MusicKey, SoundCue } from '../../game/music';
import type { AudioEngine } from './AudioEngine';
import { crushCurve, distortionCurve, makeShaper, noise, tone } from './synth';
import type { Voice } from './synth';

const MAX_CLAIM_VOICES = 8;

export class Sfx {
    private readonly limiter = new ClaimLimiter(25, 5);
    /** Splash ticks come with every claim; keep them a light texture. */
    private readonly tickLimiter = new ClaimLimiter(14, 3);
    /** Lanes fill constantly on 2-3 lane levels: at most one full-lanes nudge every 6 s. */
    private readonly lanesFullLimiter = new ClaimLimiter(1 / 6, 1);
    private claimVoices: Voice[] = [];
    private key: MusicKey = chooseKey(0);

    constructor(private readonly engine: AudioEngine) {}

    /** Claim blips are pitched in the current level's key. */
    setKey(key: MusicKey): void {
        this.key = key;
    }

    play(cue: SoundCue): void {
        const ctx = this.engine.ctx;
        const dest = this.engine.sfxBus;
        if (!ctx || !dest || this.engine.isPaused || ctx.state === 'closed') return;
        switch (cue.sfx) {
            case 'tap': return this.tap(dest);
            case 'pushed': return this.pushed(dest);
            case 'waveStart': return this.waveStart(dest);
            case 'claim': return this.claim(cue.color, dest, ctx);
            case 'tick': return this.tickLimiter.tryAcquire(ctx.currentTime) ? this.tick(dest) : undefined;
            case 'podComplete': return this.podComplete(dest);
            case 'keyCollected': return this.keyCollected(dest);
            case 'lockShatter': return this.lockShatter(dest);
            case 'reveal': return this.reveal(dest);
            case 'denied': return this.denied(dest);
            case 'lanesFullWarning': return this.lanesFullLimiter.tryAcquire(ctx.currentTime) ? this.lanesFull(dest) : undefined;
            case 'overload': return this.overload(dest);
            case 'win': return this.win(dest);
            case 'uiClick': return this.uiClick(dest);
        }
    }

    private e(): AudioEngine {
        return this.engine;
    }

    private tap(d: AudioNode): void {
        tone(this.e(), d, { freq: 330, endFreq: 880, dur: 0.09, type: 'square', vol: 0.12 });
    }

    /** A pod dropped into a lane by itself: a lower, dirtier drop than the player's tap blip. */
    private pushed(d: AudioNode): void {
        tone(this.e(), d, { freq: 520, endFreq: 140, dur: 0.12, type: 'sawtooth', vol: 0.11 });
        tone(this.e(), d, { freq: 220, endFreq: 70, dur: 0.1, type: 'square', vol: 0.09 });
    }

    /** Fill-first: every lane is full and the wave lets go. A quick rising two-note release. */
    private waveStart(d: AudioNode): void {
        tone(this.e(), d, { freq: 220, endFreq: 440, dur: 0.14, type: 'sawtooth', vol: 0.08 });
        tone(this.e(), d, { freq: 330, endFreq: 660, dur: 0.18, type: 'triangle', vol: 0.1, attack: 0.04 });
    }

    private claim(color: number, d: AudioNode, ctx: AudioContext): void {
        if (!this.limiter.tryAcquire(ctx.currentTime)) return;
        const now = ctx.currentTime;
        this.claimVoices = this.claimVoices.filter((v) => v.endTime > now);
        if (this.claimVoices.length >= MAX_CLAIM_VOICES) {
            const old = this.claimVoices.shift()!; // voice stealing: fade the oldest out fast
            old.gain.gain.cancelScheduledValues(now);
            old.gain.gain.setTargetAtTime(0, now, 0.004);
            old.osc.stop(now + 0.03);
        }
        const v = tone(this.e(), d, {
            freq: midiToHz(claimMidi(this.key, color)),
            dur: 0.11,
            type: 'triangle',
            vol: 0.1,
            attack: 0.006,
        });
        if (v) this.claimVoices.push(v);
    }

    private tick(d: AudioNode): void {
        tone(this.e(), d, { freq: 1400, dur: 0.03, type: 'square', vol: 0.06 });
    }

    private podComplete(d: AudioNode): void {
        const root = this.key.rootMidi + 36;
        const steps = this.key.scale.steps;
        for (const i of [0, 2, 4]) {
            const m = root + steps[i]!;
            tone(this.e(), d, { freq: midiToHz(m), dur: 0.35, type: 'sawtooth', vol: 0.07, attack: 0.01 });
        }
        noise(this.e(), d, { dur: 0.4, vol: 0.12, filter: 'bandpass', freq: 400, endFreq: 5000, q: 1.5, attack: 0.15 });
    }

    private keyCollected(d: AudioNode): void {
        const steps = this.key.scale.steps;
        for (let i = 0; i < 6; i++) {
            const m = this.key.rootMidi + 48 + steps[i % 5]! + (i >= 5 ? 12 : 0);
            tone(this.e(), d, { freq: midiToHz(m), dur: 0.18, type: 'triangle', vol: 0.09, delay: i * 0.05 });
        }
    }

    private lockShatter(d: AudioNode): void {
        noise(this.e(), d, { dur: 0.25, vol: 0.25, filter: 'highpass', freq: 3000, q: 0.7 });
        tone(this.e(), d, { freq: 2637, dur: 0.5, type: 'sine', vol: 0.1, delay: 0.02 });
        tone(this.e(), d, { freq: 3951, dur: 0.35, type: 'sine', vol: 0.05, delay: 0.03 });
    }

    private reveal(d: AudioNode): void {
        const shaper = makeShaper(this.e(), crushCurve(4));
        for (let i = 0; i < 5; i++) {
            const f = 300 + ((i * 7919) % 900);
            tone(this.e(), d, { freq: f, dur: 0.04, type: 'square', vol: 0.08, delay: i * 0.035, shaper });
        }
        noise(this.e(), d, { dur: 0.2, vol: 0.1, filter: 'bandpass', freq: 4000, q: 4 });
    }

    private denied(d: AudioNode): void {
        tone(this.e(), d, { freq: 110, endFreq: 90, dur: 0.18, type: 'sawtooth', vol: 0.14 });
    }

    /** A soft in-key low note: a nudge, not an alarm. */
    private lanesFull(d: AudioNode): void {
        tone(this.e(), d, { freq: midiToHz(this.key.rootMidi + 12), dur: 0.3, type: 'triangle', vol: 0.08, attack: 0.02 });
    }

    private overload(d: AudioNode): void {
        const shaper = makeShaper(this.e(), distortionCurve(6));
        tone(this.e(), d, { freq: 600, endFreq: 40, dur: 1.1, type: 'sawtooth', vol: 0.16, attack: 0.01, shaper });
        noise(this.e(), d, { dur: 1.0, vol: 0.12, filter: 'lowpass', freq: 3000, endFreq: 80 });
    }

    private win(d: AudioNode): void {
        const steps = this.key.scale.steps;
        for (let i = 0; i < 8; i++) {
            const m = this.key.rootMidi + 48 + steps[i % 5]! + 12 * Math.floor(i / 5);
            tone(this.e(), d, { freq: midiToHz(m), dur: 0.3, type: 'triangle', vol: 0.1, delay: i * 0.08 });
        }
        for (const i of [0, 2, 4]) {
            const m = this.key.rootMidi + 24 + steps[i]!;
            tone(this.e(), d, { freq: midiToHz(m), dur: 2.4, type: 'sawtooth', vol: 0.05, attack: 0.5, delay: 0.3 });
        }
    }

    private uiClick(d: AudioNode): void {
        tone(this.e(), d, { freq: 900, endFreq: 600, dur: 0.04, type: 'square', vol: 0.07 });
    }
}
