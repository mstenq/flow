/**
 * PNG → level search loop (plan/02-generator.md §7).
 *
 *   simplify → N candidates (knobs around target → construct → mechanics → cheap screen measure)
 *   → full measure of the best few → hill-climb with mid-cost measures → final full measure.
 *
 * Deterministic for a given (image, params, seed). Time-boxed so a 48×48 board stays under ~20s.
 */
import type { DifficultyStats, LevelData } from '@game/types';
import { Rng } from '@game/rng';
import type { RgbaImage } from './png.ts';
import type { SimplifiedImage } from './palette.ts';
import { DEFAULT_MIN_REGION, maxColorsForDifficulty, simplifyImage } from './palette.ts';
import type { Board, Layout, Trace } from './board.ts';
import { boardFromCells, podCount, replay, toLevel, traceSolution } from './board.ts';
import type { Knobs } from './knobs.ts';
import {
    MAX_SEARCH_LANES,
    WIDE_LANES,
    backgroundFor,
    fewColorBoost,
    keyCountFor,
    knobsSummary,
    laneCountFor,
    mechanicCaps,
    outlineFor,
    podCaps,
    pushyCountFor,
    sampleKnobs,
} from './knobs.ts';
import { addBackground, addOutlineRing } from './outline-ring.ts';
import { construct } from './construct.ts';
import { PUSHY_SOLVER_BUDGET, addLock, addPushy, applyMechanics, hideShare, validatePlan } from './mechanics.ts';
import type { Plan } from './plan.ts';
import { clonePlan, planFromLayout, pushyCount, toLayout } from './plan.ts';
import type { Measurement, MeasureOptions } from './difficulty.ts';
import { FULL_MEASURE, SCREEN_MEASURE, measure, roundStats } from './difficulty.ts';
import type { MutationRules } from './mutate.ts';
import { mutate } from './mutate.ts';

export interface GenerateInput {
    image: RgbaImage;
    id: string;
    name: string;
    difficulty: number;
    seed: number;
    maxColors?: number;
    minRegion?: number;
    sourceHash?: string;
    /** Max candidates (default 40). */
    candidates?: number;
    /** Hill-climb iterations (default 15). */
    climb?: number;
    /** Safety-net time budget in ms (default 30000). Normal runs stop on count limits well before it, which keeps output deterministic. */
    budgetMs?: number;
    /** Absolute cap on pod capacity, on top of the per-color caps (`podCaps`). */
    maxPod?: number;
    /** Force an outline ring on or off. Default: `outlineFor` (random per level seed). */
    outline?: boolean;
    /** Force a background fill on or off. Default: `backgroundFor` (random per level seed, independent of the ring). */
    background?: boolean;
    /** Force this lane count (the climb keeps it). Default: wide for sealed levels and `laneCountFor`, else picked by the search. */
    lanes?: number;
    /** Lighter measures everywhere (tests). */
    quick?: boolean;
}

export interface Candidate {
    plan: Plan;
    layout: Layout;
    knobs: Knobs;
    m: Measurement;
    note: string;
}

export interface GenerateResult {
    level: LevelData;
    board: Board;
    simplified: SimplifiedImage;
    trace: Trace;
    knobs: Knobs;
    timings: Record<string, number>;
    log: string[];
    stats: DifficultyStats;
}

const CLIMB_MEASURE: Omit<MeasureOptions, 'seed'> = { rollouts: 300, trapBudget: 300, laneBudget: 0 };

/** Overflow pods we'd like a level at `target` to have: lane management is the core of every level. */
export function wantedOverflow(target: number): number {
    return Math.round(1 + target * 7);
}

/** Every level must be losable: a sensible player (see `smartWinRate`) has to lose at least this share of tries. */
export const MIN_SMART_LOSS = 0.05;

export function isLosable(stats: DifficultyStats): boolean {
    return 1 - stats.smartWinRate >= MIN_SMART_LOSS;
}

/**
 * Search objective (lower is better): distance to the target score, plus penalties when the level can't be lost
 * by a sensible player (dominates everything else; graded by the greedy win rate so the search heads toward
 * layouts with traps), or gets its difficulty without lane management: too few overflow pods, or more lanes than
 * the solution ever needs (+1 spare), which means the lanes are not what makes it hard.
 */
