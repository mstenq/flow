/** Validate `LevelData` and compile it into the static tables the sim shares across clones. */
import type { LevelData, PodSpec } from './types';
import { EMPTY } from './types';
import { parseCells } from './grid';
import { Zobrist } from './hash';

/** Bump when sim rules change; `bun run verify` re-checks levels. */
export const RULES_VERSION = 4;
/** Largest supported board dimension (the generator reads PNGs up to this size too). Bigger boards are too small to read. */
export const MAX_DIM = 64;
/** Cell strings encode colors as one base-36 character (see `CELL_CHARS` in grid.ts). */
export const MAX_COLORS = 36;

export class LevelError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LevelError';
    }
}

/** Static, immutable per-level tables. Shared by every clone of a `Sim`. */
export interface CompiledLevel {
    level: LevelData;
    width: number;
    height: number;
    n: number;
    numColors: number;
    numCols: number;
    numLanes: number;
    numPods: number;
    numKeys: number;
    /** Initial board. */
    cells: Uint8Array;
    /** Drain tie-break order: `(height-1-y) × width + x` (smaller = bottom row first, then left). */
    orderKey: Int32Array;
    /** Key index on each cell, -1 = none. */
    keyAt: Int16Array;
    keyId: Int32Array;
    keyCell: Int32Array;
    /** Pod index unlocked by each key. */
    keyPod: Int32Array;
    podId: Int32Array;
    podColor: Uint8Array;
    podCap: Int32Array;
    podHidden: Uint8Array;
    /** 1 = pushy (drops into a free lane by itself at the front of its column). */
    podPushy: Uint8Array;
    /** Any pushy pod in the level (lets the sim skip the auto-drop scan). */
    hasPushy: boolean;
    /** Key index locking each pod, -1 = none. */
    podLock: Int16Array;
    /** Partner pod index, -1 = none. */
    podLink: Int32Array;
    podCol: Int32Array;
    podPos: Int32Array;
    podIndex: Map<number, number>;
    /** Pods are indexed in column order: column i holds pod indices `colOff[i] .. colOff[i+1]-1`, front first. */
    colOff: Int32Array;
    zobrist: Zobrist;
    /** Shared BFS scratch (sim is single-threaded). */
    queue: Int32Array;
}

function isInt(v: unknown): v is number {
    return typeof v === 'number' && Number.isInteger(v);
}

