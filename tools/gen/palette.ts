import { NEON_PALETTE } from '../../src/data/palette.ts';
import { ALPHA_THRESHOLD, type RgbaImage } from './png.ts';
import { chroma, deltaE, hexToLab, hexToRgb, hsvHue, hueDeg, hueDiff, rgbToHex, type Lab } from './lab.ts';
import { buildInput, EMPTY, mergeCluster, quantize, type Cluster } from './simplify.ts';

export interface SimplifyOptions {
    maxColors: number;
    /** 8-connected regions smaller than this are dissolved into their dominant neighbor. Default 3. */
    minRegion?: number;
    /** Lab delta-E under which two colors are "the same color" when choosing cluster centers. Default 10. */
    tolerance?: number;
}

export interface SimplifiedImage {
    width: number;
    height: number;
    /** 255 = empty, else index into `palette`. */
    cells: Uint8Array;
    /** Neon hex per index (subset of NEON_PALETTE, all distinct). */
    palette: string[];
    /** Representative source hex per index (for reports). */
    sourceColors: string[];
    /** Cell count per index. */
    counts: number[];
    log: string[];
}

export const HARD_MAX_COLORS = NEON_PALETTE.length;
export const DEFAULT_MIN_REGION = 3;
export const DEFAULT_TOLERANCE = 10;

/**
 * Two neons closer than this CIE76 delta-E may never appear together in one level: pods in the lanes and the
 * queue are small, so every color of a level has to be instantly tellable apart. At 30 this separates only
 * violet/purple, orange/copper, sky/steel and lime/chartreuse. Raise it for a stricter rule (more merging),
 * lower it to allow more near-twins.
 */
export const MIN_LEVEL_DELTA_E = 30;

/**
 * Per-level color budget: `round(COLORS_BASE + COLORS_PER_DIFFICULTY * difficulty)`, clamped to
 * [MIN_COLORS, HARD_MAX_COLORS]. With 6 + 8d that is ~7 at difficulty 0.1, 10 at 0.5 and 14 at 1.0.
 * It is only a ceiling: flat images that need fewer colors still use fewer (the tolerance stop in the quantizer).
 * Tweak these two numbers to make every level more or less colorful. A `maxColors` in levels.json overrides it.
 */
export const COLORS_BASE = 6;
export const COLORS_PER_DIFFICULTY = 8;
export const MIN_COLORS = 4;

export function maxColorsForDifficulty(difficulty: number): number {
    const d = Math.max(0, Math.min(1, difficulty));
    return Math.max(MIN_COLORS, Math.min(HARD_MAX_COLORS, Math.round(COLORS_BASE + COLORS_PER_DIFFICULTY * d)));
}

/** A cluster's representative color, as seen by the neon matcher. */
export interface SourceColor {
    lab: Lab;
    rgb: [number, number, number];
}

type NeonKind = 'spectral' | 'neutral';

interface NeonInfo {
    name: string;
    hex: string;
    lab: Lab;
    hue: number;
    kind: NeonKind;
    /** How much a gray/dull source is discouraged from this neon (0 = fine, 1 = loud hue). */
    neutralAffinity: number;
}

/** Grays, metals, outlines and cream: these stand in for dull and dark sources. */
const NEUTRAL_NEONS = new Set(['white', 'steel', 'ink']);
/** Soft neons that dull warm sources (skin, cream) may use without a "loud hue" penalty. */
const NEUTRAL_AFFINITY: Record<string, number> = { white: 0, steel: 0, ink: 0, peach: 0.3, pink: 0.7, sky: 0.8 };

const NEONS: NeonInfo[] = NEON_PALETTE.map((n) => {
    const lab = hexToLab(n.hex);
    return {
        name: n.name,
        hex: n.hex,
        lab,
        hue: hsvHue(...hexToRgb(n.hex)),
        kind: NEUTRAL_NEONS.has(n.name) ? 'neutral' : 'spectral',
        neutralAffinity: NEUTRAL_AFFINITY[n.name] ?? 1,
    };
});

/** conflictMask[j] = neons that may not share a level with neon j (delta-E under MIN_LEVEL_DELTA_E). */
const CONFLICT_MASK: number[] = NEONS.map((a, i) => {
    let mask = 0;
    NEONS.forEach((b, j) => {
        if (i !== j && deltaE(a.lab, b.lab) < MIN_LEVEL_DELTA_E) mask |= 1 << j;
    });
    return mask;
});

/** True if two neon hexes may not appear in the same level. */
export function neonsConflict(hexA: string, hexB: string): boolean {
    if (hexA === hexB) return false;
    return deltaE(hexToLab(hexA), hexToLab(hexB)) < MIN_LEVEL_DELTA_E;
}

