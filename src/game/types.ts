/**
 * Shared types for the FLOW rules engine. Pure data — no Phaser, no DOM.
 * See PLAN.md "Canonical game rules" and "Level JSON".
 */

/** Cell value for an empty cell in the sim's `Uint8Array` board. */
export const EMPTY = 255;

export interface Point {
    x: number;
    y: number;
}

/** A pod in a queue column. At most one of `hidden` / `lock` / `link` is set (no combined mechanics in v1). */
export interface PodSpec {
    id: number;
    color: number;
    capacity: number;
    hidden?: true;
    /** Key id that unlocks this pod. */
    lock?: number;
    /** Pod id of the linked partner (must link back). */
    link?: number;
}

/** A key sitting on a colored board cell. Draining that cell collects it. */
export interface KeySpec {
    id: number;
    x: number;
    y: number;
}

export interface DifficultyStats {
    randomWinRate: number;
    greedyWinRate: number;
    /** Win rate of a sensible player: pods that fill completely first, then pods with anything reachable. */
    smartWinRate: number;
    deadEndRatio: number;
    minLanes: number;
    branching: number;
    hiddenShare: number;
    lockCount: number;
    pairCount: number;
    /** Solution taps whose pod stalls (does not complete in its own settle). Generator diagnostic. */
    overflowPods?: number;
    /** Most lanes left stalled after any settle along the solution. Generator diagnostic. */
    peakStalled?: number;
    /** Win rate of a real-time player who taps whenever a legal tap exists (no settling), greedy pod choice. Diagnostic only. */
    fastGreedyWinRate?: number;
    /** Same timing as `fastGreedyWinRate`, uniformly random pod choice. Diagnostic only. */
    fastRandomWinRate?: number;
    /** Largest pod capacity (cells). Diagnostic only. */
    maxPodCapacity?: number;
    /** Median pod capacity (cells). Diagnostic only. */
    medianPodCapacity?: number;
    /** Estimated drain time of the largest pod at 1x speed: maxPodCapacity * tickMs / 1000. Diagnostic only. */
    longestDrainSec?: number;
    /** True if `minLanes - 1` was proven unsolvable; false if the solver budget ran out first. */
    minLanesProven?: boolean;
}

export interface LevelMeta {
    seed: number;
    targetDifficulty: number;
    difficulty: number;
    stats: DifficultyStats;
    generatorVersion: string;
    sourceHash: string;
}

export interface LevelData {
    version: 1;
    /** Bump when sim rules change; `bun run verify` re-checks levels. */
    rulesVersion: number;
    id: string;
    name: string;
    width: number;
    height: number;
    /** Neon hex per color index. */
    palette: string[];
    /** Row-major, '.' = empty, '0'..'9' = color index. Length = width × height. */
    cells: string;
    keys: KeySpec[];
    lanes: number;
    /** Base drain speed (2x toggle halves it). */
    tickMs: number;
    /** `columns[i][0]` is the front. */
    columns: PodSpec[][];
    /** Column index tapped per step (settled play). */
    solution: number[];
    meta: LevelMeta;
}

export interface Action {
    column: number;
}

export type SimEvent =
    | { t: 'tapped'; podIds: number[]; lanes: number[] }
    /** `path` (only when the sim was built with `emitPaths`) runs from the claimed cell to the border cell, then one final point outside the grid marking the exit side. Otherwise it is empty. */
    | { t: 'claimed'; podId: number; lane: number; x: number; y: number; color: number; path: Point[] }
    | { t: 'keyCollected'; keyId: number; x: number; y: number; podId: number }
    | { t: 'unlocked'; podId: number }
    | { t: 'revealed'; podId: number }
    /** Emitted per pod; linked pairs emit both in the same tick. */
    | { t: 'podCompleted'; podId: number; lane: number }
    | { t: 'won' }
    | { t: 'dead' };

export type SimEventType = SimEvent['t'];

/** Why a tap on a column is not legal right now. */
export type TapDenial = 'locked' | 'noLane' | 'partnerUnavailable' | 'empty';

/**
 * - `draining`: has remaining capacity and a reachable cell of its color.
 * - `stalled`: has remaining capacity but nothing reachable right now.
 * - `waiting`: linked pod that is full and waiting for its partner.
 */
export type LaneStatus = 'draining' | 'stalled' | 'waiting';

/** Runtime state of an occupied lane (internal + view). */
export interface LaneState {
    podId: number;
    color: number;
    capacity: number;
    remaining: number;
    state: LaneStatus;
    /** Partner pod id for linked pods, else null. */
    link: number | null;
}

/** What the player may see about a queued pod. */
export interface PodState {
    id: number;
    /** Null while hidden or locked. */
    color: number | null;
    /** Null while hidden or locked. */
    capacity: number | null;
    hidden: boolean;
    locked: boolean;
    /** Key id that unlocks this pod while it is locked, else null. */
    lock: number | null;
    /** Partner pod id for linked pods, else null. */
    link: number | null;
}

export interface KeyView {
    id: number;
    x: number;
    y: number;
    /** Pod this key unlocks. */
    podId: number;
}

export interface ViewState {
    width: number;
    height: number;
    /** Copy of the board, row-major, `EMPTY` (255) = empty. */
    cells: Uint8Array;
    /** Keys not yet collected. */
    keys: KeyView[];
    /** One entry per lane, null = free. */
    lanes: (LaneState | null)[];
    /** Pods still queued per column; index 0 is the front. */
    columns: PodState[][];
    settled: boolean;
    won: boolean;
    dead: boolean;
    /** Ticks run since level start. */
    ticks: number;
}
