/**
 * Generator-side level plumbing: the simplified board, the layout being searched (columns + lanes + keys +
 * solution), conversion to `LevelData`, and settled replay of a stored solution on the real `Sim`.
 */
import type { DifficultyStats, KeySpec, LevelData, PodSpec, SimEvent, ViewState } from '@game/types';
import { EMPTY } from '@game/types';
import { RULES_VERSION } from '@game/level';
import { cellColor, cellsToString } from '@game/grid';
import { Sim } from '@game/sim';

/** Bump whenever generator output for the same inputs changes (invalidates the gen:all cache). */
export const GENERATOR_VERSION = 'gen-3.6.0';

export interface Board {
    width: number;
    height: number;
    /** 255 = empty, else color index. */
    cells: Uint8Array;
    palette: string[];
    numColors: number;
    /** Cells per color. */
    counts: number[];
    /** Color indexes of the generated seals (outline ring, background; see `outline-ring.ts`), if the level has any. */
    seals?: number[];
}

/** The searchable part of a level. `columns[i][0]` is the front; `solution` lists the column tapped per step. */
export interface Layout {
    lanes: number;
    columns: PodSpec[][];
    keys: KeySpec[];
    solution: number[];
}

export const EMPTY_STATS: DifficultyStats = {
    randomWinRate: 0,
    greedyWinRate: 0,
    smartWinRate: 0,
    deadEndRatio: 0,
    minLanes: 0,
    branching: 0,
    hiddenShare: 0,
    lockCount: 0,
    pairCount: 0,
};

export function boardFromCells(width: number, height: number, cells: Uint8Array, palette: string[]): Board {
    let numColors = 0;
    for (const c of cells) if (c !== EMPTY && c + 1 > numColors) numColors = c + 1;
    const counts = new Array<number>(numColors).fill(0);
    for (const c of cells) if (c !== EMPTY) counts[c]++;
    return { width, height, cells, palette, numColors, counts };
}

/** Parse ASCII rows ('.' empty, base-36 characters = colors) into a board (tests, fixtures). */
export function boardFromAscii(ascii: string, palette: string[]): Board {
    const rows = ascii
        .split('\n')
        .map((r) => r.trim())
        .filter((r) => r.length > 0);
    const width = rows[0].length;
    const cells = new Uint8Array(width * rows.length);
    rows.forEach((row, y) => {
        for (let x = 0; x < width; x++) cells[y * width + x] = cellColor(row[x]);
    });
    return boardFromCells(width, rows.length, cells, palette);
}

export interface LevelInfo {
    id: string;
    name: string;
    tickMs?: number;
    seed?: number;
    targetDifficulty?: number;
    difficulty?: number;
    stats?: DifficultyStats;
    sourceHash?: string;
}

export function cloneLayout(layout: Layout): Layout {
    return {
        lanes: layout.lanes,
        columns: layout.columns.map((col) => col.map((p) => ({ ...p }))),
        keys: layout.keys.map((k) => ({ ...k })),
        solution: layout.solution.slice(),
    };
}

/** Build a full `LevelData` (keys sorted by id, pods emitted with a stable field order). */
export function toLevel(board: Board, layout: Layout, info: LevelInfo): LevelData {
    return {
        version: 1,
        rulesVersion: RULES_VERSION,
        id: info.id,
        name: info.name,
        width: board.width,
        height: board.height,
        palette: board.palette.slice(0, board.numColors),
        cells: cellsToString(board.cells),
        keys: layout.keys
            .slice()
            .sort((a, b) => a.id - b.id)
            .map((k) => ({ id: k.id, x: k.x, y: k.y })),
        lanes: layout.lanes,
        tickMs: info.tickMs ?? 60,
        columns: layout.columns.map((col) => col.map(normalizePod)),
        solution: layout.solution.slice(),
        meta: {
            seed: info.seed ?? 0,
            targetDifficulty: info.targetDifficulty ?? 0,
            difficulty: info.difficulty ?? 0,
            stats: info.stats ?? { ...EMPTY_STATS },
            generatorVersion: GENERATOR_VERSION,
            sourceHash: info.sourceHash ?? '',
        },
    };
}

function normalizePod(p: PodSpec): PodSpec {
    const out: PodSpec = { id: p.id, color: p.color, capacity: p.capacity };
    if (p.hidden) out.hidden = true;
    if (p.pushy) out.pushy = true;
    if (p.lock !== undefined) out.lock = p.lock;
    if (p.link !== undefined) out.link = p.link;
    return out;
}