/** Lab lightness weight (the neons are bright, so a little less than chroma/hue differences). */
const LIGHT_WEIGHT = 1;
/** How much a chroma shortfall counts against a saturated neon: sources are duller than neons, hue is what matters. */
const CHROMA_SHORTFALL_WEIGHT = 0.5;
/** Same for a source more saturated than the neon (sRGB can exceed what a neon shows, e.g. pure #ff00ff vs magenta). */
const CHROMA_EXCESS_WEIGHT = 0.6;
/** Cost units per delta-E point; keeps costs near the 0-5 range the importance weights were tuned for. */
const COST_PER_DELTA_E = 1 / 20;
/** Extra cost (cost units) at a 180 degree hue gap for a fully saturated source on a spectral neon. */
const HUE_GUARD_WEIGHT = 14;

function clamp01(v: number): number {
    return Math.max(0, Math.min(1, v));
}

/**
 * Cost of showing `source` as `neon`. Lower is better.
 * With 20 neons covering the hue circle plus browns, skin, grays and outlines, a Lab distance picks the right
 * neon: gold stays gold, brown becomes copper, cream and skin become peach, gray and metal become steel, dark
 * outlines become ink, pastels pick the neon of their hue. Corrections on top of plain delta-E:
 *  - against a spectral neon, a source that is duller than the neon is only mildly penalized for it (art is duller
 *    than neon); a source more saturated than the neon is penalized in full
 *  - near-black, low-chroma sources (outlines in any hue) barely care about the hue of the neutral neons, so they land on ink
 *  - the hue gap of a saturated source is penalized extra so it never lands on a clearly different hue
 */
export function neonCost(src: SourceColor, neon: NeonInfo): number {
    const s = src.lab;
    const n = neon.lab;
    const dl = (s[0] - n[0]) * LIGHT_WEIGHT;
    const cs = chroma(s);
    const cn = chroma(n);
    const sat = clamp01((cs - 8) / 30);
    let plane: number;
    let outline = 0;
    if (neon.kind === 'neutral') {
        outline = clamp01((26 - s[0]) / 10) * clamp01((60 - cs) / 20);
        plane = Math.hypot(s[1] - n[1], s[2] - n[2]) * (1 - 0.75 * outline);
    } else {
        const dh = (Math.abs(hueDeg(s) - hueDeg(n)) % 360) * (Math.PI / 180);
        const angular = 2 * Math.min(cs, cn) * Math.sin(Math.min(dh, 2 * Math.PI - dh) / 2);
        // Truly dull sources (grays) get no discount: a gray is never a loud hue.
        const shortfall = 1 - (1 - CHROMA_SHORTFALL_WEIGHT) * clamp01((cs - 6) / 14);
        const radial = cs < cn ? (cn - cs) * shortfall : (cs - cn) * CHROMA_EXCESS_WEIGHT;
        plane = Math.hypot(angular, radial);
    }
    let cost = Math.hypot(dl, plane) * COST_PER_DELTA_E;
    // A saturated source keeps its hue: no loud hue other than its own, and no gray (except near-black outlines).
    const gap = hueDiff(hsvHue(...src.rgb), neon.hue);
    cost += (gap / 180) ** 2 * HUE_GUARD_WEIGHT * sat * sat * (1 - outline);
    return cost;
}

/** A mismatched cluster is only folded into a neighbor closer than this (Lab delta-E). */
const MERGE_MAX_DELTA_E = 26;
/** Mismatch folding never goes below this many colors (a one- or two-color level is not a puzzle). */
const MIN_KEPT_COLORS = 3;

const MISMATCH_MIN_SAT = 0.35;
const MISMATCH_HUE_GAP = 40;
/** Lab lightness under which a source may be shown as ink whatever its hue (outlines, shadows). */
const DARK_OUTLINE_L = 40;

/** Index of the cluster with the worst hue gap to its neon (only saturated sources, gap > 32 degrees), or -1. */
function worstHueMismatch(sources: SourceColor[], mapping: number[], eligible: boolean[]): number {
    let worst = -1;
    let worstGap = MISMATCH_HUE_GAP;
    sources.forEach((s, i) => {
        if (!eligible[i]) return;
        const neon = NEONS[mapping[i]];
        // White may stand in for pastels and ink for any dark outline; every other neon, steel included, must keep a similar hue.
        if (neon.name === 'white') return;
        if (neon.name === 'ink' && s.lab[0] < DARK_OUTLINE_L) return;
        if ((chroma(s.lab) - 8) / 30 < MISMATCH_MIN_SAT) return;
        const gap = hueDiff(hsvHue(...s.rgb), neon.hue);
        if (gap > worstGap) {
            worstGap = gap;
            worst = i;
        }
    });
    return worst;
}

