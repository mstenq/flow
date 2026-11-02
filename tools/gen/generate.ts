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
import { keyCountFor, knobsSummary, mechanicCaps, sampleKnobs } from './knobs.ts';
import { construct } from './construct.ts';
import { addLock, applyMechanics, hideShare } from './mechanics.ts';
import type { Plan } from './plan.ts';
import { clonePlan, planFromLayout, toLayout } from './plan.ts';
import type { Measurement, MeasureOptions } from './difficulty.ts';
import { FULL_MEASURE, SCREEN_MEASURE, measure, roundStats } from './difficulty.ts';
import type { MutationRules } from './mutate.ts';
import { mutate } from './mutate.ts';
import { solveLevel } from './solver.ts';

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
    /** Safety-net time budget in ms (default 24000). Normal runs stop on count limits well before it, which keeps output deterministic. */
    budgetMs?: number;
    /** Cap on pod capacity during construction and mutation (default: none). */
    maxPod?: number;
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

/** Median pod drains in ~1.2s, clamped to 30–90ms per cell. */
export function chooseTickMs(layout: Layout): number {
    const caps = layout.columns.flat().map((p) => p.capacity).sort((a, b) => a - b);
    const median = caps[Math.floor(caps.length / 2)] ?? 20;
    return Math.max(30, Math.min(90, Math.round(1200 / median)));
}

/** Validate a mutated plan: replay first, else ask the solver (which may produce a new tap order). */
function validate(board: Board, plan: Plan, solverBudget: number): { plan: Plan; layout: Layout; resolved: boolean } | null {
    const layout = toLayout(plan);
    if (!layout) return null;
    const level = toLevel(board, layout, { id: 'v', name: 'v' });
    if (replay(level).won) return { plan, layout, resolved: false };
    const r = solveLevel(level, solverBudget);
    if (r.status !== 'solved') return null;
    const solved: Layout = { ...layout, solution: r.solution };
    const next = planFromLayout(solved);
    const relaid = toLayout(next);
    if (!relaid) return null;
    return { plan: next, layout: relaid, resolved: true };
}

