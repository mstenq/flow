/** Per-image work for `gen:sweep`: simplify (+ optionally generate) one PNG entirely in memory. Never writes to public/levels. */
import { PNG } from 'pngjs';
import { hashString } from '@game/rng';
import { readPng, ALPHA_THRESHOLD } from './png.ts';
import type { RgbaImage } from './png.ts';
import { DEFAULT_MIN_REGION, maxColorsForDifficulty, simplifyImage } from './palette.ts';
import type { SimplifiedImage } from './palette.ts';
import { generateLevel } from './generate.ts';
import { replay } from './board.ts';
import { isFastPlayTrap } from './difficulty.ts';
import { hexToRgb } from './lab.ts';
import { idFromFile, sourceHash } from './output.ts';
import { EMPTY } from './simplify.ts';
import { join } from 'node:path';

export interface SweepJob {
    file: string;
    dir: string;
    difficulty: number;
    simplifyOnly: boolean;
}

export interface SweepResult {
    file: string;
    name: string;
    status: 'ok' | 'failed';
    error?: string;
    width: number;
    height: number;
    sourceColors: number;
    finalColors: number;
    cells: number;
    simplifyMs: number;
    totalMs: number;
    thumbOrig: string;
    thumbBoard: string;
    /** Full mode only. */
    target?: number;
    difficulty?: number;
    greedy?: number;
    random?: number;
    fastGreedy?: number;
    fastRandom?: number;
    maxPod?: number;
    drainSec?: number;
    trap?: boolean;
    pods?: number;
    lanes?: number;
    minLanes?: number;
    locks?: number;
    pairs?: number;
    hidden?: number;
    overflow?: number;
    warnings?: string[];
}

export function niceName(file: string): string {
    const base = file.replace(/\.png$/i, '').replace(/^\d+[_\-\s]+/, '');
    const words = base.split(/[_\-\s]+/).filter(Boolean);
    const out = words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    return out || base;
}

function dataUrl(img: RgbaImage): string {
    const png = new PNG({ width: img.width, height: img.height });
    png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
    return 'data:image/png;base64,' + PNG.sync.write(png).toString('base64');
}

/** Original image on a dark checker-free background, 1:1 (the page scales it with pixelated rendering). */
function origThumb(img: RgbaImage): string {
    const out: RgbaImage = { width: img.width, height: img.height, data: new Uint8Array(img.data.length) };
    for (let i = 0; i < img.width * img.height; i++) {
        const o = i * 4;
        if (img.data[o + 3] < ALPHA_THRESHOLD) out.data.set([12, 8, 24, 255], o);
        else out.data.set([img.data[o], img.data[o + 1], img.data[o + 2], 255], o);
    }
    return dataUrl(out);
}

/** Neon-ish board: inset tiles on a dark background, 6 px per cell. */
function boardThumb(s: Pick<SimplifiedImage, 'width' | 'height' | 'cells' | 'palette'>): string {
    const C = 6;
    const W = s.width * C;
    const H = s.height * C;
    const data = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) data.set([7, 5, 15, 255], i * 4);
    const rgb = s.palette.map(hexToRgb);
    for (let y = 0; y < s.height; y++) {
        for (let x = 0; x < s.width; x++) {
            const idx = s.cells[y * s.width + x];
            if (idx === EMPTY) continue;
            const [r, g, b] = rgb[idx];
            for (let dy = 0; dy < C - 1; dy++) {
                for (let dx = 0; dx < C - 1; dx++) data.set([r, g, b, 255], ((y * C + dy) * W + x * C + dx) * 4);
            }
        }
    }
    return dataUrl({ width: W, height: H, data });
}

function countSourceColors(img: RgbaImage): number {
    const set = new Set<number>();
    for (let i = 0; i < img.width * img.height; i++) {
        const o = i * 4;
        if (img.data[o + 3] < ALPHA_THRESHOLD) continue;
        set.add((img.data[o] << 16) | (img.data[o + 1] << 8) | img.data[o + 2]);
    }
    return set.size;
}

export function processJob(job: SweepJob): SweepResult {
    const t0 = performance.now();
    const path = join(job.dir, job.file);
    const base: SweepResult = {
        file: job.file,
        name: niceName(job.file),
        status: 'ok',
        width: 0,
        height: 0,
        sourceColors: 0,
        finalColors: 0,
        cells: 0,
        simplifyMs: 0,
        totalMs: 0,
        thumbOrig: '',
        thumbBoard: '',
    };
    try {
        const image = readPng(path);
        base.width = image.width;
        base.height = image.height;
        base.sourceColors = countSourceColors(image);
        base.thumbOrig = origThumb(image);
        const target = Math.max(0, Math.min(1, job.difficulty));
        if (job.simplifyOnly) {
            const t = performance.now();
            const s = simplifyImage(image, { maxColors: maxColorsForDifficulty(target), minRegion: DEFAULT_MIN_REGION });
            base.simplifyMs = performance.now() - t;
            base.finalColors = s.palette.length;
            base.cells = s.counts.reduce((a, b) => a + b, 0);
            base.thumbBoard = boardThumb(s);
        } else {
            const id = idFromFile(job.file);
            const r = generateLevel({ image, id, name: base.name, difficulty: target, seed: hashString(id), sourceHash: sourceHash(path) });
            if (!replay(r.level).won) throw new Error('invalid output: solution does not replay to a win');
            const l = r.level;
            const st = l.meta.stats;
            const pods = l.columns.flat();
            base.simplifyMs = r.timings.simplify ?? 0;
            base.finalColors = l.palette.length;
            base.cells = pods.reduce((s, p) => s + p.capacity, 0);
            base.thumbBoard = boardThumb(r.simplified);
            base.target = target;
            base.difficulty = l.meta.difficulty;
            base.greedy = st.greedyWinRate;
            base.random = st.randomWinRate;
            base.fastGreedy = st.fastGreedyWinRate;
            base.fastRandom = st.fastRandomWinRate;
            base.maxPod = st.maxPodCapacity;
            base.drainSec = st.longestDrainSec;
            base.trap = isFastPlayTrap(st);
            base.pods = pods.length;
            base.lanes = l.lanes;
            base.minLanes = st.minLanes;
            base.locks = st.lockCount;
            base.pairs = st.pairCount;
            base.hidden = pods.filter((p) => p.hidden).length;
            base.overflow = st.overflowPods;
            base.warnings = r.log.filter((x) => x.startsWith('WARNING'));
        }
    } catch (err) {
        base.status = 'failed';
        base.error = ((err as Error).message ?? String(err)).replace(job.dir, '').slice(0, 300);
    }
    base.totalMs = performance.now() - t0;
    return base;
}
