/**
 * Patterned backgrounds: the paint for the background seal (see `outline-ring.ts`).
 *
 * A pattern maps a board cell to a band: 0 is the base color, 1+ are marks (or the steps of a gradient). Every band
 * gets its own neon that the art (and ring) doesn't use, so a pattern adds 2-4 colors to the level. Patterns are
 * centered on the board, so they sit symmetrically around the art.
 *
 * Gameplay: each band only reaches cells through empty cells and its own color, so a pattern interleaves its colors.
 * Isolated marks (dots, plus signs) open up once the base around them drains, stripes that touch the board edge
 * drain side by side, and concentric gradients (center glow, square, diamond) drain like nested seals.
 */
import type { Rng } from '@game/rng';
import { NEON_PALETTE } from '../../src/data/palette.ts';
import { hexToLab } from './lab.ts';
import { neonsConflict } from './palette.ts';

export type PatternFamily = 'simple' | 'marks' | 'lines' | 'structured' | 'gradient';

/** Band of the background cell at (x, y). */
export type Paint = (x: number, y: number) => number;

export interface PatternDef {
    name: string;
    family: PatternFamily;
    /** Fewest and most colors the pattern can paint with (base included). */
    minColors: number;
    maxColors: number;
    /** Builds the paint for a `width` x `height` board with `colors` bands; `inside` lists the cells to be painted. */
    make(rng: Rng, ctx: PaintContext): Paint;
}

export interface PaintContext {
    width: number;
    height: number;
    colors: number;
    /** Indexes of the cells that will be painted (the outside empty cells). Gradients stretch over these. */
    cells: readonly number[];
}

/** Non-negative modulo. */
function mod(a: number, n: number): number {
    return ((a % n) + n) % n;
}

/** Paint that repeats an ASCII tile: '.' is band 0, '#' band 1, '+' band 2. Odd tile rows shift by `shift` cells. */
function tile(rows: readonly string[], shift = 0): (u: number, v: number) => number {
    const h = rows.length;
    const w = rows[0].length;
    return (u, v) => {
        const row = Math.floor(v / h);
        const ch = rows[mod(v, h)][mod(u + (mod(row, 2) === 1 ? shift : 0), w)];
        return ch === '#' ? 1 : ch === '+' ? 2 : 0;
    };
}

/** `make` for a paint in centered coordinates (u, v), offset by a random phase per axis below `phase`. */
function centered(paint: (rng: Rng, ctx: PaintContext) => (u: number, v: number) => number, phase = 1): PatternDef['make'] {
    return (rng, ctx) => {
        const at = paint(rng, ctx);
        const cx = Math.floor(ctx.width / 2) + rng.below(phase);
        const cy = Math.floor(ctx.height / 2) + rng.below(phase);
        return (x, y) => at(x - cx, y - cy);
    };
}

/** A 2-color pattern built from one ASCII tile picked at random from `tiles`. */
function tiled(name: string, family: PatternFamily, tiles: readonly (readonly string[])[], shift: (t: readonly string[]) => number = () => 0): PatternDef {
    return {
        name,
        family,
        minColors: 2,
        maxColors: 2,
        make: centered((rng) => {
            const t = rng.pick(tiles);
            return tile(t, shift(t));
        }),
    };
}

const half = (t: readonly string[]) => t[0].length >> 1;

/** 4x4 Bayer matrix, as thresholds in [0, 1). */
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

/**
 * A gradient: `field` gives each cell a value, stretched over the painted cells into `colors` bands (band 0 at the
 * lowest value). Half the gradients dither the band edges with a Bayer matrix, like pixel-art shading.
 */
function gradient(name: string, field: (x: number, y: number, ctx: PaintContext, rng: Rng) => (x: number, y: number) => number): PatternDef {
    return {
        name,
        family: 'gradient',
        minColors: 3,
        maxColors: 4,
        make(rng, ctx) {
            const f = field(0, 0, ctx, rng);
            let lo = Infinity;
            let hi = -Infinity;
            for (const i of ctx.cells) {
                const x = i % ctx.width;
                const v = f(x, (i - x) / ctx.width);
                lo = Math.min(lo, v);
                hi = Math.max(hi, v);
            }
            const span = Math.max(1e-9, hi - lo);
            const dither = rng.chance(0.5) ? 0.7 : 0;
            const k = ctx.colors;
            return (x, y) => {
                const t = (f(x, y) - lo) / span;
                const jitter = dither * (BAYER4[mod(y, 4) * 4 + mod(x, 4)] - 0.5);
                return Math.max(0, Math.min(k - 1, Math.floor(t * k * 0.9999 + jitter)));
            };
        },
    };
}

