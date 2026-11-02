/**
 * Shared CLI plumbing: levels.json entries, stable JSON formatting, public/levels/index.json, and the
 * generate → write → report → console-summary routine used by `gen` and `gen:all`.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LevelData } from '@game/types';
import { hashString } from '@game/rng';
import { readPng } from './png.ts';
import { generateLevel } from './generate.ts';
import type { GenerateResult } from './generate.ts';
import { knobsSummary } from './knobs.ts';
import { writeReport } from './report.ts';
import { isFastPlayTrap } from './difficulty.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '../..');
export const LEVELS_SRC = join(ROOT, 'levels-src');
export const LEVELS_OUT = join(ROOT, 'public/levels');
export const REPORT_OUT = join(HERE, 'out');

export interface LevelEntry {
    file: string;
    name: string;
    difficulty: number;
    id?: string;
    seed?: number;
    maxColors?: number;
    minRegion?: number;
    /** Cap on pod capacity (cells). */
    maxPod?: number;
}

export function idFromFile(file: string): string {
    return basename(file)
        .replace(/\.png$/i, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

export function entryId(e: LevelEntry): string {
    return e.id ?? idFromFile(e.file);
}

export function loadEntries(): LevelEntry[] {
    const path = join(LEVELS_SRC, 'levels.json');
    if (!existsSync(path)) return [];
    const entries = JSON.parse(readFileSync(path, 'utf8')) as LevelEntry[];
    const ids = new Set<string>();
    for (const e of entries) {
        const id = entryId(e);
        if (id.startsWith('dev-')) throw new Error(`levels.json: id "${id}" is reserved (dev-* belongs to the game's fixtures)`);
        if (ids.has(id)) throw new Error(`levels.json: duplicate id "${id}" (add an "id" field to tell entries apart)`);
        ids.add(id);
    }
    return entries;
}

export function sourceHash(path: string): string {
    return createHash('sha1').update(readFileSync(path)).digest('hex').slice(0, 16);
}

/** Stable, diff-friendly JSON: one line per column, compact pods, pretty top level. */
export function formatLevel(level: LevelData): string {
    const j = (v: unknown) => JSON.stringify(v);
    const lines: string[] = ['{'];
    const top: [string, string][] = [
        ['version', j(level.version)],
        ['rulesVersion', j(level.rulesVersion)],
        ['id', j(level.id)],
        ['name', j(level.name)],
        ['width', j(level.width)],
        ['height', j(level.height)],
        ['palette', j(level.palette)],
        ['cells', j(level.cells)],
        ['keys', j(level.keys)],
        ['lanes', j(level.lanes)],
        ['tickMs', j(level.tickMs)],
        ['columns', `[\n${level.columns.map((c) => `    ${j(c)}`).join(',\n')}\n  ]`],
        ['solution', j(level.solution)],
        ['meta', JSON.stringify(level.meta, null, 2).replace(/\n/g, '\n  ')],
    ];
    top.forEach(([k, v], i) => lines.push(`  ${j(k)}: ${v}${i < top.length - 1 ? ',' : ''}`));
    lines.push('}');
    return lines.join('\n') + '\n';
}

/** Rewrite public/levels/index.json from levels.json order (only entries with a generated file; never dev-*). */
export interface IndexEntry {
    id: string;
    name: string;
    width: number;
    height: number;
    difficulty: number;
    /** Level palette and image (row-major, '.' = empty), so the level select can draw thumbnails without fetching every level. */
    palette: string[];
    cells: string;
}

export function writeIndex(): IndexEntry[] {
    const index: IndexEntry[] = [];
    for (const e of loadEntries()) {
        const id = entryId(e);
        const path = join(LEVELS_OUT, `${id}.json`);
        if (!existsSync(path)) continue;
        const level = JSON.parse(readFileSync(path, 'utf8')) as LevelData;
        index.push({
            id,
            name: level.name,
            width: level.width,
            height: level.height,
            difficulty: level.meta.difficulty,
            palette: level.palette,
            cells: level.cells,
        });
    }
    mkdirSync(LEVELS_OUT, { recursive: true });
    writeFileSync(join(LEVELS_OUT, 'index.json'), `[\n${index.map((e) => `  ${JSON.stringify(e)}`).join(',\n')}\n]\n`);
    return index;
}

export interface RunOptions {
    png: string;
    id: string;
    name: string;
    difficulty: number;
    seed?: number;
    maxColors?: number;
    minRegion?: number;
    maxPod?: number;
    report: boolean;
    /** Override the output directory (tests). */
    outDir?: string;
    quick?: boolean;
}

export interface RunResult {
    result: GenerateResult;
    path: string;
    json: string;
    reportPaths: { html: string; preview: string } | null;
    summary: string[];
}

function pct(v: number): string {
    return `${(v * 100).toFixed(1)}%`;
}

/** Generate one level, write its JSON (and report), and return the console summary lines. */
export function runOne(opts: RunOptions): RunResult {
    const t0 = performance.now();
    const image = readPng(opts.png);
    const seed = opts.seed ?? hashString(opts.id);
    const result = generateLevel({
        image,
        id: opts.id,
        name: opts.name,
        difficulty: opts.difficulty,
        seed,
        maxColors: opts.maxColors,
        minRegion: opts.minRegion,
        maxPod: opts.maxPod,
        sourceHash: sourceHash(opts.png),
        quick: opts.quick,
    });
    const { level, stats } = result;
    const json = formatLevel(level);
    const outDir = opts.outDir ?? LEVELS_OUT;
    mkdirSync(outDir, { recursive: true });
    const path = join(outDir, `${level.id}.json`);
    writeFileSync(path, json);

    const pods = level.columns.flat();
    const mech = `${stats.lockCount} lock(s), ${stats.pairCount} pair(s), ${pods.filter((p) => p.hidden).length} hidden`;
    const summary = [
        `== ${level.name} (${level.id}) ==`,
        `board    ${level.width}x${level.height}, ${pods.reduce((s, p) => s + p.capacity, 0)} cells, ${level.palette.length} colors`,
        ...result.simplified.log.map((l) => `  simplify: ${l}`),
        `pods     ${pods.length} in ${level.columns.length} columns (${level.columns.map((c) => c.length).join('/')}), ${level.lanes} lanes, tick ${level.tickMs}ms, ${level.solution.length} solution taps`,
        `mechanics ${mech}`,
        `knobs    (start) ${knobsSummary(result.knobs)}`,
        `stats    smart ${pct(stats.smartWinRate)}, greedy ${pct(stats.greedyWinRate)}, random ${pct(stats.randomWinRate)}, deadEnd ${stats.deadEndRatio.toFixed(3)}, ` +
            `minLanes ${stats.minLanes}${stats.minLanesProven === false ? '(budget)' : ''}/${level.lanes}, branching ${stats.branching.toFixed(2)}, ` +
            `overflow ${stats.overflowPods}, peakStalled ${stats.peakStalled}, hidden ${stats.hiddenShare.toFixed(2)}`,
        `fast     greedy ${pct(stats.fastGreedyWinRate ?? 0)}, random ${pct(stats.fastRandomWinRate ?? 0)} (tap-whenever-possible; settled greedy ${pct(stats.greedyWinRate)}, random ${pct(stats.randomWinRate)})`,
        `pods     max ${stats.maxPodCapacity}, median ${stats.medianPodCapacity} cells, longest drain ~${(stats.longestDrainSec ?? 0).toFixed(1)}s at 1x${opts.maxPod !== undefined ? ` (--max-pod ${opts.maxPod})` : ''}`,
        ...(isFastPlayTrap(stats)
            ? [`WARNING fast-play trap: settled greedy ${pct(stats.greedyWinRate)} but fast greedy ${pct(stats.fastGreedyWinRate ?? 0)} (< half). Tapping early can jam the lanes.`]
            : []),
        `difficulty ${level.meta.difficulty.toFixed(3)} (target ${level.meta.targetDifficulty.toFixed(2)}, off by ${(level.meta.difficulty - level.meta.targetDifficulty).toFixed(3)})`,
        ...result.log.map((l) => `  gen: ${l}`),
    ];
    let reportPaths: { html: string; preview: string } | null = null;
    if (opts.report) {
        const tr = performance.now();
        reportPaths = writeReport(REPORT_OUT, {
            level,
            image,
            simplified: result.simplified,
            trace: result.trace,
            summary: summary.slice(),
            timings: result.timings,
            knobs: knobsSummary(result.knobs).replace(/, /g, '\n'),
        });
        result.timings.report = performance.now() - tr;
    }
    const total = performance.now() - t0;
    summary.push(
        `time     ${(total / 1000).toFixed(2)}s  (` +
            Object.entries(result.timings)
                .filter(([k]) => k !== 'total')
                .map(([k, v]) => `${k} ${(v / 1000).toFixed(2)}`)
                .join(', ') +
            ')',
    );
    summary.push(`wrote    ${path}`);
    if (reportPaths) summary.push(`report   ${reportPaths.html}`, `preview  ${reportPaths.preview}`);
    return { result, path, json, reportPaths, summary };
}
