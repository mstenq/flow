/**
 * bun run levels:add [glob] [--dry-run] [--from 0.15] [--to 0.7] [--ramp 90] [--lo 0.35] [--hi 0.9] [--period 6] [--offset N]
 *
 * Appends every PNG in levels-src/ that levels-src/levels.json does not reference yet. Existing entries are never
 * touched or reordered (the file is edited as text: new lines are appended), and a second run adds nothing.
 *
 *  - name: from the file name ("15_bell_pepper_p.png" -> "Bell Pepper (Alt)"), unique across the whole file
 *  - order: new levels are sorted simplest first (final colors x opaque cells, from the fast image stage)
 *  - difficulty: a ramp from --from to --to over the first --ramp new levels, then a sawtooth between --lo and --hi
 *    (`period` levels rising, then a breather). Hidden pods (>= 0.25) and locks / pairs (>= 0.45) follow from it.
 *  - glob (optional, matched against the file name): only consider matching PNGs, e.g. `bun run levels:add "*_dish.png"`
 *  - --offset N: where on the curve the first new level sits. Default: levels already in levels.json minus the
 *    hand-made opening levels, so a later top-up continues the sawtooth instead of restarting the ramp
 *  - --dry-run: print the plan as a table and write nothing
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_MIN_REGION, maxColorsForDifficulty, simplifyImage } from './palette.ts';
import type { LevelEntry } from './output.ts';
import { LEVELS_SRC, entryId, idFromFile, loadEntries } from './output.ts';
import { readPng } from './png.ts';

/** The opening levels in levels.json that were curated by hand (not produced by this tool). */
export const CURATED_LEVELS = 12;
/** Difficulty used for the image stage that ranks complexity (it sets the color budget, 10 colors). */
const RANK_DIFFICULTY = 0.5;

// ---------------------------------------------------------------- names

/** Run-together words in the icon pack's file names. */
const WORD_FIXES: Record<string, string> = {
    friedegg: 'fried egg',
    eggsalad: 'egg salad',
    eggtart: 'egg tart',
    frenchfries: 'french fries',
    fruitcake: 'fruit cake',
    garlicbread: 'garlic bread',
    giantgummybear: 'giant gummy bear',
    gingerbreadman: 'gingerbread man',
    hotdog: 'hot dog',
    icecream: 'ice cream',
    lemonpie: 'lemon pie',
    loafbread: 'loaf bread',
    macncheese: 'mac n cheese',
    potatochips: 'potato chips',
    potatochip: 'potato chip',
    roastedchicken: 'roasted chicken',
    strawberrycake: 'strawberry cake',
    chocolatecake: 'chocolate cake',
    cheesecake: 'cheesecake',
    cheesepuff: 'cheese puff',
    orangejui: 'orange juice',
    omlet: 'omelet',
    nacho: 'nachos',
    sanitiser: 'sanitizer',
    ducktopus: 'duck topus',
};
const SMALL_WORDS = new Set(['or', 'and', 'of', 'n', 'the']);
/** Two-letter category prefixes of the icon pack: `ra-miso` is a ramen bowl, `gr-` / `pa-` are just groups. */
const CATEGORY_SUFFIX: Record<string, string> = { ra: 'ramen' };

export interface NameParts {
    /** Title-cased name without any variant marker. */
    base: string;
    /** File ends in `_p` (the pack's alternate drawing of the same thing). */
    alt: boolean;
    numericPrefix: boolean;
    categoryPrefix: boolean;
}

export function nameParts(file: string): NameParts {
    let stem = file.replace(/\.png$/i, '');
    const numericPrefix = /^\d+[_\-\s]+/.test(stem);
    stem = stem.replace(/^\d+[_\-\s]+/, '');
    const alt = /[_\-\s]p$/i.test(stem);
    stem = stem.replace(/[_\-\s]p$/i, '');
    const category = /^([a-z]{2})-/i.exec(stem)?.[1].toLowerCase();
    const categoryPrefix = category !== undefined && category in { gr: 1, pa: 1, ra: 1 };
    if (categoryPrefix) stem = stem.slice(3);
    stem = stem.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([a-zA-Z])(\d)/g, '$1 $2');
    let words = stem
        .split(/[_\-\s]+/)
        .filter(Boolean)
        .map((w) => w.toLowerCase())
        .flatMap((w) => (WORD_FIXES[w] ?? w).split(' '));
    if (categoryPrefix && category && CATEGORY_SUFFIX[category]) words.push(CATEGORY_SUFFIX[category]);
    words = words.map((w, i) => (i > 0 && SMALL_WORDS.has(w) ? w : w[0].toUpperCase() + w.slice(1)));
    return { base: words.join(' ') || file.replace(/\.png$/i, ''), alt, numericPrefix, categoryPrefix };
}