/** A source farther than this plain Lab delta-E from its neon is not a recognizable stand-in (grays shown as teal, cream as lime). */
const MISMATCH_DELTA_E = 56;
/** Sources duller than this chroma are held to a stricter delta-E limit (MISMATCH_DELTA_E - DULL_DELTA_E_PENALTY) on colored neons. */
const DULL_CHROMA = 14;
const DULL_DELTA_E_PENALTY = 25;

/** Index of the cluster that is farthest from its neon (delta-E over MISMATCH_DELTA_E, dark outlines excepted), or -1. */
function worstDeltaEMismatch(sources: SourceColor[], mapping: number[], eligible: boolean[]): number {
    let worst = -1;
    let worstGap = MISMATCH_DELTA_E;
    sources.forEach((s, i) => {
        if (!eligible[i]) return;
        const neon = NEONS[mapping[i]];
        if (neon.name === 'ink' && s.lab[0] < DARK_OUTLINE_L) return;
        // A gray must never be shown with a colored neon, however light.
        const dull = neon.kind === 'spectral' && chroma(s.lab) < DULL_CHROMA;
        const d = deltaE(s.lab, neon.lab) + (dull ? DULL_DELTA_E_PENALTY : 0);
        if (d > worstGap) {
            worstGap = d;
            worst = i;
        }
    });
    return worst;
}

let popcounts: Uint8Array | null = null;
let dpBuf: Float64Array | null = null;
let fromBuf: Int8Array | null = null;

/**
 * Optimal one-to-one assignment of sources to neons under the distinctness rule (no two neons closer than
 * MIN_LEVEL_DELTA_E), or null if no such assignment exists. Bitmask DP over the 2^20 neon subsets: sources are
 * placed in index order, so a subset's popcount says which source it just placed. About 20-60 ms for 14 sources.
 */
export function tryAssignNeons(sources: SourceColor[], counts?: number[]): number[] | null {
    const m = sources.length;
    const k = NEONS.length;
    if (m > k) return null;
    if (m === 0) return [];
    // Big regions get first pick: a 5-cell pink must not steal "red" from a kimono.
    const total = counts ? counts.reduce((a, b) => a + b, 0) : 0;
    const importance = sources.map((_, i) => (counts && total > 0 ? 0.2 + 2.5 * (counts[i] / total) : 1));
    const cost = sources.map((s, i) => NEONS.map((n) => neonCost(s, n) * importance[i]));
    const full = 1 << k;
    if (!popcounts) {
        popcounts = new Uint8Array(full);
        for (let mask = 1; mask < full; mask++) popcounts[mask] = popcounts[mask >> 1] + (mask & 1);
        dpBuf = new Float64Array(full);
        fromBuf = new Int8Array(full);
    }
    const dp = dpBuf!;
    const from = fromBuf!;
    dp.fill(Infinity);
    dp[0] = 0;
    let bestMask = -1;
    let best = Infinity;
    for (let mask = 1; mask < full; mask++) {
        const p = popcounts[mask];
        if (p > m) continue;
        const row = cost[p - 1];
        let bestHere = Infinity;
        let bestJ = -1;
        for (let rest = mask; rest !== 0; rest &= rest - 1) {
            const bit = rest & -rest;
            const prev = mask ^ bit;
            const base = dp[prev];
            if (base === Infinity) continue;
            const j = 31 - Math.clz32(bit);
            if ((CONFLICT_MASK[j] & prev) !== 0) continue;
            const v = base + row[j];
            if (v < bestHere - 1e-12) {
                bestHere = v;
                bestJ = j;
            }
        }
        dp[mask] = bestHere;
        from[mask] = bestJ;
        if (p === m && bestHere < best - 1e-12) {
            best = bestHere;
            bestMask = mask;
        }
    }
    if (bestMask < 0) return null;
    const result = new Array<number>(m).fill(-1);
    let mask = bestMask;
    for (let i = m; i > 0; i--) {
        const j = from[mask];
        result[i - 1] = j;
        mask &= ~(1 << j);
    }
    return result;
}

/** Like `tryAssignNeons` but throws when the distinctness rule makes the mapping impossible. */
export function assignNeons(sources: SourceColor[], counts?: number[]): number[] {
    const r = tryAssignNeons(sources, counts);
    if (!r) throw new Error(`cannot map ${sources.length} colors onto ${NEONS.length} mutually distinct neons`);
    return r;
}

/**
 * Which clusters may be folded away to fix a poor neon match. Folding must be cheap (a near-twin cluster exists to absorb
 * it): in dark or muted art nothing matches a bright neon well, and distinct colors matter more than fidelity there.
 * Never folds below MIN_KEPT_COLORS.
 */
function mergeCandidates(clusters: Cluster[]): boolean[] {
    return clusters.map((c, i) => {
        if (clusters.length <= MIN_KEPT_COLORS) return false;
        return clusters.some((o, j) => j !== i && deltaE(c.lab, o.lab) < MERGE_MAX_DELTA_E);
    });
}

