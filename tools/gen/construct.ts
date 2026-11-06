/**
 * Build a layout forward from a known solution (plan/02-generator.md §3).
 *
 * Settled play only keeps a pod in a lane when it *stalls* (capacity > what is reachable for its color). So the
 * play-through deliberately mixes:
 *  - fit pods      capacity ≤ reachable: complete in their own settle;
 *  - overflow pods capacity > reachable: drain what they can, then stall until other colors open paths;
 *  - parked pods   nothing reachable at all: hold a lane purely so the column behind them opens up.
 * Stalled pods after any settle are capped at `maxStalled` (< lanes), so a free lane always remains.
 * The ordered pod list is then dealt into columns preserving order, which keeps it a valid solution.
 *
 * Fill-first (`knobs.fillFirst`): the play-through runs in waves (`PlaySim` wave mode). Pods tapped into the current
 * fill are held, so they are not stalls, and their cells are already promised: a color's reachable pool for new fit
 * pods is what the pods in lanes have not claimed yet. Fit pods of one color then never need more than the pool, so
 * they all complete in the wave. Each fill keeps room for at least one fit pod, which frees a lane, and a held color
 * gets no park or overflow pod in the same fill (it would compete for the fit pods' cells). If a fill runs out of fit
 * and park options anyway, construction gives up (`ConstructStuck`) and the caller skips the candidate.
 */
import type { PodSpec } from '@game/types';
import type { Rng } from '@game/rng';
import type { Board, Layout } from './board.ts';
import type { DealStyle, Knobs } from './knobs.ts';
import { SEAL_PARK_RATE, podCaps } from './knobs.ts';
import { PlaySim } from './playsim.ts';

export interface PlannedPod {
    color: number;
    capacity: number;
    kind: 'fit' | 'overflow' | 'park';
}

/** Fill-first construction ran out of pods that keep the play-through going (see the file header). */
export class ConstructStuck extends Error {}

export interface Construction {
    layout: Layout;
    /** Pods in solution order (pod id = index + 1). */
    order: PlannedPod[];
}

/** Desired pod size for a color: its total split into `n` pods, jittered. */
function desiredSize(total: number, n: number, rng: Rng): number {
    return Math.max(1, Math.round((total / n) * rng.float(0.6, 1.4)));
}

/** Clamp to what's left and absorb a small remainder so no crumb-sized last pod is created. */
function clampSize(k: number, unassigned: number, typical: number): number {
    const c = Math.min(k, unassigned);
    const crumb = Math.max(1, Math.round(typical * 0.35));
    return unassigned - c < crumb ? unassigned : c;
}

interface StepView {
    free: number;
    stalled: number;
    unassigned: number[];
    reach: number[];
    /** Fill-first: colors with a held pod in the current fill (no park or overflow pod may join them). */
    taken: boolean[];
}

function view(sim: PlaySim, lanes: number): StepView {
    const free = sim.freeLanes();
    const unassigned: number[] = [];
    const reach: number[] = [];
    for (let c = 0; c < sim.numColors; c++) {
        unassigned.push(sim.unassigned(c));
        reach.push(unassigned[c] > 0 ? sim.reachableCount(c) : 0);
    }
    return { free, stalled: lanes - free, unassigned, reach, taken: new Array<boolean>(sim.numColors).fill(false) };
}

/**
 * Fill-first view: `reach` is what the pods in lanes have not promised yet, and `stalled` counts pods that stalled
 * through a wave plus the park / overflow pods held in this fill (`heldStalls`).
 */
function waveView(sim: PlaySim, heldStalls: number): StepView {
    const free = sim.freeLanes();
    const promised = new Array<number>(sim.numColors).fill(0);
    const taken = new Array<boolean>(sim.numColors).fill(false);
    let stalled = heldStalls;
    for (let l = 0; l < sim.numLanes; l++) {
        const c = sim.laneColor[l];
        if (c < 0) continue;
        promised[c] += sim.laneRem[l];
        if (sim.laneWaved[l] === 1) stalled++;
        else taken[c] = true;
    }
    const unassigned: number[] = [];
    const reach: number[] = [];
    for (let c = 0; c < sim.numColors; c++) {
        unassigned.push(sim.unassigned(c));
        reach.push(unassigned[c] > 0 ? Math.max(0, sim.reachableCount(c) - promised[c]) : 0);
    }
    return { free, stalled, unassigned, reach, taken };
}

function tryTap(sim: PlaySim, color: number, capacity: number): PlaySim | null {
    const next = sim.clone();
    next.tap(color, capacity);
    next.settle();
    return next.freeLanes() > 0 || next.cellsLeft === 0 ? next : null;
}

