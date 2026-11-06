/**
 * Minimal mirror of the sim's settled-play rules for construction, where pods are invented on the fly
 * (the real `Sim` needs every pod up front). Same tick semantics: lanes left→right each claim the nearest
 * reachable cell by `(dist, -y, x)`, other colors' distances update immediately, full pods free their lane.
 * No keys, links or pushy pods: mechanics are placed afterwards and every result is replayed on the real `Sim`.
 *
 * Wave mode mirrors fill-first lanes (`LevelData.fillFirst`) in settled play: `settle()` only drains once every lane
 * is full, or once no cell is left unassigned (nothing more will be tapped: the sim's endgame release). All pods in
 * lanes then drain together until none can, so the wave always ends inside the settle.
 */
import { EMPTY } from '@game/types';
import { INF, buildDist, relaxOpened } from '@game/reach';
import { buildColorLists, removeFromColorList } from '@game/grid';
import type { Board } from './board.ts';

interface Statics {
    width: number;
    height: number;
    n: number;
    numColors: number;
    numLanes: number;
    /** Fill-first: drain in waves. */
    waves: boolean;
    orderKey: Int32Array;
    colorOff: Int32Array;
    queue: Int32Array;
}

export class PlaySim {
    private s: Statics;
    cells: Uint8Array;
    private list: Int32Array;
    private pos: Int32Array;
    count: Int32Array;
    private dist: Int16Array;
    laneColor: Int32Array;
    laneRem: Int32Array;
    /** Wave mode: 1 = the lane's pod went through a wave and stalled (0 = held, waiting for the lanes to fill). */
    laneWaved: Uint8Array;
    /** Wave mode: waves run so far. */
    waveCount: number;
    cellsLeft: number;

    private constructor(s: Statics) {
        this.s = s;
    }

    static create(board: Board, lanes: number, waves = false): PlaySim {
        const { width, height, numColors } = board;
        const n = width * height;
        const orderKey = new Int32Array(n);
        for (let i = 0; i < n; i++) {
            const x = i % width;
            orderKey[i] = (height - 1 - (i - x) / width) * width + x;
        }
        const cells = board.cells.slice();
        const lists = buildColorLists(cells, numColors);
        const s: Statics = { width, height, n, numColors, numLanes: lanes, waves, orderKey, colorOff: lists.offset, queue: new Int32Array(n) };
        const sim = new PlaySim(s);
        sim.cells = cells;
        sim.list = lists.list;
        sim.pos = lists.pos;
        sim.count = lists.count;
        sim.dist = new Int16Array(numColors * n);
        for (let c = 0; c < numColors; c++) buildDist(cells, width, height, c, sim.dist, c * n, s.queue);
        sim.laneColor = new Int32Array(lanes).fill(-1);
        sim.laneRem = new Int32Array(lanes);
        sim.laneWaved = new Uint8Array(lanes);
        sim.waveCount = 0;
        sim.cellsLeft = cells.reduce((a, v) => a + (v === EMPTY ? 0 : 1), 0);
        return sim;
    }

    clone(): PlaySim {
        const c = new PlaySim(this.s);
        c.cells = this.cells.slice();
        c.list = this.list.slice();
        c.pos = this.pos.slice();
        c.count = this.count.slice();
        c.dist = this.dist.slice();
        c.laneColor = this.laneColor.slice();
        c.laneRem = this.laneRem.slice();
        c.laneWaved = this.laneWaved.slice();
        c.waveCount = this.waveCount;
        c.cellsLeft = this.cellsLeft;
        return c;
    }

    get numColors(): number {
        return this.s.numColors;
    }

    get numLanes(): number {
        return this.s.numLanes;
    }

    get waves(): boolean {
        return this.s.waves;
    }

    reachableCount(color: number): number {
        const { n, colorOff } = this.s;
        const off = colorOff[color];
        const end = off + this.count[color];
        const base = color * n;
        let k = 0;
        for (let i = off; i < end; i++) if (this.dist[base + this.list[i]] !== INF) k++;
        return k;
    }

    freeLanes(): number {
        let f = 0;
        for (let l = 0; l < this.s.numLanes; l++) if (this.laneColor[l] < 0) f++;
        return f;
    }

    /** Cells of `color` not yet promised to a pod in a lane. */
    unassigned(color: number): number {
        let u = this.count[color];
        for (let l = 0; l < this.s.numLanes; l++) if (this.laneColor[l] === color) u -= this.laneRem[l];
        return u;
    }

    /** Cells not yet promised to a pod in a lane, all colors. */
    totalUnassigned(): number {
        let u = 0;
        for (let c = 0; c < this.s.numColors; c++) u += this.unassigned(c);
        return u;
    }

    tap(color: number, capacity: number): void {
        let l = 0;
        while (this.laneColor[l] >= 0) l++;
        this.laneColor[l] = color;
        this.laneRem[l] = capacity;
        this.laneWaved[l] = 0;
    }

    /** Wave mode: drains only when the lanes are full or nothing is left to tap (see the file header). */
    settle(): void {
        if (this.s.waves && this.freeLanes() > 0 && this.totalUnassigned() > 0) return;
        let claimed = false;
        while (this.step()) claimed = true;
        if (!this.s.waves || !claimed) return;
        this.waveCount++;
        for (let l = 0; l < this.s.numLanes; l++) this.laneWaved[l] = this.laneColor[l] >= 0 ? 1 : 0;
    }

    private step(): boolean {
        const { numLanes } = this.s;
        let claimed = false;
        for (let l = 0; l < numLanes; l++) {
            const color = this.laneColor[l];
            if (color < 0 || this.laneRem[l] === 0) continue;
            const i = this.pickNearest(color);
            if (i < 0) continue;
            this.removeCell(i);
            this.laneRem[l]--;
            claimed = true;
        }
        if (!claimed) return false;
        for (let l = 0; l < numLanes; l++) {
            if (this.laneColor[l] >= 0 && this.laneRem[l] === 0) this.laneColor[l] = -1;
        }
        return true;
    }

    private pickNearest(color: number): number {
        const { n, orderKey, colorOff } = this.s;
        const off = colorOff[color];
        const end = off + this.count[color];
        const base = color * n;
        let best = -1;
        let bestKey = 0x7fffffff;
        for (let s = off; s < end; s++) {
            const i = this.list[s];
            const d = this.dist[base + i];
            if (d === INF) continue;
            const key = d * n + orderKey[i];
            if (key >= bestKey) continue;
            bestKey = key;
            best = i;
        }
        return best;
    }

    private removeCell(i: number): void {
        const { width, height, n, numColors, colorOff, queue } = this.s;
        const color = this.cells[i];
        this.cells[i] = EMPTY;
        removeFromColorList(this.list, this.pos, colorOff, this.count, color, i);
        this.cellsLeft--;
        for (let d = 0; d < numColors; d++) {
            if (d === color || this.count[d] === 0) continue;
            relaxOpened(this.cells, width, height, d, this.dist, d * n, i, queue);
        }
    }
}
