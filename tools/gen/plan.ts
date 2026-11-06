/**
 * `Plan`: a layout seen as pods in lane-entry order plus the column of each pod. Most edits (mechanics, redeals,
 * mutations) are done here and turned back into a `Layout` with `toLayout`.
 *
 * Every pod in `order` enters a lane at its position: the player taps it (linked partners come along), or, for a
 * pushy pod, it drops in by itself. `toLayout` turns the taps into the solution and skips pushy pods.
 * - Without pushy pods, any order-preserving assignment of pods to columns keeps the order a valid tap sequence.
 * - With pushy pods that no longer holds: a pushy pod enters when its column exposes it and a lane is free, which
 *   the board decides, so it can steal a lane a later tap needed. Edits must be re-validated (replay, else the
 *   solver), and `planFromLayout` reads the real entry order off the `Sim`. A plan built by `planFromLayout` (or
 *   re-synced with `syncPlan`) has its pushy pods exactly where the sim drops them.
 * - Fill-first plans: a wave starts once nothing is tappable, so a redeal that puts a locked pod or a pair at a front
 *   can start a wave early. Edits are re-validated the same way.
 */
import type { KeySpec, PodSpec } from '@game/types';
import type { Board, Layout } from './board.ts';
import { laneEntryOrder } from './board.ts';

export interface Plan {
    lanes: number;
    /** Fill-first lanes (`LevelData.fillFirst`). */
    fillFirst?: boolean;
    numCols: number;
    keys: KeySpec[];
    /** Pods in lane-entry order (taps and pushy drops). Linked partners are consecutive. */
    order: PodSpec[];
    /** Column of each pod in `order`. */
    col: number[];
}

/** Plan of a layout whose solution is legal (see `laneEntryOrder`; with pushy pods it replays on the board). */
export function planFromLayout(board: Board, layout: Layout): Plan {
    const colOf = new Map<number, number>();
    layout.columns.forEach((pods, c) => pods.forEach((p) => colOf.set(p.id, c)));
    const order = laneEntryOrder(board, layout).map((p) => ({ ...p }));
    return {
        lanes: layout.lanes,
        ...(layout.fillFirst ? { fillFirst: true } : {}),
        numCols: layout.columns.length,
        keys: layout.keys.map((k) => ({ ...k })),
        order,
        col: order.map((p) => colOf.get(p.id)!),
    };
}

export function clonePlan(plan: Plan): Plan {
    return {
        lanes: plan.lanes,
        ...(plan.fillFirst ? { fillFirst: true } : {}),
        numCols: plan.numCols,
        keys: plan.keys.map((k) => ({ ...k })),
        order: plan.order.map((p) => ({ ...p })),
        col: plan.col.slice(),
    };
}

export function planHasPushy(plan: Plan): boolean {
    return plan.order.some((p) => p.pushy);
}

export function pushyCount(plan: Plan): number {
    return plan.order.filter((p) => p.pushy).length;
}

/**
 * Re-read the lane-entry order of a plan whose layout replays to a win (in place). Only pushy pods can be out of
 * place, so plans without them are left alone. Returns false if the layout is invalid or its solution is illegal.
 */
export function syncPlan(board: Board, plan: Plan): boolean {
    if (!planHasPushy(plan)) return true;
    const layout = toLayout(plan);
    if (!layout) return false;
    let next: Plan;
    try {
        next = planFromLayout(board, layout);
    } catch {
        return false;
    }
    plan.order = next.order;
    plan.col = next.col;
    return true;
}

/** True if `order[i]` is the second pod of a linked pair (its partner was tapped with the previous step). */
export function isSecondOfPair(plan: Plan, i: number): boolean {
    const p = plan.order[i];
    return p.link !== undefined && i > 0 && plan.order[i - 1].id === p.link;
}

/** True if `order[i]` starts a solution step (a tap): not a pushy drop, not the partner of the previous tap. */
export function isTap(plan: Plan, i: number): boolean {
    return !plan.order[i].pushy && !isSecondOfPair(plan, i);
}

/**
 * Solution step index at which each pod enters a lane. A pushy pod gets the step of the last tap before it (it
 * dropped during that tap or its settle). Exact for synced plans (see `syncPlan`).
 */
export function stepOfPod(plan: Plan): number[] {
    const out: number[] = [];
    let step = -1;
    plan.order.forEach((_, i) => {
        if (isTap(plan, i)) step++;
        out.push(step);
    });
    return out;
}

/**
 * Build the layout: pods renumbered 1..N in plan order (links remapped), columns filled in order, one solution
 * step per tap (pushy pods are never tapped). Returns null if a column would be empty, or a locked or pushy pod
 * would start at the front of its column (a pushy front would already be in a lane when the level opens).
 */
export function toLayout(plan: Plan): Layout | null {
    const idMap = new Map<number, number>();
    plan.order.forEach((p, i) => idMap.set(p.id, i + 1));
    const columns: PodSpec[][] = Array.from({ length: plan.numCols }, () => []);
    const solution: number[] = [];
    plan.order.forEach((p, i) => {
        const pod: PodSpec = { id: i + 1, color: p.color, capacity: p.capacity };
        // Front pods are revealed at level start, so `hidden` only means something further back.
        if (p.hidden && columns[plan.col[i]].length > 0) pod.hidden = true;
        if (p.pushy) pod.pushy = true;
        if (p.lock !== undefined) pod.lock = p.lock;
        if (p.link !== undefined) pod.link = idMap.get(p.link)!;
        columns[plan.col[i]].push(pod);
        if (isTap(plan, i)) solution.push(plan.col[i]);
    });
    if (columns.some((c) => c.length === 0)) return null;
    if (columns.some((c) => c[0].lock !== undefined || c[0].pushy)) return null;
    return { lanes: plan.lanes, ...(plan.fillFirst ? { fillFirst: true } : {}), columns, keys: plan.keys.map((k) => ({ ...k })), solution };
}

/** Drop empty columns and renumber the rest (keeps relative order). */
export function compactColumns(plan: Plan): void {
    const used = [...new Set(plan.col)].sort((a, b) => a - b);
    const remap = new Map(used.map((c, i) => [c, i]));
    plan.col = plan.col.map((c) => remap.get(c)!);
    plan.numCols = used.length;
}
