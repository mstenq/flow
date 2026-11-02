/** Construction / mechanics knobs sampled around a target difficulty (plan/02-generator.md knob table). */
import { Rng } from '@game/rng';

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

/**
 * Added to the target before picking the structural knobs (lanes, columns, pod sizes, stalls). The difficulty score
 * measures sensible players, so even easy targets need some lane pressure to have a way to lose. Hidden pods and
 * the mechanic caps still follow the raw target.
 */
export const STRUCTURE_BOOST = 0.15;

export interface MechanicCaps {
    hiddenShare: number;
    pairs: number;
}

/** Most keys (locked pods) any level gets. The count is random per level, not tied to difficulty (see `keyCountFor`). */
export const MAX_KEYS = 3;

/**
 * Keys a level should carry: uniform 0..MAX_KEYS from the level seed (its own stream, so it does not shift the
 * search), none below the easy cutoff. The search keeps this count fixed; the score adapts around it.
 */
export function keyCountFor(target: number, seed: number): number {
    if (target < EASY_CUTOFF) return 0;
    return new Rng(seed ^ 0x6b657973).int(0, MAX_KEYS);
}

/**
 * Most pairs / hidden share a level at `target` may carry. Keeps lanes/overflow (the core puzzle) the main source
 * of difficulty: pairs are strong trap generators and the search would otherwise pile them on. Keys are not capped
 * by difficulty (see `keyCountFor`).
 */
export function mechanicCaps(target: number): MechanicCaps {
    if (target < EASY_CUTOFF) return { hiddenShare: 0, pairs: 0 };
    if (target < 0.45) return { hiddenShare: 0.35, pairs: 1 };
    if (target < 0.8) return { hiddenShare: 0.45, pairs: 2 };
    return { hiddenShare: 0.5, pairs: 3 };
}

/**
 * Share of pods hidden in a finished level. Matches what the levels had before the difficulty rework (~0.22-0.27
 * above the easy cutoff): hidden pods are not part of the score, so they are dealt at the end at a fixed share.
 */
export function hiddenShareFor(target: number): number {
    if (target < EASY_CUTOFF) return 0;
    return Math.min(mechanicCaps(target).hiddenShare, 0.2 + 0.08 * target);
}

function clamp01(v: number): number {
    return Math.max(0, Math.min(1, v));
}

/** Gaussian-ish jitter (sum of uniforms), deterministic from `rng`. */
function jitter(rng: Rng, sd: number): number {
    return (rng.next() + rng.next() + rng.next() - 1.5) * sd * 2;
}

/** `keys` is the level's fixed key count (`keyCountFor`), not sampled per candidate. */
export function sampleKnobs(target: number, rng: Rng, keys = 0): Knobs {
    const caps = mechanicCaps(target);
    const t = clamp01(target + STRUCTURE_BOOST + jitter(rng, 0.12));
    let lanes: number;
    if (t < 0.3) lanes = rng.chance(0.5) ? 3 : 4;
    else if (t < 0.6) lanes = 3;
    else if (t < 0.8) lanes = rng.chance(0.5) ? 2 : 3;
    else lanes = rng.chance(0.7) ? 2 : 3;

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

    const hiddenShare = hiddenShareFor(target);
    let pairs = 0;
    if (t >= 0.35) pairs = Math.min(caps.pairs, t < 0.6 ? rng.int(0, 1) : t < 0.8 ? rng.int(1, 2) : rng.int(1, 3));
    return { lanes, columns, podsPerColor: [lo, hi], overflowRate, parkRate, maxStalled, deal, hiddenShare, keys, pairs };
}

export function knobsSummary(k: Knobs): string {
    return (
        `lanes ${k.lanes}, cols ${k.columns}, pods/color ${k.podsPerColor[0]}-${k.podsPerColor[1]}, ` +
        `overflow ${k.overflowRate.toFixed(2)}, park ${k.parkRate.toFixed(2)}, maxStalled ${k.maxStalled}, deal ${k.deal}, ` +
        `hidden ${k.hiddenShare.toFixed(2)}, keys ${k.keys}, pairs ${k.pairs}`
    );
}