/** A copy of `plan` with locks added (via `addLock`, which keeps it solvable) until it has `want` keys, or no lock fits. */
function topUpKeys(board: Board, plan: Plan, want: number, rng: Rng): Plan {
    const out = clonePlan(plan);
    for (let tries = 0; out.keys.length < want && tries < want * 3; tries++) addLock(board, out, rng);
    return out;
}

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
    const budgetMs = input.budgetMs ?? 24_000;
    const quick = input.quick ?? false;

    const maxColors = input.maxColors ?? maxColorsForDifficulty(target);
    const simplified = simplifyImage(input.image, { maxColors, minRegion: input.minRegion ?? DEFAULT_MIN_REGION });
    const board = boardFromCells(simplified.width, simplified.height, simplified.cells, simplified.palette);
    lap('simplify');

    const rng = new Rng(input.seed);
    const screen: MeasureOptions = { ...SCREEN_MEASURE, seed: input.seed, ...(quick ? { rollouts: 40, trapBudget: 0 } : {}) };
    const climbOpts: MeasureOptions = { ...CLIMB_MEASURE, seed: input.seed, ...(quick ? { rollouts: 60, trapBudget: 60 } : {}) };
    const full: MeasureOptions = { ...FULL_MEASURE, seed: input.seed, ...(quick ? { rollouts: 80, trapBudget: 120, laneBudget: 2000, fastRollouts: 60 } : {}) };

    // 1. Candidates (up to 3x as many while none of them can be lost).
    const maxCandidates = input.candidates ?? 40;
    const wantKeys = keyCountFor(target, input.seed);
    const pool: Candidate[] = [];
    for (let i = 0; i < maxCandidates * 3; i++) {
        if (i >= maxCandidates && pool.some((c) => isLosable(c.m.stats))) break;
        const r = rng.fork();
        const knobs = sampleKnobs(target, r, wantKeys);
        if (input.maxPod !== undefined) knobs.maxPod = input.maxPod;
        const built = construct(board, knobs, r);
        // Hidden pods are dealt after the search (see step 4): they don't change the score.
        const placed = applyMechanics(board, planFromLayout(built.layout), { ...knobs, hiddenShare: 0 }, r);
        const layout = toLayout(placed.plan);
        lap('construct');
        if (!layout) continue;
        const level = toLevel(board, layout, { id: input.id, name: input.name });
        if (!replay(level).won) throw new Error('internal: constructed level does not replay to a win');
        const m = measure(level, screen);
        lap('screen');
        pool.push({ plan: placed.plan, layout, knobs, m, note: `cand ${i}` });
        const best = Math.min(...pool.map((c) => distance(c.m, target, c.layout.lanes)));
        if (i >= 11 && best < 0.03) break;
        if (elapsed() > budgetMs * 0.35) {
            log.push(`WARNING: time budget ended screening after ${i + 1} candidates (output may differ on other machines)`);
            break;
        }
    }
    pool.sort((a, b) => distance(a.m, target, a.layout.lanes) - distance(b.m, target, b.layout.lanes));
    log.push(`screened ${pool.length} candidates, best screen score ${pool[0].m.score.toFixed(3)} (${knobsSummary(pool[0].knobs)})`);

    // 2. Finalists get the climb-grade measure.
    const finalists = pool.slice(0, quick ? 2 : 4).map((c) => {
        const m = measure(toLevel(board, c.layout, { id: input.id, name: input.name }), climbOpts);
        return { ...c, m };
    });
    finalists.sort((a, b) => distance(a.m, target, a.layout.lanes) - distance(b.m, target, b.layout.lanes));
    let best = finalists[0];
    lap('finalists');
    log.push(`finalists: ${finalists.map((f) => f.m.score.toFixed(3)).join(', ')}`);

    // 3. Hill-climb.
    const caps = mechanicCaps(target);
    const rules: MutationRules = {
        // Hidden pods stay as the knobs placed them: they are not part of the score, so the climb leaves them alone.
        hidden: false,
        // The key count is fixed per level (`keyCountFor`): the climb neither adds nor removes keys.
        locks: false,
        pairs: caps.pairs > 0,
        maxHiddenShare: caps.hiddenShare,
        maxLocks: wantKeys,
        maxPairs: caps.pairs,
        minLanes: 2,
        maxLanes: 4,
        maxPod: input.maxPod,
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
        if (distance(best.m, target, best.layout.lanes) < 0.015) break;
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
            if (distance(base.m, target, base.layout.lanes) < distance(best.m, target, best.layout.lanes)) best = base;
            sinceGain = 0;
            restarts++;
        }
        const direction = base.m.score < target ? 1 : -1;
        // Far from the target: compound a few mutations before paying for validation + measurement.
        const far = distance(base.m, target, base.layout.lanes) > 0.08;
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
        const ok = validate(board, plan, quick ? 3000 : 20_000);
        if (!ok) continue;
        const m = measure(toLevel(board, ok.layout, { id: input.id, name: input.name }), climbOpts);
        if (distance(m, target, ok.layout.lanes) >= distance(base.m, target, base.layout.lanes)) continue;
        base = { plan: ok.plan, layout: ok.layout, knobs: base.knobs, m, note: `${base.note} +${kinds.join('+')}${ok.resolved ? '(re-solved)' : ''}` };
        sinceGain = 0;
        accepted++;
        if (distance(base.m, target, base.layout.lanes) < distance(best.m, target, best.layout.lanes)) best = base;
    }
    lap('climb');
    log.push(`hill-climb: ${tried} tries, ${accepted} accepted, ${restarts} restart(s) → ${best.note}`);

    // 4. Top up keys a placement or the rescue climb dropped, hide a fixed share of pods, then the final measure and output.
    const keyed = topUpKeys(board, best.plan, wantKeys, rng.fork());
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
        targetDifficulty: Math.round(target * 1000) / 1000,
        difficulty: Math.round(finalM.score * 1000) / 1000,
        stats,
        sourceHash: input.sourceHash ?? '',
    });
    if (!replay(level).won) throw new Error('internal: final level does not replay to a win');
    const trace = traceSolution(level, true);
    lap('trace');
    timings.total = performance.now() - t0;
    log.push(`pods ${podCount(best.layout)}, final score ${finalM.score.toFixed(3)} (target ${target.toFixed(2)})`);
    return { level, board, simplified, trace, knobs: best.knobs, timings, log, stats };
}
