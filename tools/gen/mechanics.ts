/**
 * Automatic mechanic placement (plan/02-generator.md §4). No combined mechanics: a pod is at most one of
 * hidden / locked / linked / pushy. Every lock, pair or pushy placement is replayed and undone if the solution breaks.
 *
 * - Linked pair: consecutive solution pods k, k+1 with ≥ 2 free lanes before step k. With an order-preserving
 *   deal the partner is automatically either directly behind (same column) or at the front of its column.
 * - Locked + key: pod P (not at the front of its column at the start) entering at step j gets a key on a cell
 *   drained strictly before step j, preferring 2–6 steps earlier and deeper cells.
 * - Pushy: a plain pod not at the front of its column at the start. It drops into a lane by itself once exposed,
 *   so it may steal a lane the stored solution needed: replay first, else ask the solver (new tap order). Biased
 *   toward pods that would drop early (long wait at the front in the current solution) with their color buried,
 *   since a forced stall is the point; a pushy pod that drains at once is just automation.
 * - Hidden: a share of the remaining non-front pods (does not affect solvability).
 *
 * After any placement on a plan with pushy pods, the plan is re-synced to the sim's real lane-entry order
 * (`syncPlan`), so `stepOfPod` stays exact.
 */
import type { Rng } from '@game/rng';
import { INF, fullDist } from '@game/reach';
import type { LevelData } from '@game/types';
import { EMPTY } from '@game/types';
import { Sim } from '@game/sim';
import type { Board, Layout } from './board.ts';
import { replay, toLevel, traceSolution } from './board.ts';
import type { Plan } from './plan.ts';
import { clonePlan, isSecondOfPair, planFromLayout, planHasPushy, stepOfPod, syncPlan, toLayout } from './plan.ts';
import { solveLevel } from './solver.ts';

export interface MechanicsWanted {
    hiddenShare: number;
    keys: number;
    pairs: number;
    /** Pushy pods to place (0 when absent; the caller gates this on the lane count, see `pushyCountFor`). */
    pushy?: number;
}

/** Node budget for the solver fallback when a pushy placement breaks the stored solution. */
export const PUSHY_SOLVER_BUDGET = 2000;

/** Carries no mechanic (pushy counts as one: at most one mechanic per pod). */
export function isPlainPod(p: { hidden?: true; pushy?: true; lock?: number; link?: number }): boolean {
    return !p.hidden && !p.pushy && p.lock === undefined && p.link === undefined;
}

function plain(plan: Plan, i: number): boolean {
    return isPlainPod(plan.order[i]);
}

/** Replays the plan; true if it still wins. */
export function planWins(board: Board, plan: Plan): boolean {
    const layout = toLayout(plan);
    if (!layout) return false;
    return replay(toLevel(board, layout, { id: 'check', name: 'check' })).won;
}

/** Index of each pod within its column (0 = front at level start). */
function positions(plan: Plan): number[] {
    const seen = new Array<number>(plan.numCols).fill(0);
    return plan.col.map((c) => seen[c]++);
}

function freeBefore(board: Board, plan: Plan): number[] {
    const layout = toLayout(plan);
    if (!layout) return [];
    return traceSolution(toLevel(board, layout, { id: 'trace', name: 'trace' }), false).freeBefore;
}

/** Try to add one linked pair. Returns true if placed. */
export function addPair(board: Board, plan: Plan, rng: Rng): boolean {
    // Placement reads the solution's trace, so the plan must currently replay (not after a breaking mutation).
    if (!planWins(board, plan) || !syncPlan(board, plan)) return false;
    const free = freeBefore(board, plan);
    const steps = stepOfPod(plan);
    const candidates: number[] = [];
    for (let i = 0; i + 1 < plan.order.length; i++) {
        if (!plain(plan, i) || !plain(plan, i + 1)) continue;
        if ((free[steps[i]] ?? 0) < 2) continue;
        candidates.push(i);
    }
    rng.shuffle(candidates);
    for (const i of candidates.slice(0, 12)) {
        const a = plan.order[i];
        const b = plan.order[i + 1];
        a.link = b.id;
        b.link = a.id;
        if (planWins(board, plan) && syncPlan(board, plan)) return true;
        delete a.link;
        delete b.link;
    }
    return false;
}