/** Throws `LevelError` with a clear message if `level` breaks any structural rule. */
export function validateLevel(level: LevelData): void {
    const id = typeof level?.id === 'string' ? level.id : '?';
    const fail = (msg: string): never => {
        throw new LevelError(`Level "${id}": ${msg}`);
    };

    if (level.version !== 1) fail(`unsupported version ${String(level.version)} (expected 1)`);
    if (!isInt(level.rulesVersion)) fail('rulesVersion must be an integer');
    const { width, height } = level;
    if (!isInt(width) || width < 1 || width > MAX_DIM) fail(`width must be an integer in 1..${MAX_DIM}, got ${width}`);
    if (!isInt(height) || height < 1 || height > MAX_DIM) fail(`height must be an integer in 1..${MAX_DIM}, got ${height}`);
    if (typeof level.cells !== 'string') fail('cells must be a string');
    if (!Array.isArray(level.palette)) fail('palette must be an array');
    if (!isInt(level.lanes) || level.lanes < 1) fail(`lanes must be an integer >= 1, got ${level.lanes}`);
    if (typeof level.tickMs !== 'number' || !(level.tickMs > 0)) fail(`tickMs must be > 0, got ${level.tickMs}`);
    if (!Array.isArray(level.columns) || level.columns.length < 1) fail('columns must be a non-empty array');
    if (!Array.isArray(level.keys)) fail('keys must be an array');

    let cells: Uint8Array = new Uint8Array(0);
    try {
        cells = parseCells(level.cells, width, height);
    } catch (e) {
        fail((e as Error).message);
    }

    const paletteSize = Math.min(level.palette.length, MAX_COLORS);
    const cellCount = new Array<number>(MAX_COLORS).fill(0);
    let total = 0;
    for (let i = 0; i < cells.length; i++) {
        const c = cells[i];
        if (c === EMPTY) continue;
        if (c >= paletteSize) fail(`cell (${i % width}, ${Math.floor(i / width)}) uses color ${c} but palette has ${level.palette.length} entries`);
        cellCount[c]++;
        total++;
    }
    if (total === 0) fail('board has no colored cells');

    const pods = new Map<number, { pod: PodSpec; col: number; pos: number }>();
    const capTotal = new Array<number>(MAX_COLORS).fill(0);
    let hasLink = false;
    level.columns.forEach((column, col) => {
        if (!Array.isArray(column)) fail(`column ${col} must be an array`);
        column.forEach((pod, pos) => {
            const where = `pod at column ${col} position ${pos}`;
            if (!isInt(pod?.id)) fail(`${where} has a non-integer id`);
            if (pods.has(pod.id)) fail(`duplicate pod id ${pod.id}`);
            if (!isInt(pod.color) || pod.color < 0 || pod.color >= paletteSize) fail(`pod ${pod.id} has invalid color ${pod.color}`);
            if (!isInt(pod.capacity) || pod.capacity < 1) fail(`pod ${pod.id} capacity must be an integer >= 1, got ${pod.capacity}`);
            if (pod.hidden !== undefined && pod.hidden !== true) fail(`pod ${pod.id} hidden must be true or absent`);
            if (pod.pushy !== undefined && pod.pushy !== true) fail(`pod ${pod.id} pushy must be true or absent`);
            if (pod.lock !== undefined && !isInt(pod.lock)) fail(`pod ${pod.id} lock must be an integer key id`);
            if (pod.link !== undefined && !isInt(pod.link)) fail(`pod ${pod.id} link must be an integer pod id`);
            const mechanics =
                (pod.hidden ? 1 : 0) + (pod.lock !== undefined ? 1 : 0) + (pod.link !== undefined ? 1 : 0) + (pod.pushy ? 1 : 0);
            if (mechanics > 1) fail(`pod ${pod.id} combines mechanics (at most one of hidden/lock/link/pushy)`);
            if (pod.link !== undefined) hasLink = true;
            pods.set(pod.id, { pod, col, pos });
            capTotal[pod.color] += pod.capacity;
        });
    });

    for (let c = 0; c < MAX_COLORS; c++) {
        if (capTotal[c] === cellCount[c]) continue;
        fail(`color ${c}: pod capacities total ${capTotal[c]} but the board has ${cellCount[c]} cells`);
    }

    const keyIds = new Set<number>();
    const keyCells = new Set<number>();
    const lockers = new Map<number, number>();
    for (const { pod } of pods.values()) {
        if (pod.lock === undefined) continue;
        if (lockers.has(pod.lock)) fail(`key ${pod.lock} locks more than one pod (${lockers.get(pod.lock)} and ${pod.id})`);
        lockers.set(pod.lock, pod.id);
    }
    for (const key of level.keys) {
        if (!isInt(key?.id)) fail('key has a non-integer id');
        if (keyIds.has(key.id)) fail(`duplicate key id ${key.id}`);
        keyIds.add(key.id);
        if (!isInt(key.x) || !isInt(key.y) || key.x < 0 || key.y < 0 || key.x >= width || key.y >= height) {
            fail(`key ${key.id} position (${key.x}, ${key.y}) is outside the board`);
        }
        const cell = key.y * width + key.x;
        if (cells[cell] === EMPTY) fail(`key ${key.id} sits on empty cell (${key.x}, ${key.y})`);
        if (keyCells.has(cell)) fail(`more than one key on cell (${key.x}, ${key.y})`);
        keyCells.add(cell);
        if (!lockers.has(key.id)) fail(`key ${key.id} does not unlock any pod`);
    }
    for (const [keyId, podId] of lockers) {
        if (!keyIds.has(keyId)) fail(`pod ${podId} is locked by missing key ${keyId}`);
    }

    for (const { pod, col, pos } of pods.values()) {
        if (pod.link === undefined) continue;
        if (pod.link === pod.id) fail(`pod ${pod.id} links to itself`);
        const partner = pods.get(pod.link);
        if (!partner) fail(`pod ${pod.id} links to missing pod ${pod.link}`);
        if (partner!.pod.link !== pod.id) fail(`link is not symmetric: pod ${pod.id} → ${pod.link} but pod ${pod.link} → ${String(partner!.pod.link)}`);
        if (partner!.col === col && Math.abs(partner!.pos - pos) !== 1) {
            fail(`linked pods ${pod.id} and ${pod.link} share column ${col} but are not adjacent`);
        }
    }
    if (hasLink && level.lanes < 2) fail('level has linked pods but fewer than 2 lanes');

    if (!Array.isArray(level.solution)) fail('solution must be an array');
    for (const step of level.solution) {
        if (!isInt(step) || step < 0 || step >= level.columns.length) fail(`solution step ${step} is not a valid column`);
    }
}

