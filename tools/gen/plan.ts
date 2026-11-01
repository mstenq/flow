/**
 * `Plan`: a layout seen as pods in solution order plus the column of each pod. Any order-preserving
 * assignment of pods to columns keeps the order a valid tap sequence, so most edits (mechanics, redeals,
 * mutations) are done here and turned back into a `Layout` with `toLayout`.
 */
import type { KeySpec, PodSpec } from '@game/types';
import type { Layout } from './board.ts';
import { solutionPodOrder } from './board.ts';

export interface Plan {
    lanes: number;
    numCols: number;
    keys: KeySpec[];
    /** Pods in tap order. Linked partners are consecutive. */
    order: PodSpec[];
    /** Column of each pod in `order`. */
    col: number[];
}

export function planFromLayout(layout: Layout): Plan {
    const colOf = new Map<number, number>();
    layout.columns.forEach((pods, c) => pods.forEach((p) => colOf.set(p.id, c)));
    const order = solutionPodOrder(layout).map((p) => ({ ...p }));
    return {
        lanes: layout.lanes,
        numCols: layout.columns.length,
        keys: layout.keys.map((k) => ({ ...k })),
        order,
        col: order.map((p) => colOf.get(p.id)!),
    };
}

export function clonePlan(plan: Plan): Plan {
    return {
        lanes: plan.lanes,
        numCols: plan.numCols,
        keys: plan.keys.map((k) => ({ ...k })),
        order: plan.order.map((p) => ({ ...p })),
        col: plan.col.slice(),
    };
}

/** True if `order[i]` is the second pod of a linked pair (its partner was tapped with the previous step). */
export function isSecondOfPair(plan: Plan, i: number): boolean {
    const p = plan.order[i];
    return p.link !== undefined && i > 0 && plan.order[i - 1].id === p.link;
}

/** Solution step index at which each pod enters a lane. */
export function stepOfPod(plan: Plan): number[] {
    const out: number[] = [];
    let step = -1;
    plan.order.forEach((_, i) => {
        if (!isSecondOfPair(plan, i)) step++;
        out.push(step);
    });
    return out;
}

/**
 * Build the layout: pods renumbered 1..N in tap order (links remapped), columns filled in order.
 * Returns null if a column would be empty or a locked pod would start at the front of its column.
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
        if (p.lock !== undefined) pod.lock = p.lock;
        if (p.link !== undefined) pod.link = idMap.get(p.link)!;
        columns[plan.col[i]].push(pod);
        if (!isSecondOfPair(plan, i)) solution.push(plan.col[i]);
    });
    if (columns.some((c) => c.length === 0)) return null;
    if (columns.some((c) => c[0].lock !== undefined)) return null;
    return { lanes: plan.lanes, columns, keys: plan.keys.map((k) => ({ ...k })), solution };
}

/** Drop empty columns and renumber the rest (keeps relative order). */
export function compactColumns(plan: Plan): void {
    const used = [...new Set(plan.col)].sort((a, b) => a - b);
    const remap = new Map(used.map((c, i) => [c, i]));
    plan.col = plan.col.map((c) => remap.get(c)!);
    plan.numCols = used.length;
}
