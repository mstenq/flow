/**
 * Spatially aware color quantization + cleanup (no neon mapping here, see palette.ts).
 *
 * Pipeline:
 *  1. Edge detection. A pixel whose Lab color differs a lot from a neighbor is an "edge" pixel (anti-aliasing,
 *     outlines, dithering). Only flat "interior" pixels vote for cluster centers, so blended edge colors never
 *     become clusters of their own.
 *  2. Deterministic weighted k-means++ (farthest-weighted init, no RNG) + Lloyd iterations on interior pixels.
 *     Centers stop being added once every pixel is within `splitDeltaE` of a center, so flat art gets few colors.
 *  3. Edge pixels are assigned in order of increasing edge strength, choosing only among clusters that already
 *     appear next to them. A blurry black/white boundary can therefore never turn into a ring of a third color.
 *  4. Region cleanup: 8-connected regions smaller than `minRegion` are recolored to their dominant neighbor.
 *     Dark edge pixels that no interior center covers (a 1px black outline is all "edge") are promoted to voters.
 *  5. Clusters that stay tiny are merged into the closest cluster, then cleanup runs again.
 */
import { NEON_PALETTE } from '../../src/data/palette.ts';
import { distSq, rgbToLab, rgbToHex, type Lab } from './lab.ts';

export const EMPTY = 255;

/** Images with at most this many exact colors are treated as clean pixel art. */
export const CLEAN_ART_COLORS = 16;

/** Lab lightness under which an uncovered edge pixel counts as part of a dark outline. */
const DARK_L = 35;

export interface QuantizeInput {
    width: number;
    height: number;
    /** Lab per pixel (ignored where the pixel is empty). */
    lab: Lab[];
    rgb: Uint8Array; // 3 bytes per pixel
    opaque: Uint8Array; // 1 = opaque
    /** Pixels with partial alpha are treated as edge pixels. */
    soft: Uint8Array;
}

export interface Cluster {
    lab: Lab;
    rgb: [number, number, number];
    count: number;
}

export interface QuantizeOptions {
    maxColors: number;
    minRegion: number;
    /** Lab distance below which a pixel counts as "covered" by an existing center. */
    splitDeltaE: number;
    /** Edge threshold, Lab distance to the most different neighbor. */
    edgeDeltaE: number;
    /** Clusters with fewer cells than this are merged away after cleanup. */
    minColorCells: number;
}

export interface QuantizeResult {
    labels: Uint8Array;
    clusters: Cluster[];
    stats: {
        uniqueColors: number;
        interiorPixels: number;
        initialClusters: number;
        pixelsRecoloredByCleanup: number;
        clustersMerged: number;
    };
}

export function buildInput(width: number, height: number, data: Uint8Array, alphaThreshold: number): QuantizeInput {
    const n = width * height;
    const lab: Lab[] = new Array(n);
    const rgb = new Uint8Array(n * 3);
    const opaque = new Uint8Array(n);
    const soft = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        const a = data[i * 4 + 3];
        const r = data[i * 4];
        const g = data[i * 4 + 1];
        const b = data[i * 4 + 2];
        rgb[i * 3] = r;
        rgb[i * 3 + 1] = g;
        rgb[i * 3 + 2] = b;
        lab[i] = rgbToLab(r, g, b);
        if (a < alphaThreshold) continue;
        opaque[i] = 1;
        if (a < 250) soft[i] = 1;
    }
    return { width, height, lab, rgb, opaque, soft };
}

const NEIGHBORS_8: ReadonlyArray<readonly [number, number]> = [
    [-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1],
];
const NEIGHBORS_4: ReadonlyArray<readonly [number, number]> = [[0, -1], [-1, 0], [1, 0], [0, 1]];

function neighborIndices(w: number, h: number, i: number, offsets: ReadonlyArray<readonly [number, number]>): number[] {
    const x = i % w;
    const y = (i - x) / w;
    const out: number[] = [];
    for (const [dx, dy] of offsets) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        out.push(ny * w + nx);
    }
    return out;
}