function distance(m: Measurement, target: number, lanes: number): number {
    const missing = Math.max(0, wantedOverflow(target) - (m.stats.overflowPods ?? 0));
    const needed = (m.stats.peakStalled ?? 0) + 1 + (m.stats.pairCount > 0 ? 1 : 0);
    const slack = Math.max(0, lanes - needed - (target < 0.3 ? 1 : 0));
    const unlosable = isLosable(m.stats) ? 0 : 0.3 + (MIN_SMART_LOSS - (1 - m.stats.smartWinRate)) + 0.1 * m.stats.greedyWinRate;
    return Math.abs(m.score - target) + 0.015 * missing + 0.03 * slack + unlosable;
}

/** How long the median pod takes to drain at 1x. Slow on purpose: waiting tempts players to tap ahead (playtested). */
export const MEDIAN_DRAIN_MS = 3600;
export const MIN_TICK_MS = 90;
export const MAX_TICK_MS = 270;

/** No pod should take longer than this to drain at 1x (per-color caps allow big pods next to many small ones). */
export const MAX_LONGEST_DRAIN_MS = 30_000;

/** Median pod drains in `MEDIAN_DRAIN_MS`, but the largest in at most `MAX_LONGEST_DRAIN_MS`; clamped to `MIN_TICK_MS`–`MAX_TICK_MS` per cell. */
export function chooseTickMs(layout: Layout): number {
    const caps = layout.columns.flat().map((p) => p.capacity).sort((a, b) => a - b);
    const median = caps[Math.floor(caps.length / 2)] ?? 20;
    const largest = caps[caps.length - 1] ?? 20;
    const tick = Math.min(MEDIAN_DRAIN_MS / median, MAX_LONGEST_DRAIN_MS / largest);
    return Math.max(MIN_TICK_MS, Math.min(MAX_TICK_MS, Math.round(tick)));
}

/** One mechanic the end of the search tops up to a fixed count (keys, pushy pods). */
interface TopUp {
    want: number;
    have: (plan: Plan) => number;
    /** Add one (in place, keeps the plan winning). False if nothing fits. */
    add: (plan: Plan, rng: Rng) => boolean;
    /** Each one the level ends up short of costs this much in `bestTopUp`. */
    missingCost: number;
    /** Placements measured. */
    tries: number;
}

/** A copy of `plan` with `spec.add` applied until it has `spec.want`, or nothing more fits. */
function topUpPlan(plan: Plan, spec: TopUp, rng: Rng): Plan {
    const out = clonePlan(plan);
    for (let tries = 0; spec.have(out) < spec.want && tries < spec.want * 3; tries++) spec.add(out, rng);
    return out;
}

interface Scored {
    plan: Plan;
    layout: Layout;
    m: Measurement;
}

/**
 * The climbed plan with a mechanic topped up to `spec.want`. A late lock or pushy pod can strip every losing move
 * (small boards end up with one forced order), so a few placements are measured and the one nearest the target
 * wins. The plan without the extras stays an option, so a level is never made unlosable just to reach the count.
 */
function bestTopUp(best: Scored, spec: TopUp, target: number, rng: Rng, measureLayout: (layout: Layout) => Measurement): Scored {
    const have = spec.have(best.plan);
    if (have >= spec.want) return best;
    const cost = (s: Scored) => distance(s.m, target, s.layout.lanes) + spec.missingCost * (spec.want - spec.have(s.plan));
    let pick = best;
    let pickCost = cost(best);
    for (let k = 0; k < spec.tries; k++) {
        const plan = topUpPlan(best.plan, spec, rng);
        if (spec.have(plan) === have) continue;
        const layout = toLayout(plan);
        if (!layout) continue;
        const next = { plan, layout, m: measureLayout(layout) };
        const c = cost(next);
        if (c >= pickCost) continue;
        pick = next;
        pickCost = c;
    }
    return pick;
}

/** Each key a level ends up short of costs this much in `bestTopUp`. */
const MISSING_KEY_COST = 0.05;

/** Each pushy pod a level ends up short of costs this much in `bestTopUp`. */
const MISSING_PUSHY_COST = 0.03;

