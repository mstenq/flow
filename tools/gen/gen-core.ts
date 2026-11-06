/** Per-level work for `gen:all`: generate one level (and its report) and describe the outcome. Runs in a worker. */
import { isFastPlayTrap } from './difficulty.ts';
import { runOne } from './output.ts';

export interface GenJob {
    id: string;
    png: string;
    name: string;
    difficulty: number;
    seed?: number;
    maxColors?: number;
    minRegion?: number;
    maxPod?: number;
    /** Eligible for fill-first lanes (see `fillFirstEligible`). */
    fillFirst?: boolean;
    report: boolean;
    /** Override the level output directory (tests). */
    outDir?: string;
    /** Cheaper search (tests). */
    quick?: boolean;
}

export interface GenResult {
    id: string;
    status: 'ok' | 'failed';
    error?: string;
    ms: number;
    /** Time spent writing the HTML report + preview (part of `ms`). */
    reportMs: number;
    /** One table line for the end-of-run summary. */
    row: string;
    /** Full per-level console summary (printed with --verbose). */
    summary: string[];
    /** Generator warnings (e.g. the wall-clock budget ended a search early, which makes output machine-dependent). */
    warnings: string[];
    colors: number;
    target: number;
    difficulty: number;
}

export function failedGen(job: Pick<GenJob, 'id'>, error: string, ms = 0): GenResult {
    return { id: job.id, status: 'failed', error, ms, reportMs: 0, row: `${job.id.padEnd(16)} FAILED   ${error.split('\n')[0]}`, summary: [], warnings: [], colors: 0, target: 0, difficulty: 0 };
}

export function processGenJob(job: GenJob): GenResult {
    const t = performance.now();
    try {
        const run = runOne({ png: job.png, id: job.id, name: job.name, difficulty: job.difficulty, seed: job.seed, maxColors: job.maxColors, minRegion: job.minRegion, maxPod: job.maxPod, fillFirst: job.fillFirst, report: job.report, outDir: job.outDir, quick: job.quick });
        const ms = performance.now() - t;
        const level = run.result.level;
        const m = level.meta;
        const s = m.stats;
        const row =
            `${job.id.padEnd(16)} ${(ms / 1000).toFixed(1).padStart(5)}s   target ${m.targetDifficulty.toFixed(2)}  got ${m.difficulty.toFixed(3)}` +
            `  smart ${(s.smartWinRate * 100).toFixed(0).padStart(3)}%  greedy ${(s.greedyWinRate * 100).toFixed(0).padStart(3)}%  random ${(s.randomWinRate * 100).toFixed(0).padStart(3)}%` +
            `  fast ${((s.fastGreedyWinRate ?? 0) * 100).toFixed(0).padStart(3)}%/${((s.fastRandomWinRate ?? 0) * 100).toFixed(0).padStart(3)}%${isFastPlayTrap(s) ? ' TRAP' : ''}` +
            `  maxPod ${s.maxPodCapacity} drain ${(s.longestDrainSec ?? 0).toFixed(1)}s` +
            `  colors ${level.palette.length}  lanes ${level.lanes}${level.fillFirst ? ' ff' : ''}  pods ${level.columns.flat().length}`;
        return {
            id: job.id,
            status: 'ok',
            ms,
            reportMs: run.result.timings.report ?? 0,
            row,
            summary: run.summary,
            warnings: run.result.log.filter((l) => l.startsWith('WARNING')),
            colors: level.palette.length,
            target: m.targetDifficulty,
            difficulty: m.difficulty,
        };
    } catch (err) {
        return failedGen(job, (err as Error).stack ?? String(err), performance.now() - t);
    }
}