export interface ReplayResult {
    won: boolean;
    /** Step index that failed (illegal tap), or -1. */
    failedAt: number;
    reason: string;
}

/** Settled replay of `level.solution` on the real sim. */
export function replay(level: LevelData): ReplayResult {
    let sim: Sim;
    try {
        sim = Sim.fromLevel(level, { events: false });
    } catch (e) {
        return { won: false, failedAt: -1, reason: (e as Error).message };
    }
    sim.settle();
    for (let s = 0; s < level.solution.length; s++) {
        const col = level.solution[s];
        const why = sim.tapReason(col);
        if (why !== null) return { won: false, failedAt: s, reason: `step ${s}: column ${col} ${why}` };
        sim.tap(col);
        sim.settle();
    }
    if (!sim.isWon()) return { won: false, failedAt: level.solution.length, reason: `${sim.cellsRemaining} cells left after the solution` };
    return { won: true, failedAt: -1, reason: '' };
}

export function hasPushy(layout: Layout): boolean {
    return layout.columns.some((col) => col.some((p) => p.pushy));
}

/**
 * Pods in the order they enter lanes when the solution is played (settled play). Partners of linked pairs follow
 * their tapped pod. Without pushy pods this is a pure walk of the solution; pushy pods enter whenever the board
 * frees a lane for them, so then the level is replayed on the real `Sim` (which needs the board) and the order is
 * read from its `tapped` / `pushed` events. Throws if the solution makes an illegal tap.
 */
export function laneEntryOrder(board: Board, layout: Layout): PodSpec[] {
    if (!hasPushy(layout)) return tappedPodOrder(layout);
    const byId = new Map<number, PodSpec>();
    layout.columns.forEach((col) => col.forEach((p) => byId.set(p.id, p)));
    const ids: number[] = [];
    const collect = (events: SimEvent[]) => {
        for (const e of events) {
            if (e.t === 'tapped') ids.push(...e.podIds);
            else if (e.t === 'pushed') ids.push(e.podId);
        }
    };
    const sim = Sim.fromLevel(toLevel(board, layout, { id: 'order', name: 'order' }), { events: true });
    // Pushy pods at a front at level start dropped while the sim was built (lowest lane first = drop order).
    for (const lane of sim.snapshot().lanes) if (lane !== null) ids.push(lane.podId);
    collect(sim.settle());
    layout.solution.forEach((col, s) => {
        const why = sim.tapReason(col);
        if (why !== null) throw new Error(`laneEntryOrder: step ${s}: column ${col} ${why}`);
        collect(sim.tap(col));
        collect(sim.settle());
    });
    const seen = new Set(ids);
    // A winning solution places every pod; anything left (a losing solution) goes last in column order.
    layout.columns.forEach((col) => col.forEach((p) => {
        if (!seen.has(p.id)) ids.push(p.id);
    }));
    return ids.map((id) => byId.get(id)!);
}

/** Pods the solution taps, in tap order (partners follow their tapped pod). Ignores pushy drops. */
function tappedPodOrder(layout: Layout): PodSpec[] {
    const heads = layout.columns.map(() => 0);
    const byId = new Map<number, { col: number }>();
    layout.columns.forEach((col, c) => col.forEach((p) => byId.set(p.id, { col: c })));
    const out: PodSpec[] = [];
    for (const c of layout.solution) {
        const p = layout.columns[c][heads[c]++];
        out.push(p);
        if (p.link === undefined) continue;
        const qc = byId.get(p.link)!.col;
        out.push(layout.columns[qc][heads[qc]++]);
    }
    return out;
}

/** One frame of the solution replay, for the HTML report. */
export interface TraceFrame {
    step: number;
    /** Column tapped to reach this frame (-1 for the initial frame). */
    tapped: number;
    /** Pushy pods that dropped into lanes by themselves during this step (tap + settle), in drop order. */
    pushed: number[];
    cells: string;
    lanes: ({ podId: number; color: number; capacity: number; remaining: number; state: string; link: number | null } | null)[];
    columns: {
        id: number;
        color: number;
        capacity: number;
        hidden: boolean;
        locked: boolean;
        lock: number | null;
        link: number | null;
        pushy: boolean;
    }[][];
    keys: { id: number; x: number; y: number; podId: number }[];
    /** Cells drained by this step's settle. */
    drained: number;
    won: boolean;
    dead: boolean;
}