/** Validate and build the static tables for `Sim`. */
export function compileLevel(level: LevelData): CompiledLevel {
    validateLevel(level);
    const { width, height } = level;
    const n = width * height;
    const cells = parseCells(level.cells, width, height);

    let numColors = 0;
    for (let i = 0; i < n; i++) {
        if (cells[i] !== EMPTY && cells[i] + 1 > numColors) numColors = cells[i] + 1;
    }

    const orderKey = new Int32Array(n);
    for (let i = 0; i < n; i++) {
        const x = i % width;
        const y = (i - x) / width;
        orderKey[i] = (height - 1 - y) * width + x;
    }

    const numCols = level.columns.length;
    let numPods = 0;
    for (const column of level.columns) numPods += column.length;

    const podId = new Int32Array(numPods);
    const podColor = new Uint8Array(numPods);
    const podCap = new Int32Array(numPods);
    const podHidden = new Uint8Array(numPods);
    const podPushy = new Uint8Array(numPods);
    let hasPushy = false;
    const podLock = new Int16Array(numPods).fill(-1);
    const podLink = new Int32Array(numPods).fill(-1);
    const podCol = new Int32Array(numPods);
    const podPos = new Int32Array(numPods);
    const podIndex = new Map<number, number>();
    const colOff = new Int32Array(numCols + 1);

    let p = 0;
    level.columns.forEach((column, col) => {
        colOff[col] = p;
        column.forEach((pod, pos) => {
            podId[p] = pod.id;
            podColor[p] = pod.color;
            podCap[p] = pod.capacity;
            podHidden[p] = pod.hidden ? 1 : 0;
            podPushy[p] = pod.pushy ? 1 : 0;
            if (pod.pushy) hasPushy = true;
            podCol[p] = col;
            podPos[p] = pos;
            podIndex.set(pod.id, p);
            p++;
        });
    });
    colOff[numCols] = p;

    const numKeys = level.keys.length;
    const keyAt = new Int16Array(n).fill(-1);
    const keyId = new Int32Array(numKeys);
    const keyCell = new Int32Array(numKeys);
    const keyPod = new Int32Array(numKeys);
    const keyIndex = new Map<number, number>();
    level.keys.forEach((key, k) => {
        const cell = key.y * width + key.x;
        keyAt[cell] = k;
        keyId[k] = key.id;
        keyCell[k] = cell;
        keyIndex.set(key.id, k);
    });

    level.columns.forEach((column) => {
        for (const pod of column) {
            const idx = podIndex.get(pod.id)!;
            if (pod.link !== undefined) podLink[idx] = podIndex.get(pod.link)!;
            if (pod.lock === undefined) continue;
            const k = keyIndex.get(pod.lock)!;
            podLock[idx] = k;
            keyPod[k] = idx;
        }
    });

    return {
        level,
        width,
        height,
        n,
        numColors,
        numCols,
        numLanes: level.lanes,
        numPods,
        numKeys,
        cells,
        orderKey,
        keyAt,
        keyId,
        keyCell,
        keyPod,
        podId,
        podColor,
        podCap,
        podHidden,
        podPushy,
        hasPushy,
        podLock,
        podLink,
        podCol,
        podPos,
        podIndex,
        colOff,
        zobrist: new Zobrist(width, height, numPods),
        queue: new Int32Array(n),
    };
}
