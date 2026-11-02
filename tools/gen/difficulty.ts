/**
 * Difficulty measurement (plan/02-generator.md §5).
 *
 * - randomWinRate  share of rollouts won by a player tapping uniformly among legal taps (settled play).
 * - greedyWinRate  share won by a "reasonable" player: prefers taps whose color has something reachable
 *                  (for a pair: either color), random among those, else random. Exact counting of reachable
 *                  cells vs capacity is not assumed (a human can't do that at a glance on a 48×48 board).
 * - smartWinRate   share won by a sensible player (closest to how people actually play): pods that fill
 *                  completely right now first, then pods with something reachable, then the rest; random within
 *                  a tier. This is what the score leans on: a level this player can't lose has no real traps.
 * - deadEndRatio   trap density along the solution: at each step, the share of legal taps whose resulting state
 *                  is proven dead (budgeted solver; states it can't decide are left out). Budget-aware: steps
 *                  where nothing could be decided don't count.
 * - minLanes       smallest lane count proven solvable (stops at the first lane count that is unsolvable or
 *                  undecided within the budget; `minLanesProven` says which).
 * - fastGreedy/fastRandom  diagnostics only (not in the score): rollouts of a real-time player who taps whenever a
 *                  legal tap exists instead of waiting for settle. See `isFastPlayTrap`.
 * - branching      average legal taps per solution step.
 */
import type { DifficultyStats, LevelData } from '@game/types';
import type { CompiledLevel } from '@game/level';
import { compileLevel } from '@game/level';
import { Sim } from '@game/sim';
import { Rng } from '@game/rng';
import { Solver, tapScore } from './solver.ts';
import { traceSolution } from './board.ts';

export interface MeasureOptions {
    rollouts: number;
    /** Node budget per trap classification (0 = skip deadEndRatio). */
    trapBudget: number;
    /** Node budget per lane count for minLanes (0 = skip, minLanes = lanes). */
    laneBudget: number;
    /** Real-time rollouts for the fast-play diagnostics (0 or undefined = skip). */
    fastRollouts?: number;
    /** Seed for rollouts (common random numbers keep comparisons between candidates fair). */
    seed: number;
}

export const SCREEN_MEASURE: Omit<MeasureOptions, 'seed'> = { rollouts: 80, trapBudget: 150, laneBudget: 0 };
export const FULL_MEASURE: Omit<MeasureOptions, 'seed'> = { rollouts: 300, trapBudget: 1500, laneBudget: 25_000, fastRollouts: 200 };

export interface Measurement {
    stats: DifficultyStats;
    score: number;
    ms: number;
}

type Policy = 'random' | 'greedy' | 'smart';

/**
 * Policy choice among legal taps, random within the best tier. Greedy: anything reachable beats nothing reachable.
 * Smart: fills completely now, then something reachable, then nothing reachable (`tapScore` tiers).
 */
function pickTap(sim: Sim, legal: number[], policy: Policy, rng: Rng): number {
    if (policy === 'random' || legal.length === 1) return legal[rng.below(legal.length)];
    let best = 3;
    let options: number[] = [];
    for (const c of legal) {
        const raw = tapScore(sim, c).tier;
        const tier = policy === 'smart' ? raw : raw === 2 ? 1 : 0;
        if (tier < best) {
            best = tier;
            options = [c];
        } else if (tier === best) {
            options.push(c);
        }
    }
    return options[rng.below(options.length)];
}

function rollout(base: Sim, policy: Policy, rng: Rng): boolean {
    const sim = base.clone();
    for (;;) {
        const legal = sim.legalTaps();
        if (legal.length === 0) return sim.isWon();
        sim.tap(pickTap(sim, legal, policy, rng));
        sim.settle();
    }
}

/**
 * One real-time rollout: every tick the player may tap one legal pod (no waiting for the board to settle),
 * then the sim ticks once. Ends when a tick neither taps nor claims anything (nothing can change any more) or
 * the tick cap is hit; only a cleared board counts as a win.
 */
