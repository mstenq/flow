/**
 * Generative music: lookahead step sequencer (timer fires every ~25 ms, schedules notes up to 100 ms ahead on the
 * AudioContext clock). Layers: pad, bass drone, arpeggiated pentatonic lead (with echo), hats, tension drone.
 * Layer gains and the filter are ramped with setTargetAtTime, so intensity changes never click.
 */
import {
    STEPS_PER_BAR,
    buildPatterns,
    chooseKey,
    intensityLayers,
    midiToHz,
    scaleNote,
} from '../../game/music';
import type { IntensityInput, LayerMix, MusicKey, PatternSet } from '../../game/music';
import type { AudioEngine } from './AudioEngine';

const LOOKAHEAD = 0.1;
const TIMER_MS = 25;

interface Session {
    key: MusicKey;
    patterns: PatternSet;
    out: GainNode;
    filter: BiquadFilterNode;
    pad: GainNode;
    bass: GainNode;
    arp: GainNode;
    hats: GainNode;
    tension: GainNode;
    tensionOscs: OscillatorNode[];
    step: number;
    nextTime: number;
    mix: LayerMix;
}

export class MusicEngine {
    private session: Session | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private intensity: IntensityInput = { lanesUsed: 0, lanesTotal: 1, lanesFull: false };
    private paused = false;
    private onKey: ((k: MusicKey) => void) | null = null;
    /** Sessions that are fading out and still hold nodes until their disposal timeout (leak check). */
    private dying = 0;

    constructor(private readonly engine: AudioEngine) {}

    /** Notified with the key chosen by `start(seed)` so SFX can pitch into it. */
    setKeyListener(fn: (k: MusicKey) => void): void {
        this.onKey = fn;
    }

    get playing(): boolean {
        return this.session !== null;
    }

    /** Observable resources, for the headless leak check. */
    stats(): { session: boolean; timer: boolean; dying: number } {
        return { session: this.session !== null, timer: this.timer !== null, dying: this.dying };
    }

    start(seed: number): void {
        const key = chooseKey(seed);
        this.onKey?.(key);
        const ctx = this.engine.ctx;
        const bus = this.engine.musicBus;
        if (!ctx || !bus) return;
        this.teardown(0.15);
        const mix = intensityLayers(this.intensity);
        const t = ctx.currentTime;

        const out = ctx.createGain();
        out.gain.setValueAtTime(0.0001, t);
        out.gain.linearRampToValueAtTime(1, t + 1.2);
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = mix.cutoffHz;
        filter.Q.value = mix.resonance;
        filter.connect(out);
        out.connect(bus);

        const layer = (v: number): GainNode => {
            const g = ctx.createGain();
            g.gain.value = v * 0.5;
            g.connect(filter);
            return g;
        };
        const pad = layer(mix.pad);
        const bass = layer(mix.bass);
        const hats = layer(mix.hats);
        const tension = layer(mix.tension);
        const arp = layer(mix.arp);
        // Dotted-eighth echo on the arp for width.
        const delay = ctx.createDelay(1);
        delay.delayTime.value = (60 / key.bpm) * 0.75;
        const fb = ctx.createGain();
        fb.gain.value = 0.35;
        const wet = ctx.createGain();
        wet.gain.value = 0.4;
        arp.connect(delay);
        delay.connect(fb);
        fb.connect(delay);
        delay.connect(wet);
        wet.connect(filter);

        // Tension drone: a detuned minor-second pair, silent until lanes fill.
        const tensionOscs: OscillatorNode[] = [];
        for (const semis of [24, 25]) {
            const o = ctx.createOscillator();
            o.type = 'sawtooth';
            o.frequency.value = midiToHz(key.rootMidi + semis);
            const lp = ctx.createBiquadFilter();
            lp.type = 'lowpass';
            lp.frequency.value = 900;
            o.connect(lp);
            lp.connect(tension);
            o.start(t);
            tensionOscs.push(o);
        }

        this.session = {
            key,
            patterns: buildPatterns(seed),
            out,
            filter,
            pad,
            bass,
            arp,
            hats,
            tension,
            tensionOscs,
            step: 0,
            nextTime: t + 0.08,
            mix,
        };
        this.startTimer();
    }

    setIntensity(i: IntensityInput): void {
        this.intensity = i;
        const s = this.session;
        const ctx = this.engine.ctx;
        if (!s || !ctx) return;
        const m = intensityLayers(i);
        s.mix = m;
        const t = ctx.currentTime;
        const tc = 0.35;
        s.pad.gain.setTargetAtTime(m.pad * 0.5, t, tc);
        s.bass.gain.setTargetAtTime(m.bass * 0.5, t, tc);
        s.arp.gain.setTargetAtTime(m.arp * 0.5, t, tc);
        s.hats.gain.setTargetAtTime(m.hats * 0.5, t, tc);
        s.tension.gain.setTargetAtTime(m.tension * 0.35, t, 0.6);
        s.filter.frequency.setTargetAtTime(m.cutoffHz, t, m.tension > 0.5 ? 0.8 : tc);
        s.filter.Q.setTargetAtTime(m.resonance, t, tc);
    }

    /** Win: stop the sequencer, ring out a tonic chord, then fade away. */
    resolve(): void {
        const s = this.session;
        const ctx = this.engine.ctx;
        if (!s || !ctx) return;
        this.stopTimer();
        const t = ctx.currentTime + 0.05;
        s.filter.frequency.setTargetAtTime(7000, t, 0.3);
        s.filter.Q.setTargetAtTime(1, t, 0.3);
        s.tension.gain.setTargetAtTime(0, t, 0.2);
        for (const d of [0, 2, 4, 5, 7]) this.padNote(s, scaleNote(s.key, d, 1), t, 4.5);
        s.out.gain.cancelScheduledValues(t);
        s.out.gain.setValueAtTime(s.out.gain.value, t);
        s.out.gain.setTargetAtTime(0, t + 3.2, 0.6);
        const dying = s;
        this.session = null;
        this.dying++;
        setTimeout(() => {
            this.dying--;
            this.dispose(dying);
        }, 6000);
    }

