/**
 * FLOW rules engine. Implements PLAN.md "Canonical game rules" exactly; deterministic and allocation-light.
 *
 * Pushy pods (rules v2): a pushy pod at the front of its column takes a free lane by itself, exactly as if tapped.
 * The drop happens inside the action that made it possible, before the player can act again:
 * - at level start (sims are built with any pushy fronts already dropped),
 * - at the end of a `tap()` (the tapped pod exposed a pushy pod, and a lane is still free),
 * - at the end of a tick, right after completed pods free their lanes.
 * Several waiting pushy pods take free lanes lowest column first; a dropped pod can expose another pushy pod,
 * which drops too while lanes remain. So between actions no pushy pod ever sits at a front while a lane is free:
 * tapping one is legal by the normal rules, but it only waits at the front when every lane is busy (`noLane`).
 * The drop is a pure function of the state, so the hash needs no extra feature and settled play models it exactly.
 *
 * Fill-first lanes (rules v3, `LevelData.fillFirst`): lanes drain in waves. Pods in lanes only drain while they are
 * part of the running wave. A wave starts when no wave runs, some pod in a lane can drain, and the player has no
 * legal tap (every lane is full, or nothing in the queue can go in); all pods in lanes at that moment join it.
 * Pods tapped while a wave runs are `held` until the next one. The wave ends at the end of the tick where none of
 * its pods can drain any more (all complete or stalled); the next wave may start in that same tick.
 * In settled play a wave always ends before the next tap, so the solver sees "fill every lane, then drain".
 *
 * Used by the game (via `gameFacade`, ticks on a clock, taps any time) and by the generator/solver
 * (`clone()` → `tap()` → `settle()`, memo on `hashKey()`).
 */
import type {
    KeyView,
    LaneState,
    LaneStatus,
    LevelData,
    Point,
    PodState,
    SimEvent,
    TapDenial,
    ViewState,
} from './types';
import { EMPTY } from './types';
import type { CompiledLevel } from './level';
import { compileLevel } from './level';
import { buildColorLists, removeFromColorList } from './grid';
import { INF, buildDist, relaxOpened, tracePath } from './reach';
import { TAG_HEAD, TAG_KEY, TAG_LANE, TAG_WAVE, toBigHash, toNumberHash } from './hash';

export interface SimOptions {
    /** Compute exit paths on `claimed` events (the game wants them, the solver doesn't). Default false. */
    emitPaths?: boolean;
    /** Build event arrays. Set false in the solver: every method then returns a shared empty array. Default true. */
    events?: boolean;
}

const NO_EVENTS: SimEvent[] = Object.freeze([]) as unknown as SimEvent[];
const NO_PATH: Point[] = Object.freeze([]) as unknown as Point[];

export class Sim {
    /** Static per-level tables, shared by clones. */
    readonly compiled: CompiledLevel;
    private emitPaths: boolean;
    private emitEvents: boolean;
    /** Static: start slot of each color in `colorList`. */
    private colorOff: Int32Array;

    private cells: Uint8Array;
    private colorList: Int32Array;
    private colorPos: Int32Array;
    private colorCount: Int32Array;
    private dist: Int16Array;
    private colHead: Int32Array;
    private lanePod: Int32Array;
    private laneRem: Int32Array;
    /** Fill-first: 1 = the lane's pod is part of the running wave. */
    private laneWave: Uint8Array;
    /** Fill-first: a wave is running. */
    private waveOn: boolean;
    private podRevealed: Uint8Array;
    private keyCollected: Uint8Array;
    private cellsLeft: number;
    private hA: number;
    private hB: number;
    private tickCount: number;
    private wonEmitted: boolean;
    private deadEmitted: boolean;

    private constructor(compiled: CompiledLevel, opts: SimOptions) {
        this.compiled = compiled;
        this.emitPaths = opts.emitPaths ?? false;
        this.emitEvents = opts.events ?? true;
    }

    static fromLevel(level: LevelData, opts: SimOptions = {}): Sim {
        return Sim.fromCompiled(compileLevel(level), opts);
    }