function fastRollout(base: Sim, policy: Policy, rng: Rng, maxTicks: number): boolean {
    const sim = base.clone();
    for (let t = 0; t < maxTicks; t++) {
        const legal = sim.legalTaps();
        const tapped = legal.length > 0;
        if (tapped) sim.tap(pickTap(sim, legal, policy, rng));
        const before = sim.cellsRemaining;
        sim.tick();
        if (sim.isWon()) return true;
        if (!tapped && sim.cellsRemaining === before) return false;
    }
    return sim.isWon();
}

/** Win rate of the tap-whenever-possible player (see `fastRollout`). Fixed seed, deterministic. */
export function fastWinRate(compiled: CompiledLevel, policy: Policy, rollouts: number, seed: number): number {
    const base = Sim.fromCompiled(compiled, { events: false });
    base.settle();
    const rng = new Rng(seed ^ (policy === 'random' ? 0x46414e44 : 0x46475245));
    const maxTicks = 4 * compiled.n + 200;
    let wins = 0;
    for (let i = 0; i < rollouts; i++) if (fastRollout(base, policy, rng, maxTicks)) wins++;
    return wins / rollouts;
}

/** Median pod capacity convention shared with `chooseTickMs`: the upper middle element. */
export function podCapacityStats(level: LevelData): { max: number; median: number; longestDrainSec: number } {
    const caps = level.columns.flat().map((p) => p.capacity).sort((a, b) => a - b);
    const max = caps[caps.length - 1] ?? 0;
    return { max, median: caps[Math.floor(caps.length / 2)] ?? 0, longestDrainSec: (max * level.tickMs) / 1000 };
}

/** Settled greedy play wins at least half the time, but real-time greedy play wins under half as often. */
export function isFastPlayTrap(stats: DifficultyStats): boolean {
    if (stats.fastGreedyWinRate === undefined) return false;
    return stats.greedyWinRate >= 0.5 && stats.fastGreedyWinRate < 0.5 * stats.greedyWinRate;
}

const POLICY_SALT: Record<Policy, number> = { random: 0x52414e44, greedy: 0x47524545, smart: 0x534d5254 };

export function winRate(compiled: CompiledLevel, policy: Policy, rollouts: number, seed: number): number {
    const base = Sim.fromCompiled(compiled, { events: false });
    base.settle();
    const rng = new Rng(seed ^ POLICY_SALT[policy]);
    let wins = 0;
    for (let i = 0; i < rollouts; i++) if (rollout(base, policy, rng)) wins++;
    return wins / rollouts;
}

/** Trap density along the stored solution (see file header). */
export function deadEndRatio(compiled: CompiledLevel, solution: number[], budget: number): number {
    const solver = new Solver(compiled);
    let sim = solver.start();
    let sum = 0;
    let steps = 0;
    for (const move of solution) {
        const legal = sim.legalTaps();
        if (legal.length > 1) {
            let dead = 0;
            let decided = 0;
            for (const col of legal) {
                const child = sim.clone();
                child.tap(col);
                child.settle();
                const status = col === move ? 'solved' : solver.classify(child, budget);
                if (status === 'unknown') continue;
                decided++;
                if (status === 'unsolvable') dead++;
            }
            if (decided > 1) {
                sum += dead / decided;
                steps++;
            }
        }
        sim.tap(move);
        sim.settle();
    }
    return steps === 0 ? 0 : sum / steps;
}

/** Smallest lane count proven solvable, scanning down from `level.lanes - 1`. */
export function minLanes(level: LevelData, budget: number): { lanes: number; proven: boolean } {
    const hasLink = level.columns.some((col) => col.some((p) => p.link !== undefined));
    const floor = hasLink ? 2 : 1;
    let best = level.lanes;
    for (let lanes = level.lanes - 1; lanes >= floor; lanes--) {
        const solver = new Solver({ ...level, lanes });
        const r = solver.solve(solver.start(), budget);
        if (r.status === 'solved') {
            best = lanes;
            continue;
        }
        return { lanes: best, proven: r.status === 'unsolvable' };
    }
    return { lanes: best, proven: true };
}

