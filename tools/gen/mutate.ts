/**
 * Hill-climb mutations on a `Plan`. Without pushy pods, redeals (`move`) keep the tap order, so they are always
 * solvable; the rest (and every edit of a plan with pushy pods, whose drop times depend on the deal) may break the
 * stored solution and are re-validated by the caller (`validatePlan`: replay, then solver).
 *
 * The pushy count is fixed per level (`pushyCountFor`): the climb only moves the flag to another pod
 * (`pushy-move`), and never cuts lanes below `MIN_PUSHY_LANES` while the plan has pushy pods.
 *
 * Fill-first (`fillFirstLanes`): a fill-first plan keeps at most that many lanes and any other plan keeps more, so the
 * lane mutations never move a level across the fill-first boundary.
 */
import type { Rng } from '@game/rng';
import type { Board } from './board.ts';
import type { Plan } from './plan.ts';
import { clonePlan, planHasPushy, toLayout } from './plan.ts';
import { addLock, addPair, isPlainPod } from './mechanics.ts';
import { MIN_PUSHY_LANES } from './knobs.ts';

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
    | 'unpair'
    | 'pushy-move';

export interface MutationRules {
    hidden: boolean;
    locks: boolean;
    pairs: boolean;
    /** Allow moving the pushy flag to another pod (count unchanged). */
    pushy: boolean;
    maxHiddenShare: number;
    maxLocks: number;
    /** Fewest pairs the climb may unpair down to. */
    minPairs: number;
    maxPairs: number;
    minLanes: number;
    maxLanes: number;
    /** Level eligible for fill-first lanes: fill-first plans stay at ≤ this many lanes, other plans above it. */
    fillFirstLanes?: number;
    /** Largest pod per color (`podCaps`; undefined = no cap). */
    podCaps?: number[];
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
    if (rules.pushy) w.push(['pushy-move', 1.5]);
    return w;
}

/** Lane bounds from the fill-first boundary (`MutationRules.fillFirstLanes`); unbounded when the level is not eligible. */
function laneRange(plan: Plan, rules: MutationRules): { min: number; max: number } {
    const ff = rules.fillFirstLanes;
    if (ff === undefined) return { min: 1, max: Infinity };
    return plan.fillFirst ? { min: 1, max: ff } : { min: ff + 1, max: Infinity };
}

function plainIdx(plan: Plan, i: number): boolean {
    return isPlainPod(plan.order[i]);
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
            if (a.capacity + delta > (rules.podCaps?.[color] ?? Infinity)) return false;
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
            if (plan.order[i].capacity + plan.order[i + 1].capacity > (rules.podCaps?.[plan.order[i].color] ?? Infinity)) return false;
            plan.order[i].capacity += plan.order[i + 1].capacity;
            plan.order.splice(i + 1, 1);
            plan.col.splice(i + 1, 1);
            return true;
        }
        case 'lanes-': {
            const hasPair = plan.order.some((p) => p.link !== undefined);
            const floor = Math.max(rules.minLanes, hasPair ? 2 : 1, planHasPushy(plan) ? MIN_PUSHY_LANES : 1, laneRange(plan, rules).min);
            if (plan.lanes <= floor) return false;
            plan.lanes--;
            return true;
        }
        case 'lanes+': {
            if (plan.lanes >= Math.min(rules.maxLanes, laneRange(plan, rules).max)) return false;
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
        case 'pushy-move': {
            const from = plan.order.map((p, i) => (p.pushy ? i : -1)).filter((i) => i >= 0);
            if (from.length === 0) return false;
            const front = frontFlags(plan);
            const to = plan.order.map((_, i) => i).filter((i) => plainIdx(plan, i) && !front[i]);
            if (to.length === 0) return false;
            delete plan.order[rng.pick(from)].pushy;
            plan.order[rng.pick(to)].pushy = true;
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
