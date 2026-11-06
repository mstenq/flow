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
    /** Pushy pods to place (`pushyCountFor` for the candidate's lanes; `sampleKnobs` leaves it 0). */
    pushy: number;
    /** Absolute cap on pod capacity on top of the per-color caps (`--max-pod` / levels.json; undefined = none). */
    maxPod?: number;
    /** Fill-first lanes (`LevelData.fillFirst`): construction plans waves (see `FILL_FIRST_MAX_LANES`). */
    fillFirst?: boolean;
}

/** Below this target a level gets no mechanics at all. */
export const EASY_CUTOFF = 0.25;

/**
 * A pod holds at most this share of its color's cells (so every big color gets at least 1/share pods). A fixed cap
 * was wrong both ways: 1000 white cells became a pile of small pods, while a 100-cell outline could go in one pod.
 */
export const POD_SHARE = 0.25;

/** Per-color caps never go below this, so small colors don't turn into crumbs. */
export const MIN_POD_CAP = 10;

/**
 * Pacing ceiling for any pod: at the fastest tick (90ms, `MIN_TICK_MS`) 333 cells take 30s to drain
 * (`MAX_LONGEST_DRAIN_MS`). Only huge single colors reach it, like a background on a 64x64 board.
 */
export const MAX_POD_CELLS = 333;

/** Largest pod per color: `POD_SHARE` of its cells (at least `MIN_POD_CAP`), never above `maxPod`. */
export function podCaps(counts: readonly number[], maxPod = MAX_POD_CELLS): number[] {
    return counts.map((total) => Math.min(maxPod, Math.max(MIN_POD_CAP, Math.round(total * POD_SHARE))));
}

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

/**
 * Extra pressure for levels with few colors. A board with 3-4 colors offers few real choices, so a level that
 * scores on target still plays easy. Such levels get a key floor, more pairs and a higher search target.
 */
export interface FewColorBoost {
    /** Fewest keys the level gets. */
    minKeys: number;
    /** Fewest pairs every candidate starts with (also the floor the climb can't unpair below). */
    minPairs: number;
    /** Added to the pair cap from `mechanicCaps`, so the climb may add more. */
    extraPairs: number;
    /** Added to the search target. Hidden pods still follow the raw target. */
    target: number;
}

const NO_BOOST: FewColorBoost = { minKeys: 0, minPairs: 0, extraPairs: 0, target: 0 };

export function fewColorBoost(numColors: number, target: number): FewColorBoost {
    if (target < EASY_CUTOFF || numColors > 5) return NO_BOOST;
    if (numColors <= 3) return { minKeys: 2, minPairs: 2, extraPairs: 2, target: 0.12 };
    if (numColors === 4) return { minKeys: 1, minPairs: 1, extraPairs: 1, target: 0.08 };
    return { minKeys: 1, minPairs: 0, extraPairs: 0, target: 0.03 };
}

/** Most lanes the search may pick on its own (it cuts lanes to raise difficulty, so it rarely goes this high). */
export const MAX_SEARCH_LANES = 4;

/**
 * Fill-first lanes (`LevelData.fillFirst`): every eligible level whose search picks at most this many lanes drains in
 * waves. The climb never moves a plan across this boundary, so a level with 2-3 lanes is always fill-first and a
 * 4-lane level never is. Fixed-lane (wide, sealed: 4-5 lanes) levels never get it.
 */
export const FILL_FIRST_MAX_LANES = 3;

/**
 * The first levels in levels-src/levels.json order (Heart, Invader, Mushroom) are beginner levels and keep plain
 * lanes: fill-first is not something to meet before the basics.
 */
export const FILL_FIRST_EXEMPT_LEVELS = 3;

/** Whether the level at `index` in levels.json order (-1 = not listed) may get fill-first lanes (see `FILL_FIRST_EXEMPT_LEVELS`). */
export function fillFirstEligible(index: number): boolean {
    return index < 0 || index >= FILL_FIRST_EXEMPT_LEVELS;
}

/** Most lanes a wide level gets (see `wideLanesFor`). */
export const WIDE_LANES = 5;

/** Share of wide levels that get one lane fewer than `WIDE_LANES`, so 4-lane levels sit between narrow and 5-lane ones. */
export const FOUR_LANE_SHARE = 0.5;

/** Lane count of a wide level (sealed, or wide by `laneCountFor`): 4 or 5, from the level seed (its own stream). */
export function wideLanesFor(seed: number): number {
    return new Rng(seed ^ 0x77696465).chance(FOUR_LANE_SHARE) ? WIDE_LANES - 1 : WIDE_LANES;
}

/** Share of levels at or above the easy cutoff that are wide. */
export const WIDE_SHARE = 0.5;

/**
 * Fixed lane count for this level, or null to let the search pick (2-4). Wide levels keep `wideLanesFor` lanes for the
 * whole search, so their difficulty has to come from traps that more lanes don't fix (keys, pairs, buried colors).
 */
export function laneCountFor(target: number, seed: number): number | null {
    // Without keys and pairs nothing traps a player with 4-5 lanes, so easy levels stay narrow.
    if (target < EASY_CUTOFF) return null;
    return new Rng(seed ^ 0x6c616e65).chance(WIDE_SHARE) ? wideLanesFor(seed) : null;
}