    stop(): void {
        this.stopTimer();
        this.teardown(0.4);
    }

    pause(): void {
        this.paused = true;
        this.stopTimer();
    }

    resume(): void {
        this.paused = false;
        const s = this.session;
        const ctx = this.engine.ctx;
        if (!s || !ctx) return;
        s.nextTime = ctx.currentTime + 0.08;
        this.startTimer();
    }

    dispose(s?: Session): void {
        if (s) {
            for (const o of s.tensionOscs) {
                try {
                    o.stop();
                } catch {
                    // already stopped
                }
            }
            try {
                s.out.disconnect();
            } catch {
                // context closed
            }
            return;
        }
        this.stopTimer();
        this.teardown(0.05);
    }

    private teardown(fade: number): void {
        const s = this.session;
        this.session = null;
        const ctx = this.engine.ctx;
        if (!s || !ctx) return;
        const t = ctx.currentTime;
        s.out.gain.cancelScheduledValues(t);
        s.out.gain.setValueAtTime(s.out.gain.value, t);
        s.out.gain.linearRampToValueAtTime(0, t + fade);
        this.dying++;
        setTimeout(() => {
            this.dying--;
            this.dispose(s);
        }, (fade + 0.2) * 1000 + 4500); // let scheduled pad tails finish
    }

    private startTimer(): void {
        if (this.timer !== null || this.paused) return;
        this.timer = setInterval(() => this.pump(), TIMER_MS);
        this.pump();
    }

    private stopTimer(): void {
        if (this.timer === null) return;
        clearInterval(this.timer);
        this.timer = null;
    }

    private pump(): void {
        const s = this.session;
        const ctx = this.engine.ctx;
        if (!s || !ctx || ctx.state !== 'running') {
            if (s && ctx) s.nextTime = Math.max(s.nextTime, ctx.currentTime + 0.05); // don't burst after a stall
            return;
        }
        const stepDur = 60 / s.key.bpm / 4;
        if (s.nextTime < ctx.currentTime) s.nextTime = ctx.currentTime + 0.02;
        while (s.nextTime < ctx.currentTime + LOOKAHEAD) {
            this.scheduleStep(s, s.step, s.nextTime, stepDur);
            s.nextTime += stepDur;
            s.step++;
        }
    }

    private scheduleStep(s: Session, step: number, t: number, stepDur: number): void {
        const inBar = step % STEPS_PER_BAR;
        const bar = Math.floor(step / STEPS_PER_BAR);
        const chord = s.patterns.chords[bar % s.patterns.chords.length]!;
        if (inBar === 0) {
            for (const d of [0, 2, 4]) this.padNote(s, scaleNote(s.key, chord + d, 1), t, stepDur * STEPS_PER_BAR + 0.6);
        }
        const b = s.patterns.bass[inBar];
        if (b !== null && b !== undefined) this.bassNote(s, scaleNote(s.key, chord + b, 0), t, stepDur * 3);
        const a = s.patterns.arp[inBar];
        if (a !== null && a !== undefined && step % s.mix.arpEvery === 0) {
            this.arpNote(s, scaleNote(s.key, chord + a, 2), t, stepDur * 1.6);
        }
        const offbeat = inBar % 4 === 2;
        if (s.mix.hats > 0 && (s.mix.hatsEvery === 1 || offbeat)) this.hat(s, t, offbeat);
    }

    private osc(s: Session, type: OscillatorType, midi: number, t: number, dur: number, dest: AudioNode, vol: number, attack: number, detune = 0): void {
        const ctx = this.engine.ctx;
        if (!ctx) return;
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = type;
        o.frequency.value = midiToHz(midi);
        o.detune.value = detune;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(vol, t + attack);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g);
        g.connect(dest);
        o.start(t);
        o.stop(t + dur + 0.05);
        o.onended = () => {
            o.disconnect();
            g.disconnect();
        };
        void s;
    }

    private padNote(s: Session, midi: number, t: number, dur: number): void {
        this.osc(s, 'sawtooth', midi, t, dur, s.pad, 0.18, Math.min(0.8, dur / 3), -7);
        this.osc(s, 'sawtooth', midi, t, dur, s.pad, 0.18, Math.min(0.8, dur / 3), 7);
    }

    private bassNote(s: Session, midi: number, t: number, dur: number): void {
        this.osc(s, 'sine', midi, t, dur, s.bass, 0.5, 0.01);
        this.osc(s, 'sawtooth', midi, t, dur, s.bass, 0.12, 0.01);
    }

    private arpNote(s: Session, midi: number, t: number, dur: number): void {
        this.osc(s, 'square', midi, t, dur, s.arp, 0.16, 0.005);
    }

    private hat(s: Session, t: number, accent: boolean): void {
        const ctx = this.engine.ctx;
        const buf = this.engine.noiseBuffer();
        if (!ctx || !buf) return;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 7000;
        const g = ctx.createGain();
        const dur = accent ? 0.07 : 0.035;
        g.gain.setValueAtTime(accent ? 0.35 : 0.22, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        src.connect(hp);
        hp.connect(g);
        g.connect(s.hats);
        src.start(t, (t * 7.3) % 1.5);
        src.stop(t + dur + 0.02);
        src.onended = () => {
            src.disconnect();
            hp.disconnect();
            g.disconnect();
        };
    }
}
