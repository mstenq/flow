/**
 * bun run gen:all [--force] [--no-report] [--jobs N] [--timeout S] [--verbose] [--only id1,id2,...]
 *
 * Generates every entry of levels-src/levels.json on a pool of Bun workers (default: CPU count - 1). An entry is
 * skipped when its cache key (source hash + params + palette + GENERATOR_VERSION + RULES_VERSION) is unchanged and
 * its output exists. Output files are identical to a sequential run: every level is generated independently from
 * its own seed. public/levels/index.json is rewritten once, at the end.
 *
 * `--only` limits the run to the listed ids (the cache still applies; add --force to regenerate them anyway). Other
 * entries are left untouched, cache entries included.
 *
 * Fill-first eligibility is positional (`fillFirstEligible`: all but the first entries), so it is part of the
 * cache key: moving a level into or out of the first entries regenerates it.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { RULES_VERSION } from '@game/level';
import { hashString } from '@game/rng';
import { NEON_PALETTE } from '@data/palette';
import { GENERATOR_VERSION } from './board.ts';
import { fillFirstEligible } from './knobs.ts';
import type { GenJob, GenResult } from './gen-core.ts';
import { failedGen } from './gen-core.ts';
import type { LevelEntry } from './output.ts';
import { LEVELS_OUT, LEVELS_SRC, REPORT_OUT, entryId, loadEntries, sourceHash, writeIndex } from './output.ts';
import { formatDuration, runPool } from './pool.ts';

const CACHE_PATH = join(LEVELS_SRC, '.gen-cache.json');
const PALETTE_KEY = createHash('sha1').update(JSON.stringify(NEON_PALETTE)).digest('hex').slice(0, 8);

/** `fillFirst`: the entry is eligible (`fillFirstEligible` of its levels.json index). */
export function cacheKey(e: LevelEntry, src: string, fillFirst: boolean): string {
    const params = {
        name: e.name,
        difficulty: e.difficulty,
        seed: e.seed ?? hashString(entryId(e)),
        maxColors: e.maxColors,
        minRegion: e.minRegion,
        maxPod: e.maxPod,
        fillFirst: fillFirst || undefined,
    };
    return createHash('sha1')
        .update([sourceHash(src), JSON.stringify(params), PALETTE_KEY, GENERATOR_VERSION, RULES_VERSION].join('|'))
        .digest('hex')
        .slice(0, 16);
}

interface Options {
    force: boolean;
    report: boolean;
    jobs: number;
    timeoutS: number;
    verbose: boolean;
    /** Only these ids (null = every entry). */
    only: Set<string> | null;
}

export function defaultJobs(): number {
    return Math.max(1, cpus().length - 1);
}

function parseArgs(argv: string[]): Options {
    const o: Options = { force: false, report: true, jobs: defaultJobs(), timeoutS: 180, verbose: false, only: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const num = (): number => {
            const v = Number(argv[++i]);
            if (!Number.isFinite(v) || v <= 0) throw new Error(`${a} needs a positive number`);
            return v;
        };
        if (a === '--force') o.force = true;
        else if (a === '--no-report') o.report = false;
        else if (a === '--verbose') o.verbose = true;
        else if (a === '--jobs') o.jobs = Math.max(1, Math.floor(num()));
        else if (a === '--timeout') o.timeoutS = num();
        else if (a === '--only') o.only = new Set((argv[++i] ?? '').split(',').filter((id) => id.length > 0));
        else throw new Error(`unknown flag ${a}`);
    }
    return o;
}