    /** Build from an already-compiled level (compile once, start many sims — e.g. generator rollouts). */
    static fromCompiled(compiled: CompiledLevel, opts: SimOptions = {}): Sim {
        const s = new Sim(compiled, opts);
        const { n, numColors, numCols, numLanes, numPods, numKeys, width, height } = compiled;
        s.cells = compiled.cells.slice();
        const lists = buildColorLists(s.cells, numColors);
        s.colorOff = lists.offset;
        s.colorList = lists.list;
        s.colorPos = lists.pos;
        s.colorCount = lists.count;
        s.dist = new Int16Array(numColors * n);
        for (let c = 0; c < numColors; c++) {
            buildDist(s.cells, width, height, c, s.dist, c * n, compiled.queue);
        }
        s.colHead = new Int32Array(numCols);
        s.lanePod = new Int32Array(numLanes).fill(-1);
        s.laneRem = new Int32Array(numLanes);
        s.laneWave = new Uint8Array(numLanes);
        s.waveOn = false;
        s.podRevealed = new Uint8Array(numPods);
        s.keyCollected = new Uint8Array(numKeys);
        let left = 0;
        for (let i = 0; i < n; i++) if (s.cells[i] !== EMPTY) left++;
        s.cellsLeft = left;
        s.hA = 0;
        s.hB = 0;
        for (let col = 0; col < numCols; col++) s.xorHead(col, 0);
        s.tickCount = 0;
        s.wonEmitted = false;
        s.deadEmitted = false;
        for (let col = 0; col < numCols; col++) s.revealFront(col, null);
        s.dropPushy(null);
        s.updateWave(null);
        return s;
    }

    /** Independent copy (typed-array copies; static tables are shared). */
    clone(): Sim {
        const s = new Sim(this.compiled, { emitPaths: this.emitPaths, events: this.emitEvents });
        s.colorOff = this.colorOff;
        s.cells = this.cells.slice();
        s.colorList = this.colorList.slice();
        s.colorPos = this.colorPos.slice();
        s.colorCount = this.colorCount.slice();
        s.dist = this.dist.slice();
        s.colHead = this.colHead.slice();
        s.lanePod = this.lanePod.slice();
        s.laneRem = this.laneRem.slice();
        s.laneWave = this.laneWave.slice();
        s.waveOn = this.waveOn;
        s.podRevealed = this.podRevealed.slice();
        s.keyCollected = this.keyCollected.slice();
        s.cellsLeft = this.cellsLeft;
        s.hA = this.hA;
        s.hB = this.hB;
        s.tickCount = this.tickCount;
        s.wonEmitted = this.wonEmitted;
        s.deadEmitted = this.deadEmitted;
        return s;
    }

    // ---------------------------------------------------------------- queries

    get width(): number {
        return this.compiled.width;
    }

    get height(): number {
        return this.compiled.height;
    }

    get columnCount(): number {
        return this.compiled.numCols;
    }

    get laneCount(): number {
        return this.compiled.numLanes;
    }

    /** Colored cells still on the board. */
    get cellsRemaining(): number {
        return this.cellsLeft;
    }

    /** Ticks run since level start. */
    get ticks(): number {
        return this.tickCount;
    }

    /** Cell color at (x, y), or `EMPTY` (255). */
    cellAt(x: number, y: number): number {
        return this.cells[y * this.compiled.width + x];
    }

    /** `dist_c` at (x, y); `INF` (0x7fff) when unreachable / impassable. Stale for colors with no cells left. */
    distAt(color: number, x: number, y: number): number {
        const { width, n } = this.compiled;
        return this.dist[color * n + y * width + x];
    }

    /** Copy of the full distance map for one color (tests/debug). */
    distMap(color: number): Int16Array {
        const { n } = this.compiled;
        return this.dist.slice(color * n, (color + 1) * n);
    }

    /** Cells of `color` still on the board. */
    colorRemaining(color: number): number {
        return color < this.compiled.numColors ? this.colorCount[color] : 0;
    }