/** Try to add one lock + key. Returns true if placed. */
export function addLock(board: Board, plan: Plan, rng: Rng): boolean {
    if (!planWins(board, plan) || !syncPlan(board, plan)) return false;
    const layout = toLayout(plan);
    if (!layout) return false;
    const level = toLevel(board, layout, { id: 'trace', name: 'trace' });
    const { drainStep } = traceSolution(level, false);
    const steps = stepOfPod(plan);
    const pos = positions(plan);
    const taken = new Set(plan.keys.map((k) => k.y * board.width + k.x));
    const depth = depthMap(board);
    const candidates: number[] = [];
    for (let i = 0; i < plan.order.length; i++) {
        if (!plain(plan, i) || pos[i] === 0 || isSecondOfPair(plan, i)) continue;
        if (steps[i] < 1) continue;
        candidates.push(i);
    }
    rng.shuffle(candidates);
    // Lowest free id, so a level's keys read A, B, C.
    const used = new Set(plan.keys.map((k) => k.id));
    let keyId = 0;
    while (used.has(keyId)) keyId++;
    for (const i of candidates.slice(0, 10)) {
        const j = steps[i];
        const weights: number[] = [];
        const cells: number[] = [];
        for (let cell = 0; cell < drainStep.length; cell++) {
            const s = drainStep[cell];
            if (s < 0 || s >= j || taken.has(cell)) continue;
            const gap = j - s;
            const near = gap >= 2 && gap <= 6 ? 4 : gap === 1 ? 1.5 : 1;
            cells.push(cell);
            weights.push(near * (1 + depth[cell] / 4));
        }
        const pick = rng.weighted(weights);
        if (pick < 0) continue;
        const cell = cells[pick];
        plan.order[i].lock = keyId;
        plan.keys.push({ id: keyId, x: cell % board.width, y: Math.floor(cell / board.width) });
        if (planWins(board, plan) && syncPlan(board, plan)) return true;
        delete plan.order[i].lock;
        plan.keys.pop();
    }
    return false;
}

/** How buried each cell is at level start: its own color's exit distance (buried cells count as very deep). */
function depthMap(board: Board): Float64Array {
    const out = new Float64Array(board.cells.length);
    const maps = Array.from({ length: board.numColors }, (_, c) => fullDist(board.cells, board.width, board.height, c));
    for (let i = 0; i < board.cells.length; i++) {
        const c = board.cells[i];
        if (c === EMPTY) continue;
        const d = maps[c][i];
        out[i] = d === INF ? 24 : Math.min(d, 20);
    }
    return out;
}

/** Mark a share of plain non-front pods hidden. */
export function addHidden(plan: Plan, share: number, rng: Rng): number {
    const pos = positions(plan);
    let n = 0;
    plan.order.forEach((p, i) => {
        if (!plain(plan, i) || pos[i] === 0) return;
        if (!rng.chance(share)) return;
        p.hidden = true;
        n++;
    });
    return n;
}

/** A copy of `plan` with exactly `round(share × pods)` plain non-front pods hidden (fewer if not enough qualify). */
export function hideShare(plan: Plan, share: number, rng: Rng): Plan {
    const out = clonePlan(plan);
    const pos = positions(out);
    const options = out.order.map((_, i) => i).filter((i) => plain(out, i) && pos[i] !== 0);
    const want = Math.min(options.length, Math.round(share * out.order.length));
    for (const i of rng.shuffle(options).slice(0, want)) out.order[i].hidden = true;
    return out;
}

export interface Validated {
    plan: Plan;
    layout: Layout;
    /** The stored solution broke and the solver found a new tap order. */
    resolved: boolean;
}

/**
 * Validate an edited plan: replay first, else ask the solver (`solverBudget` nodes, 0 = replay only), which may
 * produce a new tap order. With pushy pods the returned plan is re-read from the sim (real lane-entry order).
 */
export function validatePlan(board: Board, plan: Plan, solverBudget: number): Validated | null {
    const layout = toLayout(plan);
    if (!layout) return null;
    const level = toLevel(board, layout, { id: 'v', name: 'v' });
    if (replay(level).won) {
        if (!planHasPushy(plan)) return { plan, layout, resolved: false };
        return relay(board, layout, false);
    }
    if (solverBudget <= 0) return null;
    const r = solveLevel(level, solverBudget);
    if (r.status !== 'solved') return null;
    return relay(board, { ...layout, solution: r.solution }, true);
}

/** Plan + layout re-read from a layout whose solution wins. */
function relay(board: Board, layout: Layout, resolved: boolean): Validated | null {
    const plan = planFromLayout(board, layout);
    const relaid = toLayout(plan);
    if (!relaid) return null;
    return { plan, layout: relaid, resolved };
}

