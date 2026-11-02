/**
 * Automatic mechanic placement (plan/02-generator.md §4). No combined mechanics: a pod is at most one of
 * hidden / locked / linked. Every lock or pair placement is replayed and undone if the solution breaks.
 *
 * - Linked pair: consecutive solution pods k, k+1 with ≥ 2 free lanes before step k. With an order-preserving
 *   deal the partner is automatically either directly behind (same column) or at the front of its column.
 * - Locked + key: pod P (not at the front of its column at the start) entering at step j gets a key on a cell
 *   drained strictly before step j, preferring 2–6 steps earlier and deeper cells.
 * - Hidden: a share of the remaining non-front pods (does not affect solvability).
 */
import type { Rng } from '@game/rng';
import { INF, fullDist } from '@game/reach';
import { EMPTY } from '@game/types';
import type { Board } from './board.ts';
import { replay, toLevel, traceSolution } from './board.ts';
import type { Plan } from './plan.ts';
import { clonePlan, isSecondOfPair, stepOfPod, toLayout } from './plan.ts';

export interface MechanicsWanted {
    hiddenShare: number;
    keys: number;
    pairs: number;
}

function plain(plan: Plan, i: number): boolean {
    const p = plan.order[i];
    return !p.hidden && p.lock === undefined && p.link === undefined;
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
    if (!planWins(board, plan)) return false;
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
        if (planWins(board, plan)) return true;
        delete a.link;
        delete b.link;
    }
    return false;
}

/** Try to add one lock + key. Returns true if placed. */
export function addLock(board: Board, plan: Plan, rng: Rng): boolean {
    const layout = toLayout(plan);
    if (!layout || !planWins(board, plan)) return false;
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
        if (planWins(board, plan)) return true;
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

export interface Placement {
    plan: Plan;
    pairs: number;
    locks: number;
    hidden: number;
}

/** Pairs first (they change dynamics), then locks (need the final drain order), then hidden. */
export function applyMechanics(board: Board, input: Plan, want: MechanicsWanted, rng: Rng): Placement {
    const plan = clonePlan(input);
    let pairs = 0;
    for (let k = 0; k < want.pairs; k++) if (addPair(board, plan, rng)) pairs++;
    let locks = 0;
    for (let k = 0; k < want.keys; k++) if (addLock(board, plan, rng)) locks++;
    const hidden = want.hiddenShare > 0 ? addHidden(plan, want.hiddenShare, rng) : 0;
    return { plan, pairs, locks, hidden };
}