/** Largest Lab distance to any opaque 8-neighbor. */
function edgeStrength(input: QuantizeInput): Float64Array {
    const { width, height, lab, opaque } = input;
    const out = new Float64Array(width * height);
    for (let i = 0; i < out.length; i++) {
        if (!opaque[i]) continue;
        let m = 0;
        for (const j of neighborIndices(width, height, i, NEIGHBORS_8)) {
            if (!opaque[j]) continue;
            const d = Math.sqrt(distSq(lab[i], lab[j]));
            if (d > m) m = d;
        }
        out[i] = m;
    }
    return out;
}

function nearest(centers: Lab[], p: Lab, allowed?: Iterable<number>): number {
    let best = -1;
    let bestD = Infinity;
    if (allowed) {
        for (const c of allowed) {
            const d = distSq(centers[c], p);
            if (d < bestD || (d === bestD && c < best)) {
                bestD = d;
                best = c;
            }
        }
        return best;
    }
    for (let c = 0; c < centers.length; c++) {
        const d = distSq(centers[c], p);
        if (d < bestD) {
            bestD = d;
            best = c;
        }
    }
    return best;
}

/** Deterministic weighted k-means++ style init: always take the point with the largest (weight x distance^2). */
function initCenters(points: Lab[], weights: number[], maxK: number, splitDeltaE: number): Lab[] {
    const centers: Lab[] = [];
    const total = weights.reduce((s, w) => s + w, 0);
    const mean: Lab = [0, 0, 0];
    points.forEach((p, i) => {
        mean[0] += (p[0] * weights[i]) / total;
        mean[1] += (p[1] * weights[i]) / total;
        mean[2] += (p[2] * weights[i]) / total;
    });
    let first = 0;
    let firstD = Infinity;
    points.forEach((p, i) => {
        const d = distSq(p, mean);
        if (d < firstD) {
            firstD = d;
            first = i;
        }
    });
    centers.push(points[first]);
    const minD = points.map((p) => distSq(p, points[first]));
    const splitSq = splitDeltaE * splitDeltaE;
    while (centers.length < maxK) {
        let best = -1;
        let bestScore = 0;
        for (let i = 0; i < points.length; i++) {
            if (minD[i] < splitSq) continue;
            const score = minD[i] * weights[i];
            if (score > bestScore) {
                bestScore = score;
                best = i;
            }
        }
        if (best < 0) break;
        centers.push(points[best]);
        for (let i = 0; i < points.length; i++) {
            const d = distSq(points[i], points[best]);
            if (d < minD[i]) minD[i] = d;
        }
    }
    return centers;
}

function lloyd(points: Lab[], weights: number[], initial: Lab[]): Lab[] {
    let centers = initial.map((c) => [...c] as Lab);
    for (let iter = 0; iter < 40; iter++) {
        const sums = centers.map(() => [0, 0, 0, 0]);
        for (let i = 0; i < points.length; i++) {
            const c = nearest(centers, points[i]);
            const s = sums[c];
            s[0] += points[i][0] * weights[i];
            s[1] += points[i][1] * weights[i];
            s[2] += points[i][2] * weights[i];
            s[3] += weights[i];
        }
        const next: Lab[] = [];
        let moved = 0;
        centers.forEach((c, k) => {
            const s = sums[k];
            if (s[3] === 0) return; // empty cluster is dropped
            const n: Lab = [s[0] / s[3], s[1] / s[3], s[2] / s[3]];
            moved += distSq(n, c);
            next.push(n);
        });
        const shrunk = next.length !== centers.length;
        centers = next;
        if (!shrunk && moved < 1e-6) break;
    }
    return centers;
}