export interface Trace {
    frames: TraceFrame[];
    /** Solution step whose settle drained each cell (-1 = never / empty). Step s = after the s-th tap; -1 for the initial settle too. */
    drainStep: Int32Array;
    /** Free lanes just before each solution tap. */
    freeBefore: number[];
    /** Occupied (stalled) lanes after each step's settle. */
    stalledAfter: number[];
    /** Legal taps just before each solution tap. */
    legalBefore: number[];
    /**
     * Whether a pod that entered a lane at each step stalled (did not complete in that step's settle). Counts the
     * tapped pod(s) and any pushy pods that dropped during the step: a pushy pod that stalls is lane pressure too.
     */
    stalledPod: boolean[];
}

function frameOf(view: ViewState, step: number, tapped: number, pushed: number[], drained: number): TraceFrame {
    const cells = cellsToString(view.cells);
    return {
        step,
        tapped,
        pushed,
        cells,
        lanes: view.lanes.map((l) =>
            l === null ? null : { podId: l.podId, color: l.color, capacity: l.capacity, remaining: l.remaining, state: l.state, link: l.link },
        ),
        columns: view.columns.map((col) =>
            col.map((p) => ({
                id: p.id,
                color: p.color ?? -1,
                capacity: p.capacity ?? -1,
                hidden: p.hidden,
                locked: p.locked,
                lock: p.lock,
                link: p.link,
                pushy: p.pushy,
            })),
        ),
        keys: view.keys.map((k) => ({ id: k.id, x: k.x, y: k.y, podId: k.podId })),
        drained,
        won: view.won,
        dead: view.dead,
    };
}

/** Ids of pods that entered lanes in `events`: tapped (with linked partners) and pushed. */
function enteredIds(events: SimEvent[], into: { entered: number[]; pushed: number[] }): void {
    for (const e of events) {
        if (e.t === 'tapped') into.entered.push(...e.podIds);
        if (e.t !== 'pushed') continue;
        into.entered.push(e.podId);
        into.pushed.push(e.podId);
    }
}

/**
 * Replay the solution with events, recording per-step data used by mechanics placement and the report.
 * `withFrames` false skips the (allocating) snapshots.
 */
export function traceSolution(level: LevelData, withFrames: boolean): Trace {
    const sim = Sim.fromLevel(level, { events: true });
    const n = level.width * level.height;
    const drainStep = new Int32Array(n).fill(-1);
    const frames: TraceFrame[] = [];
    const freeBefore: number[] = [];
    const stalledAfter: number[] = [];
    const legalBefore: number[] = [];
    const stalledPod: boolean[] = [];
    const record = (events: SimEvent[], step: number): number => {
        let drained = 0;
        for (const e of events) {
            if (e.t !== 'claimed') continue;
            drainStep[e.y * level.width + e.x] = step;
            drained++;
        }
        return drained;
    };
    // Pushy pods at a front at level start are already in lanes when the sim is built.
    const startPushed = sim.snapshot().lanes.flatMap((l) => (l === null ? [] : [l.podId]));
    const startEvents = sim.settle();
    const start = { entered: [] as number[], pushed: startPushed };
    enteredIds(startEvents, start);
    const initial = record(startEvents, -1);
    if (withFrames) frames.push(frameOf(sim.snapshot(), 0, -1, start.pushed, initial));
    level.solution.forEach((col, s) => {
        freeBefore.push(sim.freeLaneCount());
        legalBefore.push(sim.legalTaps().length);
        const step = { entered: [] as number[], pushed: [] as number[] };
        enteredIds(sim.tap(col), step);
        const events = sim.settle();
        enteredIds(events, step);
        const drained = record(events, s);
        const completed = new Set<number>();
        for (const e of events) if (e.t === 'podCompleted') completed.add(e.podId);
        stalledPod.push(step.entered.some((id) => !completed.has(id)));
        stalledAfter.push(sim.laneCount - sim.freeLaneCount());
        if (withFrames) frames.push(frameOf(sim.snapshot(), s + 1, col, step.pushed, drained));
    });
    return { frames, drainStep, freeBefore, stalledAfter, legalBefore, stalledPod };
}

/** Pod count per column summary, e.g. "5/4/5". */
export function columnSummary(layout: Layout): string {
    return layout.columns.map((c) => c.length).join('/');
}

export function podCount(layout: Layout): number {
    return layout.columns.reduce((s, c) => s + c.length, 0);
}