export function generateLevel(input: GenerateInput): GenerateResult {
    const t0 = performance.now();
    const timings: Record<string, number> = {};
    const log: string[] = [];
    let mark = t0;
    const lap = (name: string) => {
        const now = performance.now();
        timings[name] = (timings[name] ?? 0) + (now - mark);
        mark = now;
    };
    const elapsed = () => performance.now() - t0;
    const target = Math.max(0, Math.min(1, input.difficulty));
    const budgetMs = input.budgetMs ?? 30_000;
    const quick = input.quick ?? false;

    const maxColors = input.maxColors ?? maxColorsForDifficulty(target);
    const art = simplifyImage(input.image, { maxColors, minRegion: input.minRegion ?? DEFAULT_MIN_REGION });
    // Some levels get seals in new colors around the picture: an outline ring, a background fill, or both (see outline-ring.ts).
    const seals: number[] = [];
    let simplified = art;
    const addSeal = (want: boolean, name: string, add: (img: SimplifiedImage, rng: Rng) => SimplifiedImage | null, salt: number) => {
        if (!want) return;
        const sealed = add(simplified, new Rng(input.seed ^ salt));
        if (!sealed) {
            log.push(`${name} skipped: no free neon or no room`);
            return;
        }
        seals.push(simplified.palette.length);
        simplified = sealed;
        log.push(sealed.log[sealed.log.length - 1]);
    };
    addSeal(input.outline ?? outlineFor(target, art.palette.length, input.seed), 'outline ring', addOutlineRing, 0x6e656f6e);
    addSeal(input.background ?? backgroundFor(target, art.palette.length, input.seed), 'background', addBackground, 0x6e656f6f);
    const board = boardFromCells(simplified.width, simplified.height, simplified.cells, simplified.palette);
    if (seals.length > 0) board.seals = seals;
    lap('simplify');

    // Few colors means few real choices: search above the target and force keys and pairs (see `fewColorBoost`).
    // Counted on the art: seals are pressure of their own, not a reason to drop the boost.
    const boost = fewColorBoost(art.palette.length, target);
    const searchTarget = Math.min(1, target + boost.target);
    const maxPod = input.maxPod;
    const sizeCaps = podCaps(board.counts, maxPod);
    if (boost.target > 0) log.push(`few colors (${art.palette.length}): search target ${searchTarget.toFixed(2)}, ≥${boost.minKeys} key(s), ≥${boost.minPairs} pair(s)`);

    const rng = new Rng(input.seed);
    const screen: MeasureOptions = { ...SCREEN_MEASURE, seed: input.seed, ...(quick ? { rollouts: 40, trapBudget: 0 } : {}) };
    const climbOpts: MeasureOptions = { ...CLIMB_MEASURE, seed: input.seed, ...(quick ? { rollouts: 60, trapBudget: 60 } : {}) };
    const full: MeasureOptions = { ...FULL_MEASURE, seed: input.seed, ...(quick ? { rollouts: 80, trapBudget: 120, laneBudget: 2000, fastRollouts: 60 } : {}) };

    // 1. Candidates (up to 3x as many while none of them can be lost).
    const maxCandidates = input.candidates ?? 40;
    const wantKeys = keyCountFor(target, input.seed, boost);
    // Wide levels have a fixed lane count: the search finds traps that hold with that many lanes instead of cutting lanes.
    // A seal traps through parked pods, which needs spare lanes: sealed levels are always wide.
    const fixedLanes = input.lanes ?? (seals.length > 0 ? WIDE_LANES : laneCountFor(target, input.seed));
    if (fixedLanes !== null) log.push(`lanes fixed at ${fixedLanes}`);
    const pool: Candidate[] = [];
    for (let i = 0; i < maxCandidates * 3; i++) {
        if (i >= maxCandidates && pool.some((c) => isLosable(c.m.stats))) break;
        const r = rng.fork();
        const sampled = sampleKnobs(target, r, wantKeys, boost, fixedLanes);
        // Pushy pods only on candidates with enough lanes (the count itself is per level, see `pushyCountFor`).
        const knobs = { ...sampled, pushy: pushyCountFor(target, input.seed, sampled.lanes), maxPod };
        const built = construct(board, knobs, r);
        // Hidden pods are dealt after the search (see step 4): they don't change the score.
        const placed = applyMechanics(board, planFromLayout(board, built.layout), { ...knobs, hiddenShare: 0 }, r);
        const layout = toLayout(placed.plan);
        lap('construct');
        if (!layout) continue;
        const level = toLevel(board, layout, { id: input.id, name: input.name });
        if (!replay(level).won) throw new Error('internal: constructed level does not replay to a win');
        const m = measure(level, screen);
        lap('screen');
        pool.push({ plan: placed.plan, layout, knobs, m, note: `cand ${i}` });
        const best = Math.min(...pool.map((c) => distance(c.m, searchTarget, c.layout.lanes)));
        if (i >= 11 && best < 0.03) break;
        if (elapsed() > budgetMs * 0.35) {
            log.push(`WARNING: time budget ended screening after ${i + 1} candidates (output may differ on other machines)`);
            break;
        }
    }
    pool.sort((a, b) => distance(a.m, searchTarget, a.layout.lanes) - distance(b.m, searchTarget, b.layout.lanes));
    log.push(`screened ${pool.length} candidates, best screen score ${pool[0].m.score.toFixed(3)} (${knobsSummary(pool[0].knobs)})`);

    // 2. Finalists get the climb-grade measure.
    const finalists = pool.slice(0, quick ? 2 : 4).map((c) => {
        const m = measure(toLevel(board, c.layout, { id: input.id, name: input.name }), climbOpts);
        return { ...c, m };
    });
    finalists.sort((a, b) => distance(a.m, searchTarget, a.layout.lanes) - distance(b.m, searchTarget, b.layout.lanes));
    let best = finalists[0];
    lap('finalists');
    log.push(`finalists: ${finalists.map((f) => f.m.score.toFixed(3)).join(', ')}`);

    // 3. Hill-climb.
    const caps = mechanicCaps(target, boost);
    const rules: MutationRules = {
        // Hidden pods stay as the knobs placed them: they are not part of the score, so the climb leaves them alone.
        hidden: false,
        // The key count is fixed per level (`keyCountFor`): the climb neither adds nor removes keys.
        locks: false,
        pairs: caps.pairs > 0,
        // The pushy count is fixed per level too: the climb only moves the flag between pods.
        pushy: pushyCountFor(target, input.seed, MAX_SEARCH_LANES) > 0,
        maxHiddenShare: caps.hiddenShare,
        maxLocks: wantKeys,
        minPairs: boost.minPairs,
        maxPairs: caps.pairs,
        minLanes: fixedLanes ?? 2,
        maxLanes: fixedLanes ?? MAX_SEARCH_LANES,
        podCaps: sizeCaps,
    };
    // Deterministic work limit (count, not time) scaled to board size: measures cost roughly ∝ cells.
    const cells = board.counts.reduce((a, b) => a + b, 0);
    const iterations = input.climb ?? (cells <= 400 ? 120 : cells <= 1000 ? 60 : 40);
    const stagnationLimit = 25;
    let accepted = 0;
    let tried = 0;
    let restarts = 0;
    let base = best;
    let sinceGain = 0;
    let finalistIdx = 0;
    let poolIdx = finalists.length;
    // A level nobody can lose gets up to 4x the tries (cheap on the small boards where this happens), and once it
    // becomes losable late, another half budget to get back near the target.
    let losableAt = isLosable(best.m.stats) ? 0 : -1;
    const triesFor = () => (losableAt < 0 ? iterations * 4 : Math.max(iterations, losableAt + Math.round(iterations / 2)));
    for (let it = 0; it < iterations * 12 && tried < triesFor(); it++) {
        if (losableAt < 0 && isLosable(best.m.stats)) losableAt = tried;
        // Simple images (a color either fully exposed or fully buried) rarely trap anyone with lanes alone: past the
        // first 2x tries, allow one lock and one more pair than the target's caps.
        if (losableAt < 0 && tried >= iterations * 2 && !rules.rescue) {
            Object.assign(rules, { rescue: true, locks: true, pairs: true, maxLocks: Math.max(1, wantKeys), maxPairs: caps.pairs + 1 });
        }
        // An unlosable level may run over the usual budget: finding a trap matters more than generation time.
        if (elapsed() > budgetMs * (losableAt < 0 ? 2 : 0.8)) {
            log.push(`WARNING: time budget ended the hill-climb after ${tried} tries (output may differ on other machines)`);
            break;
        }
        if (distance(best.m, searchTarget, best.layout.lanes) < 0.015) break;
        // Stuck: continue from the next finalist (the global best is kept).
        if (sinceGain >= stagnationLimit && finalistIdx + 1 < finalists.length) {
            finalistIdx++;
            base = finalists[finalistIdx];
            sinceGain = 0;
            restarts++;
        } else if (sinceGain >= stagnationLimit && !isLosable(best.m.stats) && poolIdx < pool.length) {
            // Still nothing losable: try more of the screened candidates as starting points.
            const c = pool[poolIdx++];
            base = { ...c, m: measure(toLevel(board, c.layout, { id: input.id, name: input.name }), climbOpts) };
            if (distance(base.m, searchTarget, base.layout.lanes) < distance(best.m, searchTarget, best.layout.lanes)) best = base;
            sinceGain = 0;
            restarts++;
        }
        const direction = base.m.score < searchTarget ? 1 : -1;
        // Far from the target: compound a few mutations before paying for validation + measurement.
        const far = distance(base.m, searchTarget, base.layout.lanes) > 0.08;
        const steps = far ? 1 + rng.below(3) : 1;
        let plan = base.plan;
        const kinds: string[] = [];
        for (let k = 0; k < steps; k++) {
            const mut = mutate(board, plan, rng, direction, rules);
            if (!mut) continue;
            plan = mut.plan;
            kinds.push(mut.kind);
        }
        if (kinds.length === 0) continue;
        tried++;
        sinceGain++;
        const ok = validatePlan(board, plan, quick ? 3000 : 20_000);
        if (!ok) continue;
        const m = measure(toLevel(board, ok.layout, { id: input.id, name: input.name }), climbOpts);
        if (distance(m, searchTarget, ok.layout.lanes) >= distance(base.m, searchTarget, base.layout.lanes)) continue;
        base = { plan: ok.plan, layout: ok.layout, knobs: base.knobs, m, note: `${base.note} +${kinds.join('+')}${ok.resolved ? '(re-solved)' : ''}` };
        sinceGain = 0;
        accepted++;
        if (distance(base.m, searchTarget, base.layout.lanes) < distance(best.m, searchTarget, best.layout.lanes)) best = base;
    }
    lap('climb');
    log.push(`hill-climb: ${tried} tries, ${accepted} accepted, ${restarts} restart(s) → ${best.note}`);

    // 4. Top up pushy pods and keys that placement or the climb dropped (pushy first: it may change the tap order,
    // keys read the final drain order), hide a fixed share of pods, then the final measure and output.
    const measureClimb = (layout: Layout) => measure(toLevel(board, layout, { id: input.id, name: input.name }), climbOpts);
    // A non-fixed level that climbed to 4 lanes gets its pushy pods only here.
    const wantPushy = pushyCountFor(target, input.seed, best.layout.lanes);
    const pushySpec: TopUp = {
        want: wantPushy,
        have: pushyCount,
        add: (plan, r) => addPushy(board, plan, r, quick ? 500 : PUSHY_SOLVER_BUDGET),
        missingCost: MISSING_PUSHY_COST,
        tries: 4,
    };
    const pushed = bestTopUp(best, pushySpec, searchTarget, rng.fork(), measureClimb);
    if (pushyCount(pushed.plan) < wantPushy) log.push(`pushy: placed ${pushyCount(pushed.plan)} of ${wantPushy}`);
    const keySpec: TopUp = { want: wantKeys, have: (p) => p.keys.length, add: (plan, r) => addLock(board, plan, r), missingCost: MISSING_KEY_COST, tries: 6 };
    const keyed = bestTopUp(pushed, keySpec, searchTarget, rng.fork(), measureClimb).plan;
    if (keyed.keys.length < wantKeys) log.push(`keys: placed ${keyed.keys.length} of ${wantKeys}`);
    const hidden = toLayout(hideShare(keyed, best.knobs.hiddenShare, rng.fork()));
    if (!hidden) throw new Error('internal: hiding pods broke the layout');
    best = { ...best, layout: hidden };
    const tickMs = chooseTickMs(best.layout);
    const draft = toLevel(board, best.layout, { id: input.id, name: input.name, tickMs });
    const finalM = measure(draft, full);
    lap('final');
    const stats = roundStats(finalM.stats);
    const level = toLevel(board, best.layout, {
        id: input.id,
        name: input.name,
        tickMs,
        seed: input.seed,
        targetDifficulty: Math.round(searchTarget * 1000) / 1000,
        difficulty: Math.round(finalM.score * 1000) / 1000,
        stats,
        sourceHash: input.sourceHash ?? '',
    });
    if (!replay(level).won) throw new Error('internal: final level does not replay to a win');
    const trace = traceSolution(level, true);
    lap('trace');
    timings.total = performance.now() - t0;
    log.push(`pods ${podCount(best.layout)}, final score ${finalM.score.toFixed(3)} (target ${searchTarget.toFixed(2)})`);
    return { level, board, simplified, trace, knobs: best.knobs, timings, log, stats };
}
