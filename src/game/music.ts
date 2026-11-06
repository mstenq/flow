/**
 * Pure audio logic for FLOW: scales, seed -> key choice, step patterns, intensity -> layer mapping, claim rate
 * limiting and the SimEvent -> sound-cue mapping. No WebAudio, no DOM: everything here is unit-testable.
 * The WebAudio side lives in `src/phaser/audio/`.
 */
import { mix32, mulberry32 } from './rng';
import type { SimEvent, SimEventType, ViewState } from './types';

// ---------- Scales and keys ----------

export interface ScaleDef {
    name: string;
    /** Five semitone offsets from the root, ascending, within one octave. */
    steps: readonly number[];
}

export const SCALES: readonly ScaleDef[] = [
    { name: 'minorPentatonic', steps: [0, 3, 5, 7, 10] },
    { name: 'majorPentatonic', steps: [0, 2, 4, 7, 9] },
    { name: 'suspended', steps: [0, 2, 5, 7, 10] },
    { name: 'hirajoshi', steps: [0, 2, 3, 7, 8] },
];

export interface MusicKey {
    /** MIDI note of the root, in the bass register (C2..B2 = 36..47). */
    rootMidi: number;
    scaleIndex: number;
    scale: ScaleDef;
    /** Beats per minute (quarter note). */
    bpm: number;
}

export const SCALE_DEGREES = 5;

/** Deterministic key/scale/tempo from a level seed. */
export function chooseKey(seed: number): MusicKey {
    const h = mix32(seed ^ 0x51ed270b) >>> 0;
    const scaleIndex = h % SCALES.length;
    const rootMidi = 36 + (Math.floor(h / SCALES.length) % 12);
    const bpm = 84 + (Math.floor(h / 64) % 5) * 6;
    return { rootMidi, scaleIndex, scale: SCALES[scaleIndex]!, bpm };
}

export function midiToHz(midi: number): number {
    return 440 * Math.pow(2, (midi - 69) / 12);
}

/** MIDI note for a (possibly negative / > 4) scale-degree index: 5 degrees per octave. */
export function scaleNote(key: MusicKey, degreeIndex: number, octaveOffset = 0): number {
    const octave = Math.floor(degreeIndex / SCALE_DEGREES);
    const degree = degreeIndex - octave * SCALE_DEGREES;
    return key.rootMidi + 12 * (octave + octaveOffset) + key.scale.steps[degree]!;
}

/** Colors that get their own claim pitch: two octaves of the pentatonic scale, then the walk starts over. */
export const CLAIM_PITCHES = 10;

/**
 * Claim blip pitch: color index walks up the pentatonic scale for two octaves (the original 10 colors), then wraps,
 * so colors 10..19 never climb into piercing registers (the top note stays near C6).
 */
export function claimMidi(key: MusicKey, color: number): number {
    const c = Math.max(0, Math.floor(color)) % CLAIM_PITCHES;
    return scaleNote(key, c, 3);
}

// ---------- Step patterns ----------

export const STEPS_PER_BAR = 16;

export interface PatternSet {
    /** 16 entries: scale-degree index for the arp, or null for a rest. */
    arp: (number | null)[];
    /** 16 entries: bass degree index, or null. */
    bass: (number | null)[];
    /** Four bars of chord-root degree indices (pad + bass follow it). */
    chords: number[];
}

export function buildPatterns(seed: number): PatternSet {
    const rng = mulberry32(seed ^ 0x9e3779b9);
    const pick = (n: number) => Math.floor(rng() * n);
    const chordPool = [0, 2, 3, 4, 1];
    const chords = [0, chordPool[pick(5)]!, chordPool[pick(5)]!, chordPool[pick(5)]!];
    const arp: (number | null)[] = [];
    let cur = pick(5);
    for (let i = 0; i < STEPS_PER_BAR; i++) {
        if (i % 4 !== 0 && rng() < 0.22) {
            arp.push(null);
            continue;
        }
        cur = Math.max(0, Math.min(9, cur + pick(5) - 2));
        arp.push(cur);
    }
    const bass: (number | null)[] = new Array<number | null>(STEPS_PER_BAR).fill(null);
    bass[0] = 0;
    bass[8] = 0;
    bass[6 + pick(2) * 4] = 2;
    bass[14] = rng() < 0.5 ? 4 : null;
    return { arp, bass, chords };
}

// ---------- Intensity -> layers ----------

export interface IntensityInput {
    lanesUsed: number;
    lanesTotal: number;
    lanesFull: boolean;
}