    /** Whether any cell of `color` is reachable right now. */
    hasReachable(color: number): boolean {
        if (color >= this.compiled.numColors) return false;
        const off = this.colorOff[color];
        const end = off + this.colorCount[color];
        const base = color * this.compiled.n;
        for (let s = off; s < end; s++) {
            if (this.dist[base + this.colorList[s]] !== INF) return true;
        }
        return false;
    }

    /** Number of reachable cells of `color` right now. */
    reachableCount(color: number): number {
        if (color >= this.compiled.numColors) return 0;
        const off = this.colorOff[color];
        const end = off + this.colorCount[color];
        const base = color * this.compiled.n;
        let count = 0;
        for (let s = off; s < end; s++) {
            if (this.dist[base + this.colorList[s]] !== INF) count++;
        }
        return count;
    }

    freeLaneCount(): number {
        let free = 0;
        for (let l = 0; l < this.compiled.numLanes; l++) if (this.lanePod[l] < 0) free++;
        return free;
    }

    /** Id of the front pod of `column`, or -1 if the column is empty. */
    frontPodId(column: number): number {
        const p = this.frontIndex(column);
        return p < 0 ? -1 : this.compiled.podId[p];
    }

    /** True color of the front pod (ignores hidden/locked — the solver is omniscient), or -1. */
    frontColor(column: number): number {
        const p = this.frontIndex(column);
        return p < 0 ? -1 : this.compiled.podColor[p];
    }

    /** Capacity of the front pod, or -1. */
    frontCapacity(column: number): number {
        const p = this.frontIndex(column);
        return p < 0 ? -1 : this.compiled.podCap[p];
    }

    /** Pods still queued in `column`. */
    columnLength(column: number): number {
        const { colOff } = this.compiled;
        return colOff[column + 1] - colOff[column] - this.colHead[column];
    }

    /** Why tapping `column` is illegal right now, or null if it is legal. */
    tapReason(column: number): TapDenial | null {
        if (!Number.isInteger(column) || column < 0 || column >= this.compiled.numCols) return 'empty';
        const p = this.frontIndex(column);
        if (p < 0) return 'empty';
        const k = this.compiled.podLock[p];
        if (k >= 0 && this.keyCollected[k] === 0) return 'locked';
        const q = this.compiled.podLink[p];
        const free = this.freeLaneCount();
        if (q < 0) return free >= 1 ? null : 'noLane';
        if (!this.partnerAvailable(p, q)) return 'partnerUnavailable';
        return free >= 2 ? null : 'noLane';
    }

    canTap(column: number): boolean {
        return this.tapReason(column) === null;
    }

    /** Column indices with a legal tap, ascending. */
    legalTaps(): number[] {
        const out: number[] = [];
        for (let col = 0; col < this.compiled.numCols; col++) {
            if (this.tapReason(col) === null) out.push(col);
        }
        return out;
    }

    hasLegalTap(): boolean {
        if (this.freeLaneCount() === 0) return false;
        for (let col = 0; col < this.compiled.numCols; col++) {
            if (this.tapReason(col) === null) return true;
        }
        return false;
    }

    /** No active pod can claim anything this tick (fill-first: no pod of the running wave). */
    isSettled(): boolean {
        for (let l = 0; l < this.compiled.numLanes; l++) {
            if (this.laneDrains(l) && this.laneCanDrain(l)) return false;
        }
        return true;
    }

    /** Fill-first: a wave is running. Always true on other levels. */
    get waveRunning(): boolean {
        return !this.compiled.fillFirst || this.waveOn;
    }

    isWon(): boolean {
        return this.cellsLeft === 0;
    }

    /** Settled, no legal tap, board not empty. */
    isDead(): boolean {
        if (this.cellsLeft === 0) return false;
        return this.isSettled() && !this.hasLegalTap();
    }

    /** 64-bit Zobrist hash as a bigint (spec API). Slower; prefer `hashKey()` for memo sets. */
    hash(): bigint {
        return toBigHash(this.hA, this.hB);
    }