/** Assign every opaque pixel: interior by nearest center, edge pixels only among clusters seen around them. */
function assignAll(input: QuantizeInput, centers: Lab[], isInterior: Uint8Array, strength: Float64Array): Uint8Array {
    const { width, height, lab, opaque } = input;
    const n = width * height;
    const labels = new Uint8Array(n).fill(EMPTY);
    const edgeOrder: number[] = [];
    for (let i = 0; i < n; i++) {
        if (!opaque[i]) continue;
        if (isInterior[i]) labels[i] = nearest(centers, lab[i]);
        else edgeOrder.push(i);
    }
    edgeOrder.sort((a, b) => strength[a] - strength[b] || a - b);
    let pending = edgeOrder;
    while (pending.length > 0) {
        const deferred: number[] = [];
        for (const i of pending) {
            const seen = new Set<number>();
            for (const j of neighborIndices(width, height, i, NEIGHBORS_8)) {
                if (labels[j] !== EMPTY) seen.add(labels[j]);
            }
            if (seen.size === 0) {
                deferred.push(i);
                continue;
            }
            labels[i] = nearest(centers, lab[i], seen);
        }
        if (deferred.length === pending.length) {
            for (const i of deferred) labels[i] = nearest(centers, lab[i]);
            break;
        }
        pending = deferred;
    }
    return labels;
}

/**
 * Same-label connected regions. Cleanup uses 8-connectivity: a 1px outline that steps diagonally is a single line
 * (and must survive), but its 4-connected pieces are 1-2 cells each and would all be dissolved as speckle.
 */
function findRegions(
    width: number,
    height: number,
    labels: Uint8Array,
    offsets: ReadonlyArray<readonly [number, number]> = NEIGHBORS_4,
): { regions: number[][]; regionOf: Int32Array } {
    const n = width * height;
    const regionOf = new Int32Array(n).fill(-1);
    const regions: number[][] = [];
    for (let s = 0; s < n; s++) {
        if (labels[s] === EMPTY || regionOf[s] >= 0) continue;
        const id = regions.length;
        const cells = [s];
        regionOf[s] = id;
        for (let q = 0; q < cells.length; q++) {
            for (const j of neighborIndices(width, height, cells[q], offsets)) {
                if (labels[j] !== labels[s] || regionOf[j] >= 0) continue;
                regionOf[j] = id;
                cells.push(j);
            }
        }
        regions.push(cells);
    }
    return { regions, regionOf };
}

/** Recolors 8-connected regions smaller than minRegion to their dominant neighbor, until stable. */
function cleanupRegions(input: QuantizeInput, labels: Uint8Array, minRegion: number): void {
    const { width, height, lab } = input;
    for (let pass = 0; pass < 100; pass++) {
        const { regions } = findRegions(width, height, labels, NEIGHBORS_8);
        const small = regions.filter((r) => r.length < minRegion).sort((a, b) => a.length - b.length || a[0] - b[0]);
        let changed = false;
        for (const region of small) {
            const own = labels[region[0]];
            if (region.some((i) => labels[i] !== own)) continue; // already changed this pass
            let votes = tallyNeighbors(width, height, labels, region, own, NEIGHBORS_4);
            if (votes.size === 0) votes = tallyNeighbors(width, height, labels, region, own, NEIGHBORS_8);
            if (votes.size === 0) continue;
            let best = -1;
            let bestVotes = 0;
            let bestDist = Infinity;
            const mean = meanLab(lab, region);
            for (const [label, v] of votes) {
                const d = distSq(mean, meanLabelColor(lab, labels, label));
                if (v > bestVotes || (v === bestVotes && d < bestDist) || (v === bestVotes && d === bestDist && label < best)) {
                    best = label;
                    bestVotes = v;
                    bestDist = d;
                }
            }
            for (const i of region) labels[i] = best;
            changed = true;
        }
        if (!changed) return;
    }
}

function tallyNeighbors(
    width: number,
    height: number,
    labels: Uint8Array,
    region: number[],
    own: number,
    offsets: ReadonlyArray<readonly [number, number]>,
): Map<number, number> {
    const votes = new Map<number, number>();
    for (const i of region) {
        for (const j of neighborIndices(width, height, i, offsets)) {
            const l = labels[j];
            if (l === EMPTY || l === own) continue;
            votes.set(l, (votes.get(l) ?? 0) + 1);
        }
    }
    return votes;
}