/**
 * Simulate a solution and return the pods in tap order.
 *
 * Each step, if the stall budget allows: maybe park a pod (nothing of its color reachable), else maybe add an
 * overflow pod for a color whose reachable pool is small but which still has buried cells. Otherwise add a fit
 * pod. Harder knobs drain "buried" colors' reachable pools first (making overflow possible) and prefer fit pods
 * that do not release stalled lanes yet, so stalls overlap and the lane count actually matters.
 */
export function planPods(board: Board, knobs: Knobs, rng: Rng): PlannedPod[] {
    const { numColors, counts } = board;
    const lanes = knobs.lanes;
    const caps = podCaps(counts, knobs.maxPod);
    const maxStalled = Math.max(0, Math.min(lanes - 1, knobs.maxStalled));
    const typical = counts.map((total, c) => {
        const wanted = rng.int(knobs.podsPerColor[0], knobs.podsPerColor[1]);
        const n = Math.max(1, Math.min(total, Math.max(wanted, Math.ceil(total / caps[c]))));
        return total / n;
    });
    const size = (c: number, unassigned: number) =>
        Math.min(caps[c], clampSize(desiredSize(counts[c], counts[c] / typical[c], rng), unassigned, typical[c]));
    const waves = knobs.fillFirst ?? false;
    let sim = PlaySim.create(board, lanes, waves);
    const order: PlannedPod[] = [];
    let last = -1;
    // Fill-first: park / overflow pods held in the current fill, and whether it has a fit pod yet.
    let heldStalls = 0;
    let fillFit = false;
    const push = (next: PlaySim, color: number, capacity: number, kind: PlannedPod['kind']) => {
        const waved = next.waveCount > sim.waveCount;
        sim = next;
        order.push({ color, capacity, kind });
        last = color;
        heldStalls = waved ? 0 : heldStalls + (kind === 'fit' ? 0 : 1);
        fillFit = !waved && (fillFit || kind === 'fit');
    };
    const guard = board.cells.length * 4 + 100;
    for (let iter = 0; sim.cellsLeft > 0 && iter < guard; iter++) {
        const v = waves ? waveView(sim, heldStalls) : view(sim, lanes);
        const canStall = v.stalled < maxStalled && v.free >= 2;
        // Fill-first: a stall pod of color c must leave the fill a fit pod (one already in it, or a color to make one).
        const stallOk = (c: number) => !waves || (!v.taken[c] && (fillFit || v.reach.some((r, d) => r > 0 && d !== c)));
        // A seal (outline ring, background) that still hides part of the picture: park more, so the seal's pods queue
        // up behind parked pods.
        const sealed = board.seals?.some((c) => v.unassigned[c] > 0) ?? false;
        const parkRate = sealed ? Math.max(knobs.parkRate, SEAL_PARK_RATE) : knobs.parkRate;

        if (canStall && parkRate > 0 && rng.chance(parkRate)) {
            const parkable: number[] = [];
            for (let c = 0; c < numColors; c++) if (v.reach[c] === 0 && v.unassigned[c] > 0 && stallOk(c)) parkable.push(c);
            if (parkable.length > 0) {
                const c = rng.pick(parkable);
                const k = size(c, v.unassigned[c]);
                const next = tryTap(sim, c, k);
                if (next) {
                    push(next, c, k, 'park');
                    continue;
                }
            }
        }

        if (canStall && knobs.overflowRate > 0) {
            const weights: number[] = [];
            for (let c = 0; c < numColors; c++) {
                const buried = v.unassigned[c] - v.reach[c];
                const ok = v.reach[c] > 0 && buried > 0 && v.reach[c] <= 1.6 * typical[c] && stallOk(c);
                weights.push(ok ? 1 + buried / typical[c] : 0);
            }
            const c = rng.weighted(weights);
            if (c >= 0 && rng.chance(knobs.overflowRate)) {
                const buried = v.unassigned[c] - v.reach[c];
                const deficit = rng.int(1, Math.max(1, Math.min(buried, Math.round(typical[c]))));
                const k = Math.min(caps[c], clampSize(v.reach[c] + deficit, v.unassigned[c], typical[c]));
                const next = tryTap(sim, c, k);
                if (next) {
                    push(next, c, k, k > v.reach[c] ? 'overflow' : 'fit');
                    continue;
                }
            }
        }

        // Fit pod.
        const weights: number[] = [];
        const want: number[] = [];
        for (let c = 0; c < numColors; c++) {
            if (v.reach[c] === 0 || v.unassigned[c] === 0) {
                weights.push(0);
                want.push(0);
                continue;
            }
            const k = Math.min(size(c, v.unassigned[c]), v.reach[c]);
            want.push(k);
            const buried = v.unassigned[c] > v.reach[c];
            const crumb = k < 0.4 * typical[c] && k < v.unassigned[c];
            let w = Math.sqrt(v.reach[c]) * (c === last ? 0.35 : 1) * (crumb ? 0.25 : 1);
            if (buried) w *= 1 + 2 * knobs.overflowRate;
            weights.push(w);
        }
        let c = rng.weighted(weights);
        if (c < 0 && waves) {
            // Fill-first: everything reachable is promised to this fill. Park a buried color (the fill's fit pod
            // frees a lane), else give up.
            const parkable: number[] = [];
            for (let d = 0; d < numColors; d++) if (v.unassigned[d] > 0 && !v.taken[d]) parkable.push(d);
            if (parkable.length === 0) throw new ConstructStuck('construct: fill-first fill ran out of pods');
            const d = rng.pick(parkable);
            const k = size(d, v.unassigned[d]);
            const next = tryTap(sim, d, k);
            if (!next) throw new ConstructStuck('construct: fill-first park jammed the lanes');
            push(next, d, k, 'park');
            continue;
        }
        if (c < 0) throw new Error('construct: no reachable color (impossible on a non-empty board)');
        // Fill-first skips this: in a wave every pod in a lane drains together, nothing can hold a stall open.
        if (!waves && v.stalled > 0 && v.stalled < maxStalled && rng.chance(knobs.overflowRate)) {
            // Room for more overlap: prefer a fit pod that keeps the stalled lanes stalled a little longer.
            // (At the stall cap, holding would only delay the next overflow pod.)
            const holding = weights.map((w, d) => {
                if (w === 0) return 0;
                const next = tryTap(sim, d, want[d]);
                return next && lanes - next.freeLanes() >= v.stalled ? w : 0;
            });
            const h = rng.weighted(holding);
            if (h >= 0) c = h;
        }
        const next = tryTap(sim, c, want[c]);
        if (!next && waves) throw new ConstructStuck('construct: fill-first fit pod jammed the lanes');
        if (!next) throw new Error('construct: a fit pod jammed the lanes (impossible)');
        push(next, c, want[c], 'fit');
    }
    if (sim.cellsLeft > 0) throw new Error('construct: play-through did not finish');
    return order;
}