/**
 * Chance that a level gets a generated outline ring (see `outline-ring.ts`): none below the easy cutoff, more at
 * harder targets, and much more on few-color art, which offers the fewest real choices.
 */
export function outlineChance(target: number, numColors: number): number {
    if (target < EASY_CUTOFF) return 0;
    const base = 0.7 + 0.25 * clamp01((target - EASY_CUTOFF) / (1 - EASY_CUTOFF));
    const few = numColors <= 5 ? 0.3 : 0;
    return Math.min(1, base + few);
}

/** Whether this level gets an outline ring, from the level seed (its own stream, so it does not shift the search). */
export function outlineFor(target: number, numColors: number, seed: number): boolean {
    return new Rng(seed ^ 0x72696e67).chance(outlineChance(target, numColors));
}

/** Chance that a level gets a generated background fill: half the outline chance, rolled on its own. */
export function backgroundChance(target: number, numColors: number): number {
    return outlineChance(target, numColors) / 2;
}

/** Whether this level gets a background fill, from the level seed (its own stream, independent of the outline). */
export function backgroundFor(target: number, numColors: number, seed: number): boolean {
    return new Rng(seed ^ 0x62676e64).chance(backgroundChance(target, numColors));
}

/**
 * While a seal (outline ring or background) still has cells nobody owns, construction parks a pod at least this
 * often. Parked pods sit at the front of the columns, so the seal's pods end up behind them: a player has to fill
 * lanes to dig them out.
 */
export const SEAL_PARK_RATE = 0.6;

/** Most keys (locked pods) any level gets. The count is random per level, not tied to difficulty (see `keyCountFor`). */
export const MAX_KEYS = 3;

/**
 * Keys a level should carry: uniform minKeys..MAX_KEYS from the level seed (its own stream, so it does not shift
 * the search), none below the easy cutoff. The search keeps this count fixed; the score adapts around it.
 */
export function keyCountFor(target: number, seed: number, boost: FewColorBoost = NO_BOOST): number {
    if (target < EASY_CUTOFF) return 0;
    return new Rng(seed ^ 0x6b657973).int(boost.minKeys, MAX_KEYS);
}

/** Most pushy pods any level gets (see `pushyCountFor`). */
export const MAX_PUSHY = 5;

/** Fewest lanes a level needs for pushy pods: with fewer, a pod that takes a lane by itself is too punishing. */
export const MIN_PUSHY_LANES = 4;

/**
 * Pushy pods a level should carry: uniform 0..MAX_PUSHY from the level seed (its own stream, so it does not shift
 * the search), none below the easy cutoff or below `MIN_PUSHY_LANES` lanes. The count is drawn regardless of the
 * lanes, so a level keeps the same count whatever lane count (≥ 4) it ends up with. The search keeps it fixed.
 */
export function pushyCountFor(target: number, seed: number, lanes: number): number {
    if (target < EASY_CUTOFF || lanes < MIN_PUSHY_LANES) return 0;
    return new Rng(seed ^ 0x70757368).int(0, MAX_PUSHY);
}

/**
 * Most pairs / hidden share a level at `target` may carry. Keeps lanes/overflow (the core puzzle) the main source
 * of difficulty: pairs are strong trap generators and the search would otherwise pile them on. Keys are not capped
 * by difficulty (see `keyCountFor`).
 */
export function mechanicCaps(target: number, boost: FewColorBoost = NO_BOOST): MechanicCaps {
    if (target < EASY_CUTOFF) return { hiddenShare: 0, pairs: 0 };
    if (target < 0.45) return { hiddenShare: 0.35, pairs: 1 + boost.extraPairs };
    if (target < 0.8) return { hiddenShare: 0.45, pairs: 2 + boost.extraPairs };
    return { hiddenShare: 0.5, pairs: 3 + boost.extraPairs };
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
/** `fixedLanes`: the level's lane count from `laneCountFor` (null = sample it from the target). */
export function sampleKnobs(target: number, rng: Rng, keys = 0, boost: FewColorBoost = NO_BOOST, fixedLanes: number | null = null): Knobs {
    const caps = mechanicCaps(target, boost);
    const t = clamp01(target + boost.target + STRUCTURE_BOOST + jitter(rng, 0.12));
    let lanes: number;
    if (t < 0.3) lanes = rng.chance(0.5) ? 3 : 4;
    else if (t < 0.6) lanes = 3;
    else if (t < 0.8) lanes = rng.chance(0.5) ? 2 : 3;
    else lanes = rng.chance(0.7) ? 2 : 3;
    if (fixedLanes !== null) lanes = fixedLanes;

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
    pairs = Math.min(caps.pairs, Math.max(pairs, boost.minPairs));
    return { lanes, columns, podsPerColor: [lo, hi], overflowRate, parkRate, maxStalled, deal, hiddenShare, keys, pairs, pushy: 0 };
}

export function knobsSummary(k: Knobs): string {
    return (
        `lanes ${k.lanes}, cols ${k.columns}, pods/color ${k.podsPerColor[0]}-${k.podsPerColor[1]}, ` +
        `overflow ${k.overflowRate.toFixed(2)}, park ${k.parkRate.toFixed(2)}, maxStalled ${k.maxStalled}, deal ${k.deal}, ` +
        `hidden ${k.hiddenShare.toFixed(2)}, keys ${k.keys}, pairs ${k.pairs}, pushy ${k.pushy}${k.fillFirst ? ', fill-first' : ''}`
    );
}