async function main(): Promise<void> {
    const o = parseArgs(process.argv.slice(2));
    const entries = loadEntries();
    if (entries.length === 0) {
        console.error('levels-src/levels.json is missing or empty');
        process.exit(1);
    }
    const cache: Record<string, string> = existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, 'utf8')) : {};
    const nextCache: Record<string, string> = {};
    const rowById = new Map<string, string>();
    const todo: GenJob[] = [];
    const keys = new Map<string, string>();
    const failures: string[] = [];
    let cached = 0;
    let untouched = 0;
    const t0 = performance.now();
    if (o.only) {
        const known = new Set(entries.map(entryId));
        const unknown = [...o.only].filter((id) => !known.has(id));
        if (o.only.size === 0 || unknown.length > 0) throw new Error(`--only: unknown id(s) ${unknown.join(', ') || '(none given)'}`);
    }

    for (const [index, e] of entries.entries()) {
        const id = entryId(e);
        if (o.only && !o.only.has(id)) {
            if (cache[id]) nextCache[id] = cache[id];
            untouched++;
            continue;
        }
        const src = join(LEVELS_SRC, e.file);
        if (!existsSync(src)) {
            console.error(`!! ${id}: missing ${src}`);
            failures.push(id);
            continue;
        }
        const fillFirst = fillFirstEligible(index);
        const key = cacheKey(e, src, fillFirst);
        const out = join(LEVELS_OUT, `${id}.json`);
        const reportOk = !o.report || existsSync(join(REPORT_OUT, `${id}.html`));
        if (!o.force && cache[id] === key && existsSync(out) && reportOk) {
            const level = JSON.parse(readFileSync(out, 'utf8'));
            rowById.set(id, `${id.padEnd(16)} cached   target ${e.difficulty.toFixed(2)}  got ${level.meta.difficulty.toFixed(3)}  colors ${level.palette.length}`);
            nextCache[id] = key;
            cached++;
            continue;
        }
        keys.set(id, key);
        todo.push({ id, png: src, name: e.name, difficulty: e.difficulty, seed: e.seed, maxColors: e.maxColors, minRegion: e.minRegion, maxPod: e.maxPod, fillFirst, report: o.report });
    }

    const jobs = Math.min(o.jobs, Math.max(1, todo.length));
    console.log(`gen:all: ${entries.length} level(s), ${o.only ? `${untouched} left out (--only), ` : ''}${cached} cached, ${todo.length} to generate on ${jobs} worker(s)${o.report ? '' : ' (no reports)'}`);

    let cpuMs = 0;
    let reportMs = 0;
    let budgetWarnings = 0;
    const tRun = performance.now();
    const results = await runPool<GenJob, GenResult>({
        workerUrl: new URL('./gen-worker.ts', import.meta.url),
        jobs: todo,
        size: jobs,
        timeoutMs: o.timeoutS * 1000,
        failure: (job, reason) => failedGen(job, reason, reason.startsWith('timeout') ? o.timeoutS * 1000 : 0),
        onDone: (r, _job, done) => {
            cpuMs += r.ms;
            reportMs += r.reportMs;
            if (r.warnings.length > 0) budgetWarnings++;
            const elapsed = performance.now() - tRun;
            const eta = (elapsed / done) * (todo.length - done);
            const tag = r.status === 'failed' ? `FAILED ${(r.error ?? '').split('\n')[0]}` : `${(r.ms / 1000).toFixed(1)}s  colors ${r.colors}  target ${r.target.toFixed(2)} got ${r.difficulty.toFixed(3)}`;
            console.log(`[${String(done).padStart(String(todo.length).length)}/${todo.length}] ${r.id.padEnd(22)} ${tag}  ETA ${formatDuration(eta)}`);
            if (o.verbose && r.summary.length > 0) console.log(r.summary.join('\n') + '\n');
            if (r.status === 'failed' && o.verbose && r.error) console.error(r.error);
        },
    });

    results.forEach((r) => {
        rowById.set(r.id, r.row);
        if (r.status === 'failed') {
            failures.push(r.id);
            return;
        }
        nextCache[r.id] = keys.get(r.id)!;
    });
    // Deterministic cache file: levels.json order.
    const ordered: Record<string, string> = {};
    for (const e of entries) {
        const id = entryId(e);
        if (nextCache[id]) ordered[id] = nextCache[id];
    }
    writeFileSync(CACHE_PATH, JSON.stringify(ordered, null, 2) + '\n');
    const index = writeIndex();

    const wall = (performance.now() - t0) / 1000;
    console.log('\n' + entries.map((e) => rowById.get(entryId(e))).filter(Boolean).join('\n'));
    console.log(`\n${index.length} level(s) in public/levels/index.json`);
    if (todo.length > 0) {
        console.log(
            `generated ${todo.length - results.filter((r) => r.status === 'failed').length}/${todo.length} in ${formatDuration(performance.now() - tRun)} wall ` +
                `(${(cpuMs / 1000).toFixed(0)}s of level time, ${(reportMs / 1000).toFixed(0)}s of it for reports${o.report ? '' : ', disabled'})`,
        );
    }
    if (budgetWarnings > 0) console.log(`WARNING: ${budgetWarnings} level(s) hit the generator's wall-clock budget; rerun with fewer --jobs if you need output identical across machines`);
    console.log(`${wall.toFixed(1)}s total${failures.length ? ` · ${failures.length} FAILED: ${failures.join(', ')}` : ''}`);
    if (failures.length > 0) process.exit(1);
}

if (import.meta.main) await main();