    /** 53-bit Zobrist hash as a safe-integer number. O(1), no allocation. Use this for the solver's `Set<number>`. */
    hashKey(): number {
        return toNumberHash(this.hA, this.hB);
    }

    /** Recompute the hash from scratch (tests/debug: must equal `hash()`). */
    hashFromScratch(): bigint {
        const { zobrist, numCols, numLanes, numKeys, n, cells: initial } = this.compiled;
        let a = 0;
        let b = 0;
        for (let i = 0; i < n; i++) {
            if (initial[i] === EMPTY || this.cells[i] !== EMPTY) continue;
            a ^= zobrist.cellA[i];
            b ^= zobrist.cellB[i];
        }
        for (let col = 0; col < numCols; col++) {
            a ^= zobrist.featureA(TAG_HEAD, col, this.colHead[col]);
            b ^= zobrist.featureB(TAG_HEAD, col, this.colHead[col]);
        }
        for (let l = 0; l < numLanes; l++) {
            const p = this.lanePod[l];
            if (p < 0) continue;
            a ^= zobrist.featureA(TAG_LANE, (l << 16) | p, this.laneRem[l]);
            b ^= zobrist.featureB(TAG_LANE, (l << 16) | p, this.laneRem[l]);
        }
        for (let k = 0; k < numKeys; k++) {
            if (this.keyCollected[k] === 0) continue;
            a ^= zobrist.featureA(TAG_KEY, k, 0);
            b ^= zobrist.featureB(TAG_KEY, k, 0);
        }
        for (let l = 0; l < numLanes; l++) {
            if (this.laneWave[l] === 0) continue;
            a ^= zobrist.featureA(TAG_WAVE, l, 0);
            b ^= zobrist.featureB(TAG_WAVE, l, 0);
        }
        return toBigHash(a, b);
    }

    // ---------------------------------------------------------------- actions

    /** Apply a tap on `column`. Throws if illegal (check `tapReason` / `legalTaps` first). */
    tap(column: number): SimEvent[] {
        const reason = this.tapReason(column);
        if (reason !== null) throw new Error(`Illegal tap on column ${column}: ${reason}`);
        const ev: SimEvent[] | null = this.emitEvents ? [] : null;
        const { podLink, podCol, podId } = this.compiled;
        const p = this.frontIndex(column);
        const q = podLink[p];
        const l1 = this.placeInFreeLane(p);
        this.advanceHead(column);
        if (q < 0) {
            ev?.push({ t: 'tapped', podIds: [podId[p]], lanes: [l1] });
            this.revealFront(column, ev);
            this.dropPushy(ev);
            this.updateWave(ev);
            return ev ?? NO_EVENTS;
        }
        const l2 = this.placeInFreeLane(q);
        const qc = podCol[q];
        this.advanceHead(qc);
        ev?.push({ t: 'tapped', podIds: [podId[p], podId[q]], lanes: [l1, l2] });
        this.revealFront(column, ev);
        if (qc !== column) this.revealFront(qc, ev);
        this.dropPushy(ev);
        this.updateWave(ev);
        return ev ?? NO_EVENTS;
    }

    /** One tick: each lane (left→right) claims one cell, then keys, completions, win/dead detection. */
    tick(): SimEvent[] {
        const ev: SimEvent[] | null = this.emitEvents ? [] : null;
        this.step(ev);
        return ev ?? NO_EVENTS;
    }

    /** Tick until a tick claims nothing. */
    settle(): SimEvent[] {
        const ev: SimEvent[] | null = this.emitEvents ? [] : null;
        while (this.step(ev)) {
            // keep ticking
        }
        return ev ?? NO_EVENTS;
    }