/**
 * Score in 0..1, driven by how often sensible players lose (a uniformly random tapper loses almost anything, so it
 * only counts a little). Hidden pods are deliberately left out: they make planning harder for a person but don't
 * change any policy's odds, and leaving them out keeps the search from piling them on.
 *   0.55·(1-smart) + 0.25·(1-greedy) + 0.10·(1-random) + 0.10·deadEndRatio
 * Rough guide: 0.15 ≈ smart wins 90%+, 0.5 ≈ 55%, 0.8 ≈ 20%.
 */
export function difficultyScore(stats: DifficultyStats): number {
    const raw = 0.55 * (1 - stats.smartWinRate) + 0.25 * (1 - stats.greedyWinRate) + 0.1 * (1 - stats.randomWinRate) + 0.1 * stats.deadEndRatio;
    return Math.max(0, Math.min(1, raw));
}

export function measure(level: LevelData, opts: MeasureOptions): Measurement {
    const t0 = performance.now();
    const compiled = compileLevel(level);
    const trace = traceSolution(level, false);
    const pods = level.columns.flat();
    const stats: DifficultyStats = {
        randomWinRate: winRate(compiled, 'random', opts.rollouts, opts.seed),
        greedyWinRate: winRate(compiled, 'greedy', opts.rollouts, opts.seed),
        smartWinRate: winRate(compiled, 'smart', opts.rollouts, opts.seed),
        deadEndRatio: opts.trapBudget > 0 ? deadEndRatio(compiled, level.solution, opts.trapBudget) : 0,
        minLanes: level.lanes,
        branching: trace.legalBefore.length === 0 ? 0 : trace.legalBefore.reduce((a, b) => a + b, 0) / trace.legalBefore.length,
        hiddenShare: pods.length === 0 ? 0 : pods.filter((p) => p.hidden).length / pods.length,
        lockCount: pods.filter((p) => p.lock !== undefined).length,
        pairCount: pods.filter((p) => p.link !== undefined).length / 2,
        overflowPods: trace.stalledPod.filter(Boolean).length,
        peakStalled: trace.stalledAfter.reduce((a, b) => Math.max(a, b), 0),
    };
    const pod = podCapacityStats(level);
    stats.maxPodCapacity = pod.max;
    stats.medianPodCapacity = pod.median;
    stats.longestDrainSec = pod.longestDrainSec;
    if (opts.fastRollouts) {
        stats.fastGreedyWinRate = fastWinRate(compiled, 'greedy', opts.fastRollouts, opts.seed);
        stats.fastRandomWinRate = fastWinRate(compiled, 'random', opts.fastRollouts, opts.seed);
    }
    if (opts.laneBudget > 0) {
        const ml = minLanes(level, opts.laneBudget);
        stats.minLanes = ml.lanes;
        stats.minLanesProven = ml.proven;
    }
    return { stats, score: difficultyScore(stats), ms: performance.now() - t0 };
}

/** Round stats for JSON output (stable, readable). */
export function roundStats(stats: DifficultyStats): DifficultyStats {
    const r = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;
    const out: DifficultyStats = {
        randomWinRate: r(stats.randomWinRate),
        greedyWinRate: r(stats.greedyWinRate),
        smartWinRate: r(stats.smartWinRate),
        deadEndRatio: r(stats.deadEndRatio),
        minLanes: stats.minLanes,
        branching: r(stats.branching, 2),
        hiddenShare: r(stats.hiddenShare),
        lockCount: stats.lockCount,
        pairCount: stats.pairCount,
    };
    if (stats.overflowPods !== undefined) out.overflowPods = stats.overflowPods;
    if (stats.peakStalled !== undefined) out.peakStalled = stats.peakStalled;
    if (stats.fastGreedyWinRate !== undefined) out.fastGreedyWinRate = r(stats.fastGreedyWinRate);
    if (stats.fastRandomWinRate !== undefined) out.fastRandomWinRate = r(stats.fastRandomWinRate);
    if (stats.maxPodCapacity !== undefined) out.maxPodCapacity = stats.maxPodCapacity;
    if (stats.medianPodCapacity !== undefined) out.medianPodCapacity = stats.medianPodCapacity;
    if (stats.longestDrainSec !== undefined) out.longestDrainSec = r(stats.longestDrainSec, 2);
    if (stats.minLanesProven !== undefined) out.minLanesProven = stats.minLanesProven;
    return out;
}
