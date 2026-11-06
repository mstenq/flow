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

/** A pod in a queue column. At most one of `hidden` / `lock` / `link` / `pushy` is set (no combined mechanics in v1). */
export interface PodSpec {
    id: number;
    color: number;
    capacity: number;
    hidden?: true;
    /** Drops into a free lane by itself as soon as it is at the front of its column (see `Sim`). */
    pushy?: true;
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
    /** Pushy pods in the level. */
    pushyCount?: number;
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
    /**
     * Fill-first lanes: pods drain in waves. A wave starts once the player can't tap (every lane is full, or no
     * legal tap is left) and runs the pods in lanes at that moment until none of them can drain. Pods tapped
     * mid-wave are held for the next one (see `Sim`).
     */
    fillFirst?: true;
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
    /** A pushy pod at a column front dropped into `lane` by itself (like a tap, but not the player's). */
    | { t: 'pushed'; podId: number; lane: number }
    /** Fill-first: a wave started; these lanes drain until none of them can. */
    | { t: 'waveStarted'; lanes: number[] }
    /** Fill-first: no lane of the wave can drain any more; the next wave waits for the lanes to fill. */
    | { t: 'waveEnded' }
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
 * - `held`: fill-first pod with something reachable that is not part of the running wave (drains in the next one).
 */
export type LaneStatus = 'draining' | 'stalled' | 'waiting' | 'held';

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
    /** Drops into a lane by itself once it reaches the front. */
    pushy: boolean;
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
    /** Fill-first level (lanes drain in waves). */
    fillFirst: boolean;
    /** Fill-first: a wave is running. Always true on other levels. */
    wave: boolean;
    won: boolean;
    dead: boolean;
    /** Ticks run since level start. */
    ticks: number;
}