/** Reachable cells per color just before each solution tap (`out[s][color]`), from a settled replay. */
function reachBeforeSteps(level: LevelData, numColors: number): number[][] {
    const sim = Sim.fromLevel(level, { events: false });
    sim.settle();
    const out: number[][] = [];
    for (const col of level.solution) {
        out.push(Array.from({ length: numColors }, (_, c) => sim.reachableCount(c)));
        sim.tap(col);
        sim.settle();
    }
    return out;
}

/**
 * Candidate pushy pods with a pressure weight (index into `plan.order` → weight). A pushy pod drops as soon as the
 * pod in front of it enters a lane (if a lane is free). Pods that waited long at the front in the current solution
 * would drop much earlier than planned, and a pod whose color has nothing (or too little) reachable at that moment
 * is a forced stall. A pod tapped right after it was exposed (gap 1) barely changes anything.
 */
function pushyCandidates(board: Board, plan: Plan, level: LevelData): { i: number; w: number }[] {
    const steps = stepOfPod(plan);
    const reach = reachBeforeSteps(level, board.numColors);
    const lastInCol = new Array<number>(plan.numCols).fill(-1);
    const out: { i: number; w: number }[] = [];
    plan.order.forEach((p, i) => {
        const before = lastInCol[plan.col[i]];
        lastInCol[plan.col[i]] = i;
        if (before < 0 || !plain(plan, i)) return;
        const exposed = Math.max(0, steps[before]);
        const gap = steps[i] - exposed;
        const r = reach[exposed]?.[p.color] ?? 0;
        const stall = r === 0 ? 4 : p.capacity > r ? 2 : 1;
        out.push({ i, w: (1 + Math.min(gap, 6)) * stall });
    });
    return out;
}

/** Weighted order without replacement. */
function weightedOrder<T extends { w: number }>(items: T[], rng: Rng): T[] {
    const left = items.slice();
    const out: T[] = [];
    while (left.length > 0) {
        const k = rng.weighted(left.map((c) => c.w));
        if (k < 0) break;
        out.push(left[k]);
        left.splice(k, 1);
    }
    return out;
}

/**
 * Try to make one more pod pushy (in place; the plan may get a new tap order from the solver). Tries up to 8
 * candidates (pressure-weighted) by replaying the stored solution, then the 2 heaviest of those with the solver.
 * Returns true if placed.
 */
export function addPushy(board: Board, plan: Plan, rng: Rng, solverBudget = PUSHY_SOLVER_BUDGET): boolean {
    const layout = toLayout(plan);
    if (!layout) return false;
    const level = toLevel(board, layout, { id: 'pushy', name: 'pushy' });
    if (!replay(level).won || !syncPlan(board, plan)) return false;
    const tries = weightedOrder(pushyCandidates(board, plan, level), rng).slice(0, 8);
    const attempt = (i: number, budget: number): boolean => {
        const next = clonePlan(plan);
        next.order[i].pushy = true;
        const ok = validatePlan(board, next, budget);
        if (!ok) return false;
        plan.order = ok.plan.order;
        plan.col = ok.plan.col;
        plan.keys = ok.plan.keys;
        return true;
    };
    for (const c of tries) if (attempt(c.i, 0)) return true;
    if (solverBudget <= 0) return false;
    const heaviest = tries.slice().sort((a, b) => b.w - a.w || a.i - b.i).slice(0, 2);
    for (const c of heaviest) if (attempt(c.i, solverBudget)) return true;
    return false;
}

export interface Placement {
    plan: Plan;
    pairs: number;
    locks: number;
    pushy: number;
    hidden: number;
}

/**
 * Pairs first (they change dynamics), then pushy pods (they may change the tap order), then locks (need the final
 * drain order), then hidden.
 */
export function applyMechanics(board: Board, input: Plan, want: MechanicsWanted, rng: Rng): Placement {
    const plan = clonePlan(input);
    let pairs = 0;
    for (let k = 0; k < want.pairs; k++) if (addPair(board, plan, rng)) pairs++;
    let pushy = 0;
    for (let k = 0; k < (want.pushy ?? 0); k++) if (addPushy(board, plan, rng)) pushy++;
    let locks = 0;
    for (let k = 0; k < want.keys; k++) if (addLock(board, plan, rng)) locks++;
    const hidden = want.hiddenShare > 0 ? addHidden(plan, want.hiddenShare, rng) : 0;
    return { plan, pairs, locks, pushy, hidden };
}