export interface LayerMix {
    /** 0..1 gains per layer. */
    pad: number;
    bass: number;
    arp: number;
    hats: number;
    /** Play the arp every N steps (4 = quarters, 2 = eighths, 1 = sixteenths). */
    arpEvery: 1 | 2 | 4;
    hatsEvery: 1 | 2;
    /**
     * Music lowpass cutoff in Hz. Full lanes get no extra layer, resonance or drone: with only 2-3 lanes they fill
     * constantly, so "full" is just the top of the same ramp (busiest arp/hats, brightest filter).
     */
    cutoffHz: number;
}

export function lanePressure(i: IntensityInput): number {
    if (i.lanesTotal <= 0) return 0;
    return Math.max(0, Math.min(1, i.lanesUsed / i.lanesTotal));
}

export function intensityLayers(i: IntensityInput): LayerMix {
    const p = lanePressure(i);
    return {
        pad: 0.7,
        bass: 0.6 + 0.2 * p,
        arp: 0.3 + 0.5 * p,
        hats: p < 0.34 ? 0 : p < 0.67 ? 0.4 : 0.7,
        arpEvery: p < 0.25 ? 4 : p < 0.6 ? 2 : 1,
        hatsEvery: p < 0.67 ? 2 : 1,
        cutoffHz: 900 + 3600 * p,
    };
}

export function intensityFromSnapshot(s: Pick<ViewState, 'lanes'>): IntensityInput {
    const lanesTotal = s.lanes.length;
    let lanesUsed = 0;
    for (const l of s.lanes) if (l) lanesUsed++;
    return { lanesUsed, lanesTotal, lanesFull: lanesTotal > 0 && lanesUsed === lanesTotal };
}

// ---------- Claim rate limiter ----------

/** Token bucket: sustained `perSecond`, with a small burst allowance. Time is passed in (seconds). */
export class ClaimLimiter {
    private tokens: number;
    private last = Number.NEGATIVE_INFINITY;

    constructor(
        private readonly perSecond = 25,
        private readonly burst = 5,
    ) {
        this.tokens = burst;
    }

    tryAcquire(nowSec: number): boolean {
        if (nowSec < this.last) this.last = nowSec; // clock went backwards (context restart)
        if (this.last !== Number.NEGATIVE_INFINITY) {
            this.tokens = Math.min(this.burst, this.tokens + (nowSec - this.last) * this.perSecond);
        }
        this.last = nowSec;
        if (this.tokens < 1) return false;
        this.tokens -= 1;
        return true;
    }

    reset(): void {
        this.tokens = this.burst;
        this.last = Number.NEGATIVE_INFINITY;
    }
}

// ---------- SimEvent -> cue ----------

export type SoundCue =
    | { sfx: 'tap' }
    | { sfx: 'pushed' }
    | { sfx: 'waveStart' }
    | { sfx: 'claim'; color: number }
    | { sfx: 'tick' }
    | { sfx: 'podComplete' }
    | { sfx: 'keyCollected' }
    | { sfx: 'lockShatter' }
    | { sfx: 'reveal' }
    | { sfx: 'denied' }
    | { sfx: 'lanesFullWarning' }
    | { sfx: 'overload' }
    | { sfx: 'win' }
    | { sfx: 'uiClick' };

export type SoundCueName = SoundCue['sfx'];

type CueMapper = (e: never) => SoundCue[];

/** One entry per SimEvent type: adding an event type without a mapping fails typecheck. */
const CUE_MAP: { [K in SimEventType]: (e: Extract<SimEvent, { t: K }>) => SoundCue[] } = {
    tapped: () => [{ sfx: 'tap' }],
    claimed: (e) => [{ sfx: 'claim', color: e.color }],
    keyCollected: () => [{ sfx: 'keyCollected' }],
    unlocked: () => [{ sfx: 'lockShatter' }],
    revealed: () => [{ sfx: 'reveal' }],
    pushed: () => [{ sfx: 'pushed' }],
    waveStarted: () => [{ sfx: 'waveStart' }],
    waveEnded: () => [],
    podCompleted: () => [{ sfx: 'podComplete' }],
    won: () => [{ sfx: 'win' }],
    dead: () => [{ sfx: 'overload' }],
};

export const CUE_EVENT_TYPES = Object.keys(CUE_MAP) as SimEventType[];

export function cuesForEvent(e: SimEvent): SoundCue[] {
    return (CUE_MAP[e.t] as unknown as CueMapper)(e as never);
}

export function cuesForEvents(events: readonly SimEvent[]): SoundCue[] {
    const out: SoundCue[] = [];
    for (const e of events) out.push(...cuesForEvent(e));
    return out;
}

export interface VolumeSettings {
    music: number;
    sfx: number;
}

export const DEFAULT_VOLUMES: VolumeSettings = { music: 0.6, sfx: 0.8 };

export function clamp01(v: number): number {
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}