/** Name for one file, ignoring uniqueness. */
export function levelName(file: string): string {
    const p = nameParts(file);
    return p.alt ? `${p.base} (Alt)` : p.base;
}

/**
 * Unique names for `files`, keyed by file. The plainest file name of a group keeps the plain name; variants get
 * "(Alt)" (`_p` files) or "(2)", "(3)" ... `taken` holds names already used (case-insensitive). Independent of input order.
 */
export function uniqueNames(files: string[], taken: Iterable<string> = []): Map<string, string> {
    const used = new Set<string>();
    for (const t of taken) used.add(t.toLowerCase());
    const parts = new Map(files.map((f) => [f, nameParts(f)] as const));
    const rank = (f: string): number => {
        const p = parts.get(f)!;
        return (p.alt ? 4 : 0) + (p.numericPrefix ? 2 : 0) + (p.categoryPrefix ? 1 : 0);
    };
    const order = [...files].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, undefined, { numeric: true }));
    const out = new Map<string, string>();
    for (const f of order) {
        const p = parts.get(f)!;
        let name = p.base;
        if (used.has(name.toLowerCase()) && p.alt) name = `${p.base} (Alt)`;
        for (let n = 2; used.has(name.toLowerCase()); n++) name = `${p.base}${p.alt ? ' (Alt)' : ''} (${n})`.replace(' (Alt) (', ' (Alt ').replace(/^(.*) \(Alt (\d+)\)$/, '$1 (Alt $2)');
        used.add(name.toLowerCase());
        out.set(f, name);
    }
    return out;
}

// ---------------------------------------------------------------- difficulty curve

export interface CurveOptions {
    /** Difficulty of the first new level. */
    from: number;
    /** Difficulty at the end of the ramp. */
    to: number;
    /** Number of levels in the ramp. */
    ramp: number;
    /** Sawtooth floor and ceiling (after the ramp). */
    lo: number;
    hi: number;
    /** Levels per sawtooth tooth: rises lo -> hi over `period` levels, then drops back (the breather). */
    period: number;
}

export const DEFAULT_CURVE: CurveOptions = { from: 0.15, to: 0.7, ramp: 90, lo: 0.35, hi: 0.9, period: 6 };

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** Difficulty of the i-th (0-based) level on the curve. */
export function difficultyAt(i: number, c: CurveOptions = DEFAULT_CURVE): number {
    if (i < c.ramp) return round2(c.from + (c.to - c.from) * (c.ramp > 1 ? i / (c.ramp - 1) : 1));
    const k = (i - c.ramp) % c.period;
    return round2(c.lo + (c.hi - c.lo) * (c.period > 1 ? k / (c.period - 1) : 1));
}

// ---------------------------------------------------------------- levels.json text editing

export function formatEntry(e: Pick<LevelEntry, 'file' | 'name' | 'difficulty'> & { id?: string }): string {
    const idPart = e.id ? ` "id": ${JSON.stringify(e.id)},` : '';
    return `  { "file": ${JSON.stringify(e.file)},${idPart} "name": ${JSON.stringify(e.name)}, "difficulty": ${e.difficulty} }`;
}

/** Append entry lines to the raw text of levels.json without touching what is already there. */
export function appendToLevelsJson(raw: string, lines: string[]): string {
    if (lines.length === 0) return raw;
    const end = raw.lastIndexOf(']');
    const body = end < 0 ? '[' : raw.slice(0, end).trimEnd();
    const empty = body === '[';
    return `${body}${empty ? '\n' : ',\n'}${lines.join(',\n')}\n]\n`;
}

// ---------------------------------------------------------------- planning

export interface PlannedLevel {
    file: string;
    id: string;
    explicitId: boolean;
    name: string;
    difficulty: number;
    colors: number;
    cells: number;
    score: number;
}

export interface PlanOptions {
    dir: string;
    existing: LevelEntry[];
    glob?: string;
    curve: CurveOptions;
    offset: number;
}

export interface Plan {
    levels: PlannedLevel[];
    skipped: { file: string; reason: string }[];
}

