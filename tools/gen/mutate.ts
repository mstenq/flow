/**
 * Hill-climb mutations on a `Plan`. Redeals (`move`) keep the tap order, so they are always solvable; the
 * rest may break the stored solution and are re-validated by the caller (replay, then solver).
 */
import type { Rng } from '@game/rng';
import type { Board } from './board.ts';
import type { Plan } from './plan.ts';
import { clonePlan, toLayout } from './plan.ts';
import { addLock, addPair } from './mechanics.ts';

export type MutationKind =
    | 'move'
    | 'swap'
    | 'resize'
    | 'split'
    | 'merge'
    | 'lanes-'
    | 'lanes+'
    | 'hide'
    | 'unhide'
    | 'lock'
    | 'unlock'
    | 'pair'
    | 'unpair';

export interface MutationRules {
    hidden: boolean;
    locks: boolean;
    pairs: boolean;
    maxHiddenShare: number;
    maxLocks: number;
    /** Fewest pairs the climb may unpair down to. */
    minPairs: number;
    maxPairs: number;
    minLanes: number;
    maxLanes: number;
    /** Hard cap on pod capacity (undefined = none). */
    maxPod?: number;
    /** Set once the climb relaxed the mechanic caps to make an unlosable level losable. */
    rescue?: boolean;
}

/** Which mutations to try, weighted by whether the level should get harder (+1) or easier (-1). */
function weightsFor(direction: number, rules: MutationRules): [MutationKind, number][] {
    const harder = direction > 0;
    const w: [MutationKind, number][] = [
        ['move', 5],
        ['swap', 2],
        ['resize', 3],
        ['split', harder ? 1 : 2],
        ['merge', harder ? 2 : 1],
        ['lanes-', harder ? 2 : 0],
        ['lanes+', harder ? 0 : 2],
    ];
    if (rules.hidden) w.push(['hide', harder ? 1.5 : 0.3], ['unhide', harder ? 0.3 : 1.5]);
    if (rules.locks) w.push(['lock', harder ? 1.5 : 0.2], ['unlock', harder ? 0.2 : 1.5]);
    if (rules.pairs) w.push(['pair', harder ? 1.5 : 0.2], ['unpair', harder ? 0.2 : 1.5]);
    return w;
}

function plainIdx(plan: Plan, i: number): boolean {
    const p = plan.order[i];
    return !p.hidden && p.lock === undefined && p.link === undefined;
}

function nextId(plan: Plan): number {
    return plan.order.reduce((m, p) => Math.max(m, p.id), 0) + 1;
}

function frontFlags(plan: Plan): boolean[] {
    const seen = new Set<number>();
    return plan.col.map((c) => {
        const front = !seen.has(c);
        seen.add(c);
        return front;
    });
}