/** The cluster whose removal costs least: fewest cells, weighted by how far it is from its closest sibling. */
function cheapestCluster(clusters: Cluster[]): number {
    let best = 0;
    let bestScore = Infinity;
    clusters.forEach((c, i) => {
        let near = Infinity;
        clusters.forEach((o, j) => {
            if (i !== j) near = Math.min(near, deltaE(c.lab, o.lab));
        });
        const score = c.count * (10 + near);
        if (score < bestScore) {
            bestScore = score;
            best = i;
        }
    });
    return best;
}

/**
 * Turns any RGBA image into a small board of neon colors. Never fails on "too many colors": it always simplifies.
 * Deterministic: same input gives identical output.
 */
export function simplifyImage(img: RgbaImage, opts: SimplifyOptions): SimplifiedImage {
    const minRegion = Math.max(1, opts.minRegion ?? DEFAULT_MIN_REGION);
    const tolerance = opts.tolerance ?? DEFAULT_TOLERANCE;
    const maxColors = Math.max(1, Math.min(HARD_MAX_COLORS, Math.floor(opts.maxColors)));
    const input = buildInput(img.width, img.height, img.data, ALPHA_THRESHOLD);

    const opaqueCount = input.opaque.reduce((s, v) => s + v, 0);
    if (opaqueCount === 0) throw new Error('image has no opaque pixels');

    const result = quantize(input, {
        maxColors,
        minRegion,
        splitDeltaE: tolerance,
        edgeDeltaE: Math.max(6, tolerance),
        minColorCells: Math.max(minRegion * 2, 4),
    });

    // Two things can make a mapping unacceptable, and both are fixed by folding a cluster into its closest neighbor:
    //  - no distinct-enough set of neons exists for these clusters (distinctness rule): fold the cheapest cluster
    //  - a saturated cluster can only get a neon of a clearly different hue: fold the worst offender
    let clusters = result.clusters;
    const merges: string[] = [];
    let mapping: number[] = [];
    for (let guard = 0; guard < HARD_MAX_COLORS * 2; guard++) {
        const counts = clusters.map((c) => c.count);
        const assigned = tryAssignNeons(clusters, counts);
        if (!assigned) {
            const cheapest = cheapestCluster(clusters);
            merges.push(`${rgbToHex(...clusters[cheapest].rgb)} (${clusters[cheapest].count} cells): no mutually distinct neons left`);
            clusters = mergeCluster(input, result.labels, cheapest, minRegion);
            continue;
        }
        mapping = assigned;
        if (clusters.length <= 1) break;
        const eligible = mergeCandidates(clusters);
        const hue = worstHueMismatch(clusters, mapping, eligible);
        const far = hue < 0 ? worstDeltaEMismatch(clusters, mapping, eligible) : -1;
        const worst = hue >= 0 ? hue : far;
        if (worst < 0) break;
        const why = hue >= 0 ? 'no neon of a matching hue was left' : 'no close-looking neon was left';
        merges.push(`${rgbToHex(...clusters[worst].rgb)} -> ${NEONS[mapping[worst]].name}: ${why}`);
        clusters = mergeCluster(input, result.labels, worst, minRegion);
    }
    if (mapping.length !== clusters.length) mapping = assignNeons(clusters, clusters.map((c) => c.count));
    const cells = new Uint8Array(img.width * img.height).fill(EMPTY);
    for (let i = 0; i < cells.length; i++) cells[i] = result.labels[i];

    const palette = mapping.map((j) => NEONS[j].hex);
    const sourceColors = clusters.map((c) => rgbToHex(...c.rgb));
    const counts = clusters.map((c) => c.count);

    const s = result.stats;
    const log: string[] = [
        `${img.width}x${img.height}, ${opaqueCount} opaque cells, ${s.uniqueColors} unique source colors`,
        `quantize: ${s.interiorPixels} flat pixels chose ${s.initialClusters} cluster(s) (max ${maxColors}, tolerance dE ${tolerance})`,
        `cleanup: ${s.pixelsRecoloredByCleanup} pixel(s) recolored (regions < ${minRegion} cells dissolved), ${s.clustersMerged} tiny cluster(s) merged`,
        ...merges.map((m) => `merged away: ${m}`),
        `final: ${palette.length} color(s)`,
    ];
    clusters.forEach((c, i) => {
        log.push(
            `  [${i}] ${sourceColors[i]} -> ${NEONS[mapping[i]].name} ${palette[i]}  ${c.count} cells (${((c.count / opaqueCount) * 100).toFixed(1)}%)`,
        );
    });

    return { width: img.width, height: img.height, cells, palette, sourceColors, counts, log };
}