export function listPngs(dir: string): string[] {
    return readdirSync(dir)
        .filter((f) => /\.png$/i.test(f))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** Decide what to add: new PNGs, ranked simplest first, with names, ids and curve difficulties. */
export function planAdditions(o: PlanOptions): Plan {
    const listed = new Set(o.existing.map((e) => e.file));
    const matcher = o.glob ? new Bun.Glob(o.glob) : null;
    const candidates = listPngs(o.dir).filter((f) => !listed.has(f) && (!matcher || matcher.match(f)));
    const skipped: Plan['skipped'] = [];
    const ranked: { file: string; colors: number; cells: number; score: number }[] = [];
    for (const file of candidates) {
        try {
            const img = readPng(join(o.dir, file));
            const s = simplifyImage(img, { maxColors: maxColorsForDifficulty(RANK_DIFFICULTY), minRegion: DEFAULT_MIN_REGION });
            const cells = s.counts.reduce((a, b) => a + b, 0);
            ranked.push({ file, colors: s.palette.length, cells, score: s.palette.length * cells });
        } catch (err) {
            skipped.push({ file, reason: (err as Error).message.replace(o.dir, '') });
        }
    }
    ranked.sort((a, b) => a.score - b.score || a.colors - b.colors || a.file.localeCompare(b.file, undefined, { numeric: true }));
    const names = uniqueNames(
        ranked.map((r) => r.file),
        o.existing.map((e) => e.name),
    );
    const ids = new Set(o.existing.map(entryId));
    const levels = ranked.map((r, i): PlannedLevel => {
        let id = idFromFile(r.file);
        const natural = id;
        for (let n = 2; ids.has(id); n++) id = `${natural}-${n}`;
        ids.add(id);
        return { ...r, id, explicitId: id !== natural, name: names.get(r.file)!, difficulty: difficultyAt(o.offset + i, o.curve) };
    });
    return { levels, skipped };
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv: string[]) {
    const o = { glob: undefined as string | undefined, dryRun: false, curve: { ...DEFAULT_CURVE }, offset: undefined as number | undefined };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const num = (): number => {
            const v = Number(argv[++i]);
            if (!Number.isFinite(v)) throw new Error(`${a} needs a number`);
            return v;
        };
        if (a === '--dry-run') o.dryRun = true;
        else if (a === '--from') o.curve.from = num();
        else if (a === '--to') o.curve.to = num();
        else if (a === '--ramp') o.curve.ramp = Math.max(1, Math.floor(num()));
        else if (a === '--lo') o.curve.lo = num();
        else if (a === '--hi') o.curve.hi = num();
        else if (a === '--period') o.curve.period = Math.max(1, Math.floor(num()));
        else if (a === '--offset') o.offset = Math.max(0, Math.floor(num()));
        else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
        else o.glob = a;
    }
    for (const k of ['from', 'to', 'lo', 'hi'] as const) {
        if (o.curve[k] < 0 || o.curve[k] > 1) throw new Error(`--${k} must be in 0..1`);
    }
    return o;
}

function main(): void {
    const args = parseArgs(process.argv.slice(2));
    const path = join(LEVELS_SRC, 'levels.json');
    const existing = loadEntries();
    const offset = args.offset ?? Math.max(0, existing.length - CURATED_LEVELS);
    const plan = planAdditions({ dir: LEVELS_SRC, existing, glob: args.glob, curve: args.curve, offset });

    for (const s of plan.skipped) console.warn(`skipped ${s.file}: ${s.reason}`);
    if (plan.levels.length === 0) {
        console.log('nothing to add: every PNG in levels-src/ is already in levels.json');
        return;
    }
    const w = (k: keyof PlannedLevel) => Math.max(k.length, ...plan.levels.map((l) => String(l[k]).length));
    const cols: [string, number][] = [['file', w('file')], ['name', w('name')], ['id', w('id')]];
    console.log(`${'#'.padStart(3)}  ${cols.map(([c, n]) => c.padEnd(n)).join('  ')}  colors  cells  score  difficulty`);
    plan.levels.forEach((l, i) => {
        console.log(
            `${String(existing.length + i + 1).padStart(3)}  ${l.file.padEnd(cols[0][1])}  ${l.name.padEnd(cols[1][1])}  ${l.id.padEnd(cols[2][1])}  ${String(l.colors).padStart(6)}  ${String(l.cells).padStart(5)}  ${String(l.score).padStart(5)}  ${l.difficulty.toFixed(2)}`,
        );
    });
    const ds = plan.levels.map((l) => l.difficulty);
    console.log(`\n${plan.levels.length} level(s) to add after the ${existing.length} existing, difficulty ${Math.min(...ds).toFixed(2)}..${Math.max(...ds).toFixed(2)}, curve position starts at ${offset}`);
    if (args.dryRun) {
        console.log('dry run: levels.json not written');
        return;
    }
    const raw = existsSync(path) ? readFileSync(path, 'utf8') : '[]\n';
    const lines = plan.levels.map((l) => formatEntry({ file: l.file, id: l.explicitId ? l.id : undefined, name: l.name, difficulty: l.difficulty }));
    writeFileSync(path, appendToLevelsJson(raw, lines));
    console.log(`appended to ${path}. Next: bun run gen:all && bun run verify`);
}

if (import.meta.main) main();