/** Center of the board, in cell coordinates. */
function center(ctx: PaintContext): [number, number] {
    return [(ctx.width - 1) / 2, (ctx.height - 1) / 2];
}

export const PATTERNS: readonly PatternDef[] = [
    // --- simple ---
    {
        name: 'checkered',
        family: 'simple',
        minColors: 2,
        maxColors: 2,
        make: centered((rng) => {
            const s = rng.pick([1, 2, 2, 3]);
            return (u, v) => mod(Math.floor(u / s) + Math.floor(v / s), 2);
        }),
    },
    {
        name: 'vertical stripes',
        family: 'simple',
        minColors: 2,
        maxColors: 3,
        make: centered((rng, ctx) => stripes(rng, ctx.colors, (u) => u)),
    },
    {
        name: 'horizontal stripes',
        family: 'simple',
        minColors: 2,
        maxColors: 3,
        make: centered((rng, ctx) => stripes(rng, ctx.colors, (_u, v) => v)),
    },
    {
        name: 'diagonal stripes',
        family: 'simple',
        minColors: 2,
        maxColors: 3,
        make: centered((rng, ctx) => {
            const dir = rng.pick([1, -1]);
            return stripes(rng, ctx.colors, (u, v) => u + dir * v);
        }),
    },
    tiled(
        'bricks',
        'simple',
        [
            ['####', '#...', '#...'],
            ['######', '#.....', '#.....'],
            ['####', '#...'],
        ],
        half,
    ),

    // --- dots and little marks ---
    tiled('dots', 'marks', [
        ['#..', '...', '...'],
        ['#...', '....', '....', '....'],
        ['##..', '##..', '....', '....'],
        ['##...', '##...', '.....', '.....', '.....'],
    ]),
    tiled(
        'staggered dots',
        'marks',
        [
            ['#...', '....'],
            ['#..', '...', '...'],
            ['##....', '##....', '......'],
        ],
        half,
    ),
    tiled(
        'dashes',
        'marks',
        [
            ['##..', '....'],
            ['###..', '.....', '.....'],
            ['##...', '.....'],
        ],
        half,
    ),
    tiled('plus signs', 'marks', [
        ['.#...', '###..', '.#...', '.....', '.....'],
        ['.#....', '###...', '.#....', '......', '......', '......'],
    ]),
    tiled('x marks', 'marks', [
        ['#.#..', '.#...', '#.#..', '.....', '.....'],
        ['#.#...', '.#....', '#.#...', '......', '......', '......'],
    ]),
    tiled('corner marks', 'marks', [
        ['##...', '#....', '.....', '.....', '.....'],
        ['##..##', '#....#', '......', '......', '#....#', '##..##'],
        ['##.....', '#......', '.......', '.......', '.....#.', '....##.', '.......'],
    ]),

    // --- lines and shapes ---
    tiled('grid', 'lines', [
        ['###', '#..', '#..'],
        ['####', '#...', '#...', '#...'],
        ['#####', '#....', '#....', '#....', '#....'],
    ]),
    tiled('crosshatch', 'lines', [
        ['#...', '.#.#', '..#.', '.#.#'],
        ['#.....', '.#...#', '..#.#.', '...#..', '..#.#.', '.#...#'],
    ]),
    tiled('hollow squares', 'lines', [
        ['###..', '#.#..', '###..', '.....', '.....'],
        ['####.', '#..#.', '#..#.', '####.', '.....'],
        ['###...', '#.#...', '###...', '......', '......', '......'],
    ]),
    tiled(
        'diamonds',
        'lines',
        [
            ['.#....', '###...', '.#....', '......'],
            ['..#...', '.#.#..', '#...#.', '.#.#..', '..#...', '......'],
            ['..#...', '.###..', '#####.', '.###..', '..#...', '......'],
        ],
        (t) => t[0].length >> 1,
    ),
    tiled('zigzags', 'lines', [
        ['#.......', '.#.....#', '..#...#.', '...#.#..', '....#...', '........'],
        ['#.....', '.#...#', '..#.#.', '...#..', '......'],
        ['#...', '.#.#', '..#.', '....'],
    ]),
    tiled(
        'chevrons',
        'lines',
        [
            ['#...#.', '.#.#..', '..#...', '......'],
            ['#.....#.', '.#...#..', '..#.#...', '...#....', '........'],
        ],
        half,
    ),
    {
        name: 'plaid',
        family: 'lines',
        minColors: 3,
        maxColors: 3,
        make: centered((rng) => {
            const p = rng.pick([6, 7, 8]);
            const wide = rng.pick([2, 3]);
            const thin = wide + 1 + rng.below(p - wide - 2);
            return (u, v) => {
                const a = mod(u, p);
                const b = mod(v, p);
                const vb = a < wide;
                const hb = b < wide;
                if (vb && hb) return 1 + mod(u + v, 2);
                if (vb || hb) return 1;
                if (a === thin || b === thin) return 2;
                return 0;
            };
        }),
    },
    tiled('ladders', 'lines', [
        ['#..#..', '####..', '#..#..'],
        ['#...#...', '#####...', '#...#...', '#...#...'],
    ]),

    // --- structured ---
    tiled('basket weave', 'structured', [
        ['####.#.#', '.....#.#', '####.#.#', '.....#.#', '.#.#####', '.#.#....', '.#.#####', '.#.#....'],
        ['###.#.', '....#.', '###.#.', '.#.###', '.#....', '.#.###'],
    ]),
    {
        name: 'herringbone',
        family: 'structured',
        minColors: 2,
        maxColors: 2,
        make: centered((rng) => {
            const w = rng.pick([3, 4]);
            return (u, v) => {
                const a = mod(u, w);
                const up = mod(Math.floor(u / w), 2) === 0;
                return mod(v + (up ? a : -a), 2 * w - 2) < w - 1 ? 1 : 0;
            };
        }),
    },
    tiled(
        'scales',
        'structured',
        [
            ['.##.', '#..#', '....'],
            ['..##..', '.#..#.', '#....#', '......'],
        ],
        half,
    ),
    tiled('nested squares', 'structured', [
        ['######.', '#....#.', '#.##.#.', '#.##.#.', '#....#.', '######.', '.......'],
        ['#####.', '#...#.', '#.#.#.', '#...#.', '#####.', '......'],
    ]),
    {
        name: 'speckles',
        family: 'structured',
        minColors: 2,
        maxColors: 3,
        make: (rng, ctx) => scatter(rng, ctx, rng.float(0.1, 0.18), [[[0, 0]]]),
    },
    {
        name: 'confetti',
        family: 'structured',
        minColors: 3,
        maxColors: 3,
        make: (rng, ctx) =>
            scatter(rng, ctx, rng.float(0.05, 0.08), [
                [
                    [0, 0],
                    [1, 0],
                ],
                [
                    [0, 0],
                    [0, 1],
                ],
                [
                    [0, 0],
                    [1, 0],
                    [0, 1],
                    [1, 1],
                ],
                [
                    [0, 0],
                    [1, 1],
                ],
            ]),
    },

    // --- gradients ---
    gradient('horizontal fade', (_x, _y, _ctx, rng) => {
        const dir = rng.pick([1, -1]);
        return (x) => dir * x;
    }),
    gradient('vertical fade', (_x, _y, _ctx, rng) => {
        const dir = rng.pick([1, -1]);
        return (_x2, y) => dir * y;
    }),
    gradient('diagonal fade', (_x, _y, _ctx, rng) => {
        const sx = rng.pick([1, -1]);
        const sy = rng.pick([1, -1]);
        return (x, y) => sx * x + sy * y;
    }),
    gradient('mirrored fade', (_x, _y, ctx, rng) => {
        const [cx, cy] = center(ctx);
        return rng.chance(0.5) ? (x) => -Math.abs(x - cx) : (_x2, y) => -Math.abs(y - cy);
    }),
    gradient('center glow', (_x, _y, ctx) => {
        const [cx, cy] = center(ctx);
        return (x, y) => Math.hypot(x - cx, y - cy);
    }),
    gradient('corner glow', (_x, _y, ctx, rng) => {
        const cx = rng.pick([0, ctx.width - 1]);
        const cy = rng.pick([0, ctx.height - 1]);
        return (x, y) => Math.hypot(x - cx, y - cy);
    }),
    gradient('square gradient', (_x, _y, ctx) => {
        const [cx, cy] = center(ctx);
        return (x, y) => Math.max(Math.abs(x - cx), Math.abs(y - cy));
    }),
    gradient('diamond gradient', (_x, _y, ctx) => {
        const [cx, cy] = center(ctx);
        return (x, y) => Math.abs(x - cx) + Math.abs(y - cy);
    }),
];

