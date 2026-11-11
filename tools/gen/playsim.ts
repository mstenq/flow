/**
 * Minimal mirror of the sim's settled-play rules for construction, where pods are invented on the fly
 * (the real `Sim` needs every pod up front). Same tick semantics: lanes left→right each claim the nearest
 * reachable cell by `(dist, -y, x)`, other colors' distances update immediately, full pods free their lane.
 * No keys, links or pushy pods: mechanics are placed afterwards and every result is replayed on the real `Sim`.
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
    cellsLeft: number;

    private constructor(s: Statics) {
        this.s = s;
    }

    static create(board: Board, lanes: number): PlaySim {
        const { width, height, numColors } = board;
        const n = width * height;
        const orderKey = new Int32Array(n);
        for (let i = 0; i < n; i++) {
            const x = i % width;
            orderKey[i] = (height - 1 - (i - x) / width) * width + x;
        }
        const cells = board.cells.slice();
        const lists = buildColorLists(cells, numColors);
        const s: Statics = { width, height, n, numColors, numLanes: lanes, orderKey, colorOff: lists.offset, queue: new Int32Array(n) };
        const sim = new PlaySim(s);
        sim.cells = cells;
        sim.list = lists.list;
        sim.pos = lists.pos;
        sim.count = lists.count;
        sim.dist = new Int16Array(numColors * n);
        for (let c = 0; c < numColors; c++) buildDist(cells, width, height, c, sim.dist, c * n, s.queue);
        sim.laneColor = new Int32Array(lanes).fill(-1);
        sim.laneRem = new Int32Array(lanes);
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
        c.cellsLeft = this.cellsLeft;
        return c;
    }

    get numColors(): number {
        return this.s.numColors;
    }

    get numLanes(): number {
        return this.s.numLanes;
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

    tap(color: number, capacity: number): void {
        let l = 0;
        while (this.laneColor[l] >= 0) l++;
        this.laneColor[l] = color;
        this.laneRem[l] = capacity;
    }

    settle(): void {
        while (this.step()) {
            // keep ticking
        }
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