    /** Render view. Respects hidden/locked information. */
    snapshot(): ViewState {
        const c = this.compiled;
        const lanes: (LaneState | null)[] = [];
        for (let l = 0; l < c.numLanes; l++) {
            const p = this.lanePod[l];
            if (p < 0) {
                lanes.push(null);
                continue;
            }
            const q = c.podLink[p];
            lanes.push({
                podId: c.podId[p],
                color: c.podColor[p],
                capacity: c.podCap[p],
                remaining: this.laneRem[l],
                state: this.laneStatus(l),
                link: q < 0 ? null : c.podId[q],
            });
        }
        const columns: PodState[][] = [];
        for (let col = 0; col < c.numCols; col++) {
            const pods: PodState[] = [];
            for (let p = c.colOff[col] + this.colHead[col]; p < c.colOff[col + 1]; p++) pods.push(this.podView(p));
            columns.push(pods);
        }
        const keys: KeyView[] = [];
        for (let k = 0; k < c.numKeys; k++) {
            if (this.keyCollected[k] !== 0) continue;
            const cell = c.keyCell[k];
            keys.push({ id: c.keyId[k], x: cell % c.width, y: Math.floor(cell / c.width), podId: c.podId[c.keyPod[k]] });
        }
        const settled = this.isSettled();
        const won = this.cellsLeft === 0;
        return {
            width: c.width,
            height: c.height,
            cells: this.cells.slice(),
            keys,
            lanes,
            columns,
            settled,
            fillFirst: c.fillFirst,
            wave: this.waveRunning,
            won,
            dead: !won && settled && !this.hasLegalTap(),
            ticks: this.tickCount,
        };
    }

    // ---------------------------------------------------------------- internals

    private frontIndex(column: number): number {
        const { colOff } = this.compiled;
        const p = colOff[column] + this.colHead[column];
        return p < colOff[column + 1] ? p : -1;
    }

    /** Partner `q` of front pod `p` is at the front of another column or directly behind `p`. */
    private partnerAvailable(p: number, q: number): boolean {
        const { podCol, podPos } = this.compiled;
        const qc = podCol[q];
        if (qc === podCol[p]) return podPos[q] === podPos[p] + 1;
        return this.colHead[qc] === podPos[q];
    }

    private laneStatus(l: number): LaneStatus {
        if (this.laneRem[l] === 0) return 'waiting';
        if (!this.hasReachable(this.compiled.podColor[this.lanePod[l]])) return 'stalled';
        return this.laneDrains(l) ? 'draining' : 'held';
    }

    /** The lane's pod has room left and something of its color is reachable. */
    private laneCanDrain(l: number): boolean {
        const p = this.lanePod[l];
        return p >= 0 && this.laneRem[l] > 0 && this.hasReachable(this.compiled.podColor[p]);
    }

    /** The lane may claim cells this tick (fill-first: only lanes of the running wave). */
    private laneDrains(l: number): boolean {
        return !this.compiled.fillFirst || this.laneWave[l] === 1;
    }

    /** Fill-first: end a wave none of whose pods can drain, then start the next if the player can't tap. */
    private updateWave(ev: SimEvent[] | null): void {
        const { fillFirst, numLanes } = this.compiled;
        if (!fillFirst) return;
        if (this.waveOn && !this.waveCanDrain()) this.endWave(ev);
        if (this.waveOn || this.hasLegalTap()) return;
        let any = false;
        for (let l = 0; l < numLanes && !any; l++) any = this.laneCanDrain(l);
        if (!any) return;
        const lanes: number[] = [];
        for (let l = 0; l < numLanes; l++) {
            if (this.lanePod[l] < 0) continue;
            this.setLaneWave(l, 1);
            lanes.push(l);
        }
        this.waveOn = true;
        ev?.push({ t: 'waveStarted', lanes });
    }

    private waveCanDrain(): boolean {
        for (let l = 0; l < this.compiled.numLanes; l++) {
            if (this.laneWave[l] === 1 && this.laneCanDrain(l)) return true;
        }
        return false;
    }

    private endWave(ev: SimEvent[] | null): void {
        for (let l = 0; l < this.compiled.numLanes; l++) this.setLaneWave(l, 0);
        this.waveOn = false;
        ev?.push({ t: 'waveEnded' });
    }