function apply(kind: MutationKind, board: Board, plan: Plan, rng: Rng, rules: MutationRules): boolean {
    const n = plan.order.length;
    switch (kind) {
        case 'move': {
            if (plan.numCols < 2) return false;
            const i = rng.below(n);
            let c = rng.below(plan.numCols - 1);
            if (c >= plan.col[i]) c++;
            plan.col[i] = c;
            return true;
        }
        case 'swap': {
            const i = rng.below(Math.max(1, n - 1));
            if (i + 1 >= n) return false;
            if (plan.order[i].link !== undefined || plan.order[i + 1].link !== undefined) return false;
            [plan.order[i], plan.order[i + 1]] = [plan.order[i + 1], plan.order[i]];
            [plan.col[i], plan.col[i + 1]] = [plan.col[i + 1], plan.col[i]];
            return true;
        }
        case 'resize': {
            const color = plan.order[rng.below(n)].color;
            const same = plan.order.map((p, i) => (p.color === color ? i : -1)).filter((i) => i >= 0);
            if (same.length < 2) return false;
            rng.shuffle(same);
            const a = plan.order[same[0]];
            const b = plan.order[same[1]];
            if (b.capacity < 2) return false;
            const delta = rng.int(1, Math.max(1, Math.round(b.capacity * 0.4)));
            if (b.capacity - delta < 1) return false;
            if (a.capacity + delta > (rules.maxPod ?? Infinity)) return false;
            a.capacity += delta;
            b.capacity -= delta;
            return true;
        }
        case 'split': {
            const i = rng.below(n);
            const p = plan.order[i];
            if (!plainIdx(plan, i) || p.capacity < 4) return false;
            const k = rng.int(1, p.capacity - 1);
            p.capacity -= k;
            plan.order.splice(i + 1, 0, { id: nextId(plan), color: p.color, capacity: k });
            plan.col.splice(i + 1, 0, rng.chance(0.5) ? plan.col[i] : rng.below(plan.numCols));
            return true;
        }
        case 'merge': {
            const i = rng.below(Math.max(1, n - 1));
            if (i + 1 >= n || !plainIdx(plan, i) || !plainIdx(plan, i + 1)) return false;
            if (plan.order[i].color !== plan.order[i + 1].color) return false;
            if (plan.order[i].capacity + plan.order[i + 1].capacity > (rules.maxPod ?? Infinity)) return false;
            plan.order[i].capacity += plan.order[i + 1].capacity;
            plan.order.splice(i + 1, 1);
            plan.col.splice(i + 1, 1);
            return true;
        }
        case 'lanes-': {
            const hasPair = plan.order.some((p) => p.link !== undefined);
            const floor = Math.max(rules.minLanes, hasPair ? 2 : 1);
            if (plan.lanes <= floor) return false;
            plan.lanes--;
            return true;
        }
        case 'lanes+': {
            if (plan.lanes >= rules.maxLanes) return false;
            plan.lanes++;
            return true;
        }
        case 'hide': {
            const front = frontFlags(plan);
            const options = plan.order.map((_, i) => i).filter((i) => plainIdx(plan, i) && !front[i]);
            if (options.length === 0) return false;
            if ((plan.order.filter((p) => p.hidden).length + 1) / n > rules.maxHiddenShare) return false;
            plan.order[rng.pick(options)].hidden = true;
            return true;
        }
        case 'unhide': {
            const options = plan.order.map((p, i) => (p.hidden ? i : -1)).filter((i) => i >= 0);
            if (options.length === 0) return false;
            delete plan.order[rng.pick(options)].hidden;
            return true;
        }
        case 'lock':
            if (plan.order.filter((p) => p.lock !== undefined).length >= rules.maxLocks) return false;
            return addLock(board, plan, rng);
        case 'unlock': {
            const options = plan.order.filter((p) => p.lock !== undefined);
            if (options.length === 0) return false;
            const p = rng.pick(options);
            plan.keys = plan.keys.filter((k) => k.id !== p.lock);
            delete p.lock;
            return true;
        }
        case 'pair':
            if (plan.order.filter((p) => p.link !== undefined).length / 2 >= rules.maxPairs) return false;
            return addPair(board, plan, rng);
        case 'unpair': {
            const options = plan.order.filter((p) => p.link !== undefined);
            if (options.length / 2 <= rules.minPairs) return false;
            const p = rng.pick(options);
            const q = plan.order.find((o) => o.id === p.link);
            delete p.link;
            if (q) delete q.link;
            return true;
        }
    }
}

export interface Mutation {
    plan: Plan;
    kind: MutationKind;
}

/** One random structural mutation, or null if none applied (caller retries). */
export function mutate(board: Board, plan: Plan, rng: Rng, direction: number, rules: MutationRules): Mutation | null {
    const weights = weightsFor(direction, rules);
    const kind = weights[rng.weighted(weights.map((w) => w[1]))][0];
    const next = clonePlan(plan);
    if (!apply(kind, board, next, rng, rules)) return null;
    if (!toLayout(next)) return null;
    return { plan: next, kind };
}
