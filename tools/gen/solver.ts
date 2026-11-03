/**
 * Settled-play solver: DFS over taps with `settle()` between them, memoized on `hashKey()`.
 * Pushy pods need nothing here: the sim drops them inside `tap()` / `settle()`, they are never legal taps while a
 * lane is free, and the state (and its hash) already says where they are.
 *
 * The state graph is a DAG (every tap advances a column head), so a node whose subtree was fully explored
 * without a win is proven dead. A `Solver` keeps its `dead` / `win` memo across calls, which makes the many
 * small sub-searches in `difficulty.ts` (trap density, lane minimisation) cheap.
 */
import type { LevelData } from '@game/types';
import type { CompiledLevel } from '@game/level';
import { compileLevel } from '@game/level';
import { Sim } from '@game/sim';

export type SolveStatus = 'solved' | 'unsolvable' | 'unknown';

export interface SolveResult {
    status: SolveStatus;
    /** Column taps from the start state (only when solved). */
    solution: number[];
    nodes: number;
}

export const DEFAULT_BUDGET = 200_000;

/** Pod index (into the compiled tables) at the front of `col`, or -1. */
function frontIndex(sim: Sim, col: number): number {
    const id = sim.frontPodId(col);
    return id < 0 ? -1 : sim.compiled.podIndex.get(id)!;
}

/**
 * How promising a tap looks, lower is better: 0 = everything tapped completes now, 1 = some of its color is
 * reachable, 2 = nothing reachable. Uses only what a player can see (front pods are always revealed).
 * `deficit` (capacity beyond reachable) breaks ties. A pushy pod the tap would expose is ignored on purpose: judged
 * by what is reachable before the tap drains anything it looks worse than it is (the tapped pod often opens its
 * color), and the search learned to exploit a player that shied away from it.
 */
export function tapScore(sim: Sim, col: number): { tier: number; deficit: number } {
    const c = sim.compiled;
    const p = frontIndex(sim, col);
    const q = c.podLink[p];
    const color = c.podColor[p];
    const reach = sim.reachableCount(color);
    if (q < 0) {
        const deficit = Math.max(0, c.podCap[p] - reach);
        return { tier: deficit === 0 ? 0 : reach > 0 ? 1 : 2, deficit };
    }
    const qColor = c.podColor[q];
    if (qColor === color) {
        const deficit = Math.max(0, c.podCap[p] + c.podCap[q] - reach);
        return { tier: deficit === 0 ? 0 : reach > 0 ? 1 : 2, deficit };
    }
    const qReach = sim.reachableCount(qColor);
    const deficit = Math.max(0, c.podCap[p] - reach) + Math.max(0, c.podCap[q] - qReach);
    return { tier: deficit === 0 ? 0 : reach > 0 || qReach > 0 ? 1 : 2, deficit };
}

/** Legal taps, most promising first (completes now → reachable → rest; then smaller deficit; then column). */
export function orderedTaps(sim: Sim): number[] {
    const legal = sim.legalTaps();
    if (legal.length < 2) return legal;
    const keyed = legal.map((col) => {
        const s = tapScore(sim, col);
        return { col, key: s.tier * 1e6 + s.deficit * 64 + col };
    });
    keyed.sort((a, b) => a.key - b.key);
    return keyed.map((k) => k.col);
}

export class Solver {
    readonly compiled: CompiledLevel;
    /** States proven to have no winning continuation. */
    readonly dead = new Set<number>();
    /** States proven winnable. */
    readonly win = new Set<number>();
    /** Total nodes expanded over the solver's lifetime. */
    totalNodes = 0;
    private nodes = 0;
    private budget = 0;
    private aborted = false;
    private path: number[] = [];

    constructor(level: LevelData | CompiledLevel) {
        this.compiled = 'level' in level ? level : compileLevel(level);
    }

    /** Settled start state. */
    start(): Sim {
        const sim = Sim.fromCompiled(this.compiled, { events: false });
        sim.settle();
        return sim;
    }

    /** Search from `from` (settled) with a node budget. */
    solve(from: Sim, budget: number): SolveResult {
        this.nodes = 0;
        this.budget = budget;
        this.aborted = false;
        this.path = [];
        const ok = this.dfs(from);
        this.totalNodes += this.nodes;
        if (ok) return { status: 'solved', solution: this.path.slice(), nodes: this.nodes };
        return { status: this.aborted ? 'unknown' : 'unsolvable', solution: [], nodes: this.nodes };
    }

    /** Classify a settled state: 'solved' (winnable), 'unsolvable', or 'unknown' within the budget. */
    classify(sim: Sim, budget: number): SolveStatus {
        return this.solve(sim, budget).status;
    }

    private dfs(sim: Sim): boolean {
        if (sim.isWon()) return true;
        const h = sim.hashKey();
        if (this.win.has(h)) {
            // Known winnable: finish the line greedily through known-win children (cheap, no budget).
            return this.followWin(sim);
        }
        if (this.dead.has(h)) return false;
        if (this.nodes >= this.budget) {
            this.aborted = true;
            return false;
        }
        this.nodes++;
        for (const col of orderedTaps(sim)) {
            const child = sim.clone();
            child.tap(col);
            child.settle();
            this.path.push(col);
            if (this.dfs(child)) {
                this.win.add(h);
                return true;
            }
            this.path.pop();
            if (this.aborted) return false;
        }
        this.dead.add(h);
        return false;
    }

    /** From a state known to be winnable, extend `path` to a win via children also known winnable. */
    private followWin(sim: Sim): boolean {
        const mark = this.path.length;
        let cur = sim;
        for (let guard = 0; guard < 10_000; guard++) {
            if (cur.isWon()) return true;
            let next: Sim | null = null;
            for (const col of orderedTaps(cur)) {
                const child = cur.clone();
                child.tap(col);
                child.settle();
                if (!child.isWon() && !this.win.has(child.hashKey())) continue;
                this.path.push(col);
                next = child;
                break;
            }
            if (next === null) break;
            cur = next;
        }
        // Memo said winnable but no recorded line was found (hash collision or partial memo): search normally.
        this.win.delete(cur.hashKey());
        if (this.dfs(cur)) return true;
        this.path.length = mark;
        return false;
    }
}

/** One-shot solve from the level start. */
export function solveLevel(level: LevelData | CompiledLevel, budget = DEFAULT_BUDGET): SolveResult {
    const solver = new Solver(level);
    return solver.solve(solver.start(), budget);
}