function meanLab(lab: Lab[], cells: number[]): Lab {
    const m: Lab = [0, 0, 0];
    for (const i of cells) {
        m[0] += lab[i][0];
        m[1] += lab[i][1];
        m[2] += lab[i][2];
    }
    return [m[0] / cells.length, m[1] / cells.length, m[2] / cells.length];
}

function meanLabelColor(lab: Lab[], labels: Uint8Array, label: number): Lab {
    const m: Lab = [0, 0, 0];
    let n = 0;
    for (let i = 0; i < labels.length; i++) {
        if (labels[i] !== label) continue;
        m[0] += lab[i][0];
        m[1] += lab[i][1];
        m[2] += lab[i][2];
        n++;
    }
    return n === 0 ? m : [m[0] / n, m[1] / n, m[2] / n];
}

function summarize(input: QuantizeInput, labels: Uint8Array): Cluster[] {
    const k = labels.reduce((m, l) => (l !== EMPTY && l + 1 > m ? l + 1 : m), 0);
    const acc = Array.from({ length: k }, () => ({ l: [0, 0, 0], rgb: [0, 0, 0], n: 0 }));
    for (let i = 0; i < labels.length; i++) {
        if (labels[i] === EMPTY) continue;
        const a = acc[labels[i]];
        for (let c = 0; c < 3; c++) {
            a.l[c] += input.lab[i][c];
            a.rgb[c] += input.rgb[i * 3 + c];
        }
        a.n++;
    }
    return acc.map((a) => ({
        lab: a.n ? ([a.l[0] / a.n, a.l[1] / a.n, a.l[2] / a.n] as Lab) : ([0, 0, 0] as Lab),
        rgb: a.n ? ([a.rgb[0] / a.n, a.rgb[1] / a.n, a.rgb[2] / a.n] as [number, number, number]) : [0, 0, 0],
        count: a.n,
    }));
}

/** Renumbers labels so that unused ids vanish and ids are ordered by descending count. */
function compact(input: QuantizeInput, labels: Uint8Array): Cluster[] {
    const clusters = summarize(input, labels);
    const order = clusters
        .map((c, i) => ({ c, i }))
        .filter((e) => e.c.count > 0)
        .sort((a, b) => b.c.count - a.c.count || b.c.lab[0] - a.c.lab[0] || a.i - b.i);
    const remap = new Map<number, number>();
    order.forEach((e, newId) => remap.set(e.i, newId));
    for (let i = 0; i < labels.length; i++) {
        if (labels[i] !== EMPTY) labels[i] = remap.get(labels[i])!;
    }
    return order.map((e) => e.c);
}

/**
 * Folds cluster `from` into its closest remaining cluster, re-runs region cleanup and renumbers.
 * Returns the new clusters (labels are updated in place). Used when a cluster has no sensible neon to map to.
 */
export function mergeCluster(input: QuantizeInput, labels: Uint8Array, from: number, minRegion: number): Cluster[] {
    const clusters = summarize(input, labels);
    let target = -1;
    let targetD = Infinity;
    clusters.forEach((c, i) => {
        if (i === from || c.count === 0) return;
        const d = distSq(c.lab, clusters[from].lab);
        if (d < targetD) {
            targetD = d;
            target = i;
        }
    });
    if (target >= 0) {
        for (let i = 0; i < labels.length; i++) if (labels[i] === from) labels[i] = target;
        cleanupRegions(input, labels, minRegion);
    }
    return compact(input, labels);
}