/** Order-preserving deal of `count` pods into `cols` columns; returns the column of each pod. */
export function deal(count: number, cols: number, style: DealStyle, rng: Rng): number[] {
    const out: number[] = [];
    const len = new Array<number>(cols).fill(0);
    const put = (c: number) => {
        out.push(c);
        len[c]++;
    };
    const balancedPick = (avoid: number) => {
        const min = Math.min(...len);
        const options: number[] = [];
        for (let c = 0; c < cols; c++) if (len[c] <= min + 1 && c !== avoid) options.push(c);
        if (options.length === 0) for (let c = 0; c < cols; c++) if (len[c] <= min + 1) options.push(c);
        return rng.pick(options);
    };
    if (style === 'roundrobin') {
        const perm = rng.shuffle(Array.from({ length: cols }, (_, i) => i));
        for (let i = 0; i < count; i++) put(perm[i % cols]);
        return out;
    }
    for (let i = 0; i < count; i++) {
        const remaining = count - i;
        const empty = len.filter((l) => l === 0).length;
        // Every column must end up non-empty.
        if (empty >= remaining) {
            put(len.indexOf(0));
            continue;
        }
        if (style === 'random') {
            put(rng.below(cols));
            continue;
        }
        if (style === 'clumped' && i > 0 && rng.chance(0.55)) {
            put(out[i - 1]);
            continue;
        }
        put(balancedPick(style === 'clumped' && i > 0 ? out[i - 1] : -1));
    }
    return out;
}

/** Column count that suits the number of pods (tiny levels get fewer columns). */
export function columnsFor(knobs: Knobs, pods: number): number {
    return Math.max(1, Math.min(knobs.columns, Math.ceil(pods / 2.5)));
}

export function layoutFromOrder(order: PlannedPod[], cols: number[], numCols: number, lanes: number, fillFirst = false): Layout {
    const columns: PodSpec[][] = Array.from({ length: numCols }, () => []);
    order.forEach((p, i) => columns[cols[i]].push({ id: i + 1, color: p.color, capacity: p.capacity }));
    return { lanes, ...(fillFirst ? { fillFirst: true } : {}), columns, keys: [], solution: cols.slice() };
}

export function construct(board: Board, knobs: Knobs, rng: Rng): Construction {
    const order = planPods(board, knobs, rng);
    const numCols = columnsFor(knobs, order.length);
    const cols = deal(order.length, numCols, knobs.deal, rng);
    return { layout: layoutFromOrder(order, cols, numCols, knobs.lanes, knobs.fillFirst), order };
}
