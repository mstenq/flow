/** Tiny ZzFX-style synth helpers: one oscillator voice and one filtered noise burst. */
import type { AudioEngine } from './AudioEngine';

export interface ToneOpts {
    freq: number;
    /** Exponential glide target at the end of the note. */
    endFreq?: number;
    dur: number;
    type?: OscillatorType;
    vol?: number;
    /** Seconds from now. */
    delay?: number;
    attack?: number;
    detune?: number;
    /** Optional waveshaper inserted after the envelope (distortion / bitcrush). */
    shaper?: WaveShaperNode | null;
}

export interface Voice {
    gain: GainNode;
    osc: OscillatorNode;
    endTime: number;
}

export function tone(engine: AudioEngine, dest: AudioNode, o: ToneOpts): Voice | null {
    const ctx = engine.ctx;
    if (!ctx) return null;
    const t = ctx.currentTime + (o.delay ?? 0);
    const attack = Math.min(o.attack ?? 0.004, o.dur / 2);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(o.freq, t);
    if (o.endFreq) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.endFreq), t + o.dur);
    if (o.detune) osc.detune.value = o.detune;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(o.vol ?? 0.3, t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    osc.connect(gain);
    if (o.shaper) {
        gain.connect(o.shaper);
        o.shaper.connect(dest);
    } else {
        gain.connect(dest);
    }
    osc.start(t);
    osc.stop(t + o.dur + 0.03);
    osc.onended = () => {
        osc.disconnect();
        gain.disconnect();
    };
    return { gain, osc, endTime: t + o.dur };
}

export interface NoiseOpts {
    dur: number;
    vol?: number;
    delay?: number;
    filter?: BiquadFilterType;
    freq?: number;
    endFreq?: number;
    q?: number;
    attack?: number;
}

export function noise(engine: AudioEngine, dest: AudioNode, o: NoiseOpts): void {
    const ctx = engine.ctx;
    const buf = engine.noiseBuffer();
    if (!ctx || !buf) return;
    const t = ctx.currentTime + (o.delay ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filt = ctx.createBiquadFilter();
    filt.type = o.filter ?? 'bandpass';
    filt.Q.value = o.q ?? 1;
    filt.frequency.setValueAtTime(o.freq ?? 2000, t);
    if (o.endFreq) filt.frequency.exponentialRampToValueAtTime(Math.max(20, o.endFreq), t + o.dur);
    const gain = ctx.createGain();
    const attack = Math.min(o.attack ?? 0.002, o.dur / 2);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(o.vol ?? 0.3, t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    src.connect(filt);
    filt.connect(gain);
    gain.connect(dest);
    src.start(t, Math.random() * 1.5);
    src.stop(t + o.dur + 0.03);
    src.onended = () => {
        src.disconnect();
        filt.disconnect();
        gain.disconnect();
    };
}

/** Hard-clip distortion curve. */
export function distortionCurve(amount: number): Float32Array<ArrayBuffer> {
    const n = 1024;
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        c[i] = Math.tanh(x * amount);
    }
    return c;
}

/** Quantizing (bitcrush-like) curve with `levels` steps. */
export function crushCurve(levels: number): Float32Array<ArrayBuffer> {
    const n = 1024;
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        c[i] = Math.round(x * levels) / levels;
    }
    return c;
}

export function makeShaper(engine: AudioEngine, curve: Float32Array<ArrayBuffer>): WaveShaperNode | null {
    const ctx = engine.ctx;
    if (!ctx) return null;
    const s = ctx.createWaveShaper();
    s.curve = curve;
    return s;
}