export function quantize(input: QuantizeInput, opts: QuantizeOptions): QuantizeResult {
    const { width, height, lab, opaque, soft } = input;
    const n = width * height;
    const opaqueIdx: number[] = [];
    const unique = new Set<string>();
    for (let i = 0; i < n; i++) {
        if (!opaque[i]) continue;
        opaqueIdx.push(i);
        unique.add(rgbToHex(input.rgb[i * 3], input.rgb[i * 3 + 1], input.rgb[i * 3 + 2]));
    }

    const strength = edgeStrength(input);
    const isInterior = new Uint8Array(n);
    let interiorCount = 0;
    for (const i of opaqueIdx) {
        if (strength[i] > opts.edgeDeltaE || soft[i]) continue;
        isInterior[i] = 1;
        interiorCount++;
    }
    // Noisy/photographic input (no flat areas to speak of) or clean pixel art with a handful of exact colors
    // (where 1px outlines and details are all "edge" pixels): let every pixel vote.
    if (interiorCount < opaqueIdx.length * 0.2 || unique.size <= CLEAN_ART_COLORS) {
        for (const i of opaqueIdx) isInterior[i] = 1;
        interiorCount = opaqueIdx.length;
    }

    const maxK = Math.max(1, Math.min(opts.maxColors, NEON_PALETTE.length));
    const interiorPoints = (): { points: Lab[]; weights: number[] } => {
        const points: Lab[] = [];
        for (const i of opaqueIdx) if (isInterior[i]) points.push(lab[i]);
        return { points, weights: points.map(() => 1) };
    };
    if (interiorCount < opaqueIdx.length) {
        // A 1px dark outline is all "edge" pixels, so it never votes and the icon loses its outline. Promote dark
        // edge pixels that no interior center covers, if there are enough of them to be a real line (not noise).
        const first = interiorPoints();
        const centers0 = lloyd(first.points, first.weights, initCenters(first.points, first.weights, maxK, opts.splitDeltaE));
        const cover = (opts.splitDeltaE * 1.5) ** 2;
        const dark = opaqueIdx.filter((i) => !isInterior[i] && lab[i][0] < DARK_L && distSq(centers0[nearest(centers0, lab[i])], lab[i]) > cover);
        if (dark.length >= Math.max(6, opaqueIdx.length * 0.02)) {
            for (const i of dark) isInterior[i] = 1;
            interiorCount += dark.length;
        }
    }
    const { points, weights } = interiorPoints();
    const initial = initCenters(points, weights, maxK, opts.splitDeltaE);
    const centers = lloyd(points, weights, initial);

    const labels = assignAll(input, centers, isInterior, strength);
    const initialClusters = centers.length;
    const before = labels.slice();

    cleanupRegions(input, labels, opts.minRegion);

    // Merge clusters that ended up tiny into their closest remaining cluster, then clean up again.
    let clustersMerged = 0;
    for (let guard = 0; guard < 20; guard++) {
        const clusters = summarize(input, labels);
        let tiny = -1;
        let tinyCount = Infinity;
        let alive = 0;
        clusters.forEach((c, i) => {
            if (c.count === 0) return;
            alive++;
            if (c.count < opts.minColorCells && c.count < tinyCount) {
                tiny = i;
                tinyCount = c.count;
            }
        });
        if (tiny < 0 || alive <= 1) break;
        let target = -1;
        let targetD = Infinity;
        clusters.forEach((c, i) => {
            if (i === tiny || c.count === 0) return;
            const d = distSq(c.lab, clusters[tiny].lab);
            if (d < targetD) {
                targetD = d;
                target = i;
            }
        });
        for (let i = 0; i < n; i++) if (labels[i] === tiny) labels[i] = target;
        clustersMerged++;
        cleanupRegions(input, labels, opts.minRegion);
    }

    let recolored = 0;
    for (let i = 0; i < n; i++) if (labels[i] !== before[i]) recolored++;
    const clusters = compact(input, labels);
    return {
        labels,
        clusters,
        stats: {
            uniqueColors: unique.size,
            interiorPixels: interiorCount,
            initialClusters,
            pixelsRecoloredByCleanup: recolored,
            clustersMerged,
        },
    };
}