    private setLaneWave(l: number, v: number): void {
        if (this.laneWave[l] === v) return;
        this.laneWave[l] = v;
        const z = this.compiled.zobrist;
        this.hA ^= z.featureA(TAG_WAVE, l, 0);
        this.hB ^= z.featureB(TAG_WAVE, l, 0);
    }

    private podView(p: number): PodState {
        const c = this.compiled;
        const hidden = c.podHidden[p] === 1 && this.podRevealed[p] === 0;
        const k = c.podLock[p];
        const locked = k >= 0 && this.keyCollected[k] === 0;
        const q = c.podLink[p];
        const concealed = hidden || locked;
        return {
            id: c.podId[p],
            color: concealed ? null : c.podColor[p],
            capacity: concealed ? null : c.podCap[p],
            hidden,
            locked,
            lock: locked ? c.keyId[k] : null,
            link: q < 0 ? null : c.podId[q],
            pushy: c.podPushy[p] === 1,
        };
    }

    private placeInFreeLane(p: number): number {
        let l = 0;
        while (this.lanePod[l] >= 0) l++;
        const cap = this.compiled.podCap[p];
        this.lanePod[l] = p;
        this.laneRem[l] = cap;
        this.xorLane(l, p, cap);
        return l;
    }

    private advanceHead(column: number): void {
        const h = this.colHead[column];
        this.xorHead(column, h);
        this.colHead[column] = h + 1;
        this.xorHead(column, h + 1);
    }

    private revealFront(column: number, ev: SimEvent[] | null): void {
        const p = this.frontIndex(column);
        if (p < 0) return;
        if (this.compiled.podHidden[p] === 0 || this.podRevealed[p] === 1) return;
        this.podRevealed[p] = 1;
        ev?.push({ t: 'revealed', podId: this.compiled.podId[p] });
    }

    /** Pushy pods at column fronts take free lanes, lowest column first, until no lane is free or none waits. */
    private dropPushy(ev: SimEvent[] | null): void {
        const c = this.compiled;
        if (!c.hasPushy) return;
        while (this.freeLaneCount() > 0) {
            const col = this.pushyFrontColumn();
            if (col < 0) return;
            const p = this.frontIndex(col);
            const l = this.placeInFreeLane(p);
            this.advanceHead(col);
            ev?.push({ t: 'pushed', podId: c.podId[p], lane: l });
            this.revealFront(col, ev);
        }
    }

    /** Lowest column whose front pod is pushy, or -1. */
    private pushyFrontColumn(): number {
        const { numCols, podPushy } = this.compiled;
        for (let col = 0; col < numCols; col++) {
            const p = this.frontIndex(col);
            if (p >= 0 && podPushy[p] === 1) return col;
        }
        return -1;
    }

    private xorHead(column: number, head: number): void {
        const z = this.compiled.zobrist;
        this.hA ^= z.featureA(TAG_HEAD, column, head);
        this.hB ^= z.featureB(TAG_HEAD, column, head);
    }

    private xorLane(l: number, p: number, remaining: number): void {
        const z = this.compiled.zobrist;
        this.hA ^= z.featureA(TAG_LANE, (l << 16) | p, remaining);
        this.hB ^= z.featureB(TAG_LANE, (l << 16) | p, remaining);
    }

    /** Min reachable cell of `color` by `(dist, -y, x)`, or -1. */
    private pickNearest(color: number): number {
        const { n, orderKey } = this.compiled;
        const off = this.colorOff[color];
        const end = off + this.colorCount[color];
        const base = color * n;
        const list = this.colorList;
        const dist = this.dist;
        let best = -1;
        let bestKey = 0x7fffffff;
        for (let s = off; s < end; s++) {
            const i = list[s];
            const d = dist[base + i];
            if (d === INF) continue;
            const key = d * n + orderKey[i];
            if (key >= bestKey) continue;
            bestKey = key;
            best = i;
        }
        return best;
    }