/** Stripes along `axis`: band widths 1-3 each, one stripe per color. */
function stripes(rng: Rng, colors: number, axis: (u: number, v: number) => number): (u: number, v: number) => number {
    const widths = Array.from({ length: colors }, (_, i) => (i === 0 ? rng.int(1, 3) : rng.int(1, 2)));
    const period = widths.reduce((a, b) => a + b, 0);
    const bandAt: number[] = [];
    widths.forEach((w, band) => {
        for (let i = 0; i < w; i++) bandAt.push(band);
    });
    return (u, v) => bandAt[mod(axis(u, v), period)];
}

/** Random little `shapes` (cell offsets) dropped at `density` per cell, in mark bands 1..colors-1. */
function scatter(rng: Rng, ctx: PaintContext, density: number, shapes: readonly (readonly (readonly [number, number])[])[]): Paint {
    const bands = new Uint8Array(ctx.width * ctx.height);
    const marks = ctx.colors - 1;
    for (let i = 0; i < bands.length; i++) {
        if (!rng.chance(density)) continue;
        const x = i % ctx.width;
        const y = (i - x) / ctx.width;
        const band = 1 + rng.below(marks);
        for (const [dx, dy] of rng.pick(shapes)) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < ctx.width && ny < ctx.height) bands[ny * ctx.width + nx] = band;
        }
    }
    return (x, y) => bands[y * ctx.width + x];
}

