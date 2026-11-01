/** Construction / mechanics knobs sampled around a target difficulty (plan/02-generator.md knob table). */
import type { Rng } from '@game/rng';

export type DealStyle = 'balanced' | 'random' | 'clumped' | 'roundrobin';

export interface Knobs {
    lanes: number;
    columns: number;
    /** Inclusive range of pods per color (sets the typical pod size). */
    podsPerColor: [number, number];
    /** Chance to keep an overflow pod (capacity > reachable) when the lane budget allows one. */
    overflowRate: number;
    /** Chance per step to park a pod whose color has nothing reachable. */
    parkRate: number;
    /** Most lanes the solution may leave stalled after a settle (always ≤ lanes − 1). */
    maxStalled: number;
    deal: DealStyle;
    hiddenShare: number;
    keys: number;
    pairs: number;
    /** Hard cap on pod capacity (set by `--max-pod`; undefined = no cap). */
    maxPod?: number;
}

/** Below this target a level gets no mechanics at all. */
export const EASY_CUTOFF = 0.25;

export interface MechanicCaps {
    hiddenShare: number;
    locks: number;
    pairs: number;
}

/**
 * Most mechanics a level at `target` may carry. Keeps lanes/overflow (the core puzzle) the main source of
 * difficulty: locks and pairs are strong trap generators and the search would otherwise pile them on.
 */
export function mechanicCaps(target: number): MechanicCaps {
    if (target < EASY_CUTOFF) return { hiddenShare: 0, locks: 0, pairs: 0 };
    if (target < 0.45) return { hiddenShare: 0.35, locks: 0, pairs: 0 };
    if (target < 0.8) return { hiddenShare: 0.45, locks: 1, pairs: 1 };
    return { hiddenShare: 0.5, locks: 2, pairs: 2 };
}

function clamp01(v: number): number {
    return Math.max(0, Math.min(1, v));
}

/** Gaussian-ish jitter (sum of uniforms), deterministic from `rng`. */
function jitter(rng: Rng, sd: number): number {
    return (rng.next() + rng.next() + rng.next() - 1.5) * sd * 2;
}

export function sampleKnobs(target: number, rng: Rng): Knobs {
    const caps = mechanicCaps(target);
    const t = clamp01(target + jitter(rng, 0.12));
    let lanes: number;
    if (t < 0.2) lanes = 5;
    else if (t < 0.4) lanes = 4;
    else if (t < 0.6) lanes = rng.chance(0.5) ? 3 : 4;
    else if (t < 0.8) lanes = 3;
    else lanes = rng.chance(0.4) ? 2 : 3;

    let columns: number;
    if (t < 0.5) columns = rng.int(3, 4);
    else if (t < 0.75) columns = rng.int(3, 5);
    else columns = rng.int(4, 5);

    // Settled play punishes big pods (they outgrow what is reachable), so harder levels use fewer, larger pods.
    const lo = Math.max(1, Math.round(3 - 2 * t));
    const hi = lo + 2;
    const overflowRate = clamp01(t * 1.2 - 0.15 + jitter(rng, 0.08));
    const maxStalled = t < 0.25 ? 1 : t < 0.5 ? Math.min(2, lanes - 1) : lanes - 1;
    const parkRate = t < 0.5 ? 0 : clamp01((t - 0.5) * 0.5);
    const deals: DealStyle[] = ['balanced', 'random', 'clumped', 'roundrobin'];
    const deal = deals[rng.weighted(t < 0.5 ? [4, 2, 1, 2] : [3, 3, 2, 1])];

    const hiddenShare = Math.min(caps.hiddenShare, clamp01(0.1 + t * 0.35 + jitter(rng, 0.05)));
    let keys = 0;
    let pairs = 0;
    if (t >= 0.45) {
        keys = Math.min(caps.locks, t < 0.75 ? rng.int(0, 1) : rng.int(1, 2));
        pairs = Math.min(caps.pairs, t < 0.75 ? rng.int(0, 1) : rng.int(1, 2));
    }
    return { lanes, columns, podsPerColor: [lo, hi], overflowRate, parkRate, maxStalled, deal, hiddenShare, keys, pairs };
}

export function knobsSummary(k: Knobs): string {
    return (
        `lanes ${k.lanes}, cols ${k.columns}, pods/color ${k.podsPerColor[0]}-${k.podsPerColor[1]}, ` +
        `overflow ${k.overflowRate.toFixed(2)}, park ${k.parkRate.toFixed(2)}, maxStalled ${k.maxStalled}, deal ${k.deal}, ` +
        `hidden ${k.hiddenShare.toFixed(2)}, keys ${k.keys}, pairs ${k.pairs}`
    );
}