    /** Empty cell `i`, update hash, color list, and other colors' distance maps immediately. */
    private removeCell(i: number): void {
        const c = this.compiled;
        const color = this.cells[i];
        this.cells[i] = EMPTY;
        removeFromColorList(this.colorList, this.colorPos, this.colorOff, this.colorCount, color, i);
        this.cellsLeft--;
        this.hA ^= c.zobrist.cellA[i];
        this.hB ^= c.zobrist.cellB[i];
        for (let d = 0; d < c.numColors; d++) {
            if (d === color || this.colorCount[d] === 0) continue;
            relaxOpened(this.cells, c.width, c.height, d, this.dist, d * c.n, i, c.queue);
        }
    }

    /** One tick. Returns true if any cell was claimed. */
    private step(ev: SimEvent[] | null): boolean {
        const c = this.compiled;
        this.tickCount++;
        let claimed = false;
        for (let l = 0; l < c.numLanes; l++) {
            const p = this.lanePod[l];
            if (p < 0 || this.laneRem[l] === 0 || !this.laneDrains(l)) continue;
            const color = c.podColor[p];
            const i = this.pickNearest(color);
            if (i < 0) continue;
            const path = ev !== null && this.emitPaths ? tracePath(this.dist, color * c.n, c.width, c.height, i) : NO_PATH;
            this.removeCell(i);
            const rem = this.laneRem[l];
            this.xorLane(l, p, rem);
            this.laneRem[l] = rem - 1;
            this.xorLane(l, p, rem - 1);
            claimed = true;
            const x = i % c.width;
            const y = (i - x) / c.width;
            ev?.push({ t: 'claimed', podId: c.podId[p], lane: l, x, y, color, path });
            this.collectKeyAt(i, x, y, ev);
        }
        if (claimed) {
            this.completePods(ev);
            this.dropPushy(ev);
        }
        this.updateWave(ev);
        if (this.cellsLeft === 0 && !this.wonEmitted) {
            this.wonEmitted = true;
            ev?.push({ t: 'won' });
        }
        // A fill-first wave may have just started (`updateWave`): then the board is not settled yet.
        if (!claimed && !this.deadEmitted && this.cellsLeft > 0 && !this.hasLegalTap() && this.isSettled()) {
            this.deadEmitted = true;
            ev?.push({ t: 'dead' });
        }
        return claimed;
    }

    private collectKeyAt(i: number, x: number, y: number, ev: SimEvent[] | null): void {
        const c = this.compiled;
        const k = c.keyAt[i];
        if (k < 0) return;
        // A cell is emptied exactly once, so its key cannot already be collected.
        this.keyCollected[k] = 1;
        this.hA ^= c.zobrist.featureA(TAG_KEY, k, 0);
        this.hB ^= c.zobrist.featureB(TAG_KEY, k, 0);
        const pod = c.podId[c.keyPod[k]];
        ev?.push({ t: 'keyCollected', keyId: c.keyId[k], x, y, podId: pod });
        ev?.push({ t: 'unlocked', podId: pod });
    }

    /** Free lanes of full pods; linked pods leave only together with a full partner. */
    private completePods(ev: SimEvent[] | null): void {
        const c = this.compiled;
        for (let l = 0; l < c.numLanes; l++) {
            const p = this.lanePod[l];
            if (p < 0 || this.laneRem[l] > 0) continue;
            const q = c.podLink[p];
            if (q < 0) {
                this.freeLane(l, p, ev);
                continue;
            }
            // Partners always enter together and only leave together, so q is in a lane to the right of l
            // (if it were to the left, the pair would already have completed when that lane was visited).
            const ql = this.laneOf(q);
            if (this.laneRem[ql] > 0) continue;
            this.freeLane(l, p, ev);
            this.freeLane(ql, q, ev);
        }
    }

    private laneOf(p: number): number {
        for (let l = 0; l < this.compiled.numLanes; l++) if (this.lanePod[l] === p) return l;
        return -1;
    }

    private freeLane(l: number, p: number, ev: SimEvent[] | null): void {
        this.xorLane(l, p, 0);
        this.lanePod[l] = -1;
        this.setLaneWave(l, 0);
        ev?.push({ t: 'podCompleted', podId: this.compiled.podId[p], lane: l });
    }
}