/** Which patterns a level's background may use. */
export interface BackgroundStyle {
    families: readonly PatternFamily[];
    /** Most colors the pattern may paint with. */
    maxColors: number;
}

/** Easy levels get plain 2-color patterns (busier ones read as noise on small boards); the rest get the whole catalog. */
export function backgroundStyle(easy: boolean): BackgroundStyle {
    return easy ? { families: ['simple', 'marks'], maxColors: 2 } : { families: ['simple', 'marks', 'lines', 'structured', 'gradient'], maxColors: 4 };
}

/**
 * Ordered color ramps for gradients, dark to light. A gradient takes a run of 3-4 neighbors from one ramp, all free
 * for the level and distinct from each other.
 */
const RAMPS: readonly (readonly string[])[] = [
    ['ink', 'blue', 'sky', 'cyan', 'white'],
    ['ink', 'violet', 'magenta', 'pink', 'peach'],
    ['ink', 'purple', 'pink', 'peach', 'white'],
    ['copper', 'orange', 'gold', 'yellow'],
    ['red', 'orange', 'gold', 'yellow'],
    ['ink', 'teal', 'mint', 'white'],
    ['blue', 'teal', 'mint', 'lime', 'yellow'],
    ['ink', 'steel', 'white'],
    ['violet', 'magenta', 'red', 'orange', 'gold'],
    ['ink', 'blue', 'violet', 'pink', 'peach'],
    ['teal', 'lime', 'chartreuse', 'yellow'],
    ['copper', 'red', 'pink', 'peach', 'white'],
];

const HEX_BY_NAME = new Map(NEON_PALETTE.map((n) => [n.name, n.hex]));

/** Neons free for a level: not in `palette` and no near-twin of any of its colors. */
export function freeNeons(palette: readonly string[]): string[] {
    return NEON_PALETTE.map((n) => n.hex).filter((hex) => !palette.includes(hex) && palette.every((p) => !neonsConflict(p, hex)));
}

function lightness(hex: string): number {
    return hexToLab(hex)[0];
}

/** `k` free neons that tell apart from each other, base first (biased to the darker half so the art pops), or null. */
export function pickPatternColors(free: readonly string[], k: number, rng: Rng): string[] | null {
    const byLight = [...free].sort((a, b) => lightness(a) - lightness(b));
    const darkHalf = byLight.slice(0, Math.max(1, Math.ceil(byLight.length / 2)));
    for (let attempt = 0; attempt < 12; attempt++) {
        const base = rng.pick(attempt < 6 ? darkHalf : byLight);
        const chosen = [base];
        for (const hex of rng.shuffle(byLight.filter((h) => h !== base))) {
            if (chosen.length === k) break;
            if (chosen.some((c) => neonsConflict(c, hex))) continue;
            chosen.push(hex);
        }
        if (chosen.length === k) return chosen;
    }
    return null;
}

/** `k` free neons that run along one of `RAMPS` (darkest first, possibly reversed), or null. */
export function pickRamp(free: readonly string[], k: number, rng: Rng): string[] | null {
    const runs: string[][] = [];
    for (const ramp of RAMPS) {
        const hexes = ramp.map((name) => HEX_BY_NAME.get(name) ?? '');
        for (let start = 0; start + k <= hexes.length; start++) {
            const run = hexes.slice(start, start + k);
            if (!run.every((h) => free.includes(h))) continue;
            if (run.some((a, i) => run.some((b, j) => i < j && neonsConflict(a, b)))) continue;
            runs.push(run);
        }
    }
    if (runs.length === 0) return null;
    const run = rng.pick(runs);
    return rng.chance(0.5) ? run.slice().reverse() : run;
}

/** Smallest share of the background any one band may have, so no color ends up as a couple of stray cells. */
export const MIN_BAND_SHARE = 0.06;
/** Smallest cell count any one band may have. */
export const MIN_BAND_CELLS = 6;

export interface PaintedBackground {
    pattern: string;
    /** Neon per band. */
    colors: string[];
    /** Band per entry of `cells` (the painted cells, in the order given). */
    bands: Uint8Array;
}

/**
 * Pick a pattern and its colors for the `cells` of a `width` x `height` board whose art uses `palette`. Tries a few
 * patterns the `style` allows, falling back to fewer colors and finally to a single color. Null when no neon is free.
 */
export function paintBackground(
    width: number,
    height: number,
    cells: readonly number[],
    palette: readonly string[],
    style: BackgroundStyle,
    rng: Rng,
): PaintedBackground | null {
    const free = freeNeons(palette);
    if (free.length === 0 || cells.length === 0) return null;
    const minCells = Math.max(MIN_BAND_CELLS, Math.ceil(cells.length * MIN_BAND_SHARE));
    const options = PATTERNS.filter((p) => style.families.includes(p.family) && p.minColors <= style.maxColors);
    const families = style.families.filter((f) => options.some((p) => p.family === f));
    for (let attempt = 0; attempt < 16 && options.length > 0; attempt++) {
        const family = rng.pick(families);
        const inFamily = options.filter((p) => p.family === family);
        if (inFamily.length === 0) continue;
        const def = rng.pick(inFamily);
        const k = rng.int(def.minColors, Math.min(def.maxColors, style.maxColors));
        if (k * minCells > cells.length) continue;
        const colors = def.family === 'gradient' ? pickRamp(free, k, rng) : pickPatternColors(free, k, rng);
        if (!colors) continue;
        const paint = def.make(rng, { width, height, colors: k, cells });
        const bands = new Uint8Array(cells.length);
        const counts = new Array<number>(k).fill(0);
        cells.forEach((i, j) => {
            const x = i % width;
            const band = paint(x, (i - x) / width);
            bands[j] = band;
            counts[band]++;
        });
        if (counts.some((n) => n < minCells)) continue;
        return { pattern: def.name, colors, bands };
    }
    return { pattern: 'solid', colors: [rng.pick(free)], bands: new Uint8Array(cells.length) };
}
