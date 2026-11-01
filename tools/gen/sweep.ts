/**
 * bun run gen:sweep [glob] [--difficulty 0.4] [--simplify-only] [--limit N] [--every N] [--jobs N] [--out stem] [--timeout S] [--include-listed]
 *
 * Runs the pipeline in memory over levels-src/*.png (default: those not already in levels.json) and writes
 * tools/gen/out/sweep.html + sweep.json. Never writes to public/levels. Each file is isolated; failures are recorded.
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { LEVELS_SRC, REPORT_OUT, loadEntries } from './output.ts';
import type { SweepJob, SweepResult } from './sweep-core.ts';
import { niceName } from './sweep-core.ts';
import { sweepHtml } from './sweep-html.ts';
import { runPool } from './pool.ts';

function failedResult(job: SweepJob, error: string, totalMs: number): SweepResult {
    return { file: job.file, name: niceName(job.file), status: 'failed', error, width: 0, height: 0, sourceColors: 0, finalColors: 0, cells: 0, simplifyMs: 0, totalMs, thumbOrig: '', thumbBoard: '' };
}

function parse(argv: string[]) {
    const o = { glob: '*.png', difficulty: 0.4, simplifyOnly: false, limit: Infinity, jobs: Math.max(1, Math.min(8, cpus().length - 2)), timeout: 90, includeListed: false, out: 'sweep', every: 1 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const val = () => {
            const v = argv[++i];
            if (v === undefined) throw new Error(`${a} needs a value`);
            return v;
        };
        if (a === '--difficulty') o.difficulty = Number(val());
        else if (a === '--simplify-only') o.simplifyOnly = true;
        else if (a === '--limit') o.limit = Number(val());
        else if (a === '--jobs') o.jobs = Math.max(1, Number(val()));
        else if (a === '--timeout') o.timeout = Number(val());
        else if (a === '--include-listed') o.includeListed = true;
        else if (a === '--out') o.out = val();
        else if (a === '--every') o.every = Math.max(1, Number(val()));
        else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
        else o.glob = a.endsWith('.png') ? a : `${a}`;
    }
    if (!Number.isFinite(o.difficulty) || o.difficulty < 0 || o.difficulty > 1) throw new Error('--difficulty must be a number in 0..1');
    if (!Number.isFinite(o.timeout) || o.timeout <= 0) throw new Error('--timeout must be a positive number of seconds');
    return o;
}

function pctile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function main(): Promise<void> {
    const o = parse(process.argv.slice(2));
    const listed = new Set(loadEntries().map((e) => e.file));
    const glob = new Bun.Glob(o.glob);
    let files = readdirSync(LEVELS_SRC)
        .filter((f) => /\.png$/i.test(f) && glob.match(f) && (o.includeListed || !listed.has(f)))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    files = files.filter((_, i) => i % o.every === 0).slice(0, o.limit);
    if (files.length === 0) {
        console.error('no matching PNGs');
        process.exit(1);
    }
    console.log(`sweep: ${files.length} file(s), ${o.simplifyOnly ? 'simplify-only' : `full @ ${o.difficulty}`}, ${o.jobs} worker(s)`);
    const t0 = performance.now();
    const jobs: SweepJob[] = files.map((file) => ({ file, dir: LEVELS_SRC, difficulty: o.difficulty, simplifyOnly: o.simplifyOnly }));
    const results = await runPool<SweepJob, SweepResult>({
        workerUrl: new URL('./sweep-worker.ts', import.meta.url),
        jobs,
        size: o.jobs,
        timeoutMs: o.timeout * 1000,
        failure: (job, reason) => failedResult(job, reason, reason.startsWith('timeout') ? o.timeout * 1000 : 0),
        onDone: (r, _job, done) => {
            if (r.status !== 'failed' && r.totalMs <= 20000 && done % 25 !== 0 && done !== jobs.length) return;
            const tag = r.status === 'failed' ? `FAIL ${r.error}` : r.totalMs > 20000 ? `SLOW ${(r.totalMs / 1000).toFixed(1)}s` : '';
            console.log(`  [${done}/${jobs.length}] ${r.file} ${tag}`);
        },
    });
    const wall = (performance.now() - t0) / 1000;

    mkdirSync(REPORT_OUT, { recursive: true });
    const meta = { mode: o.simplifyOnly ? ('simplify-only' as const) : ('full' as const), difficulty: o.difficulty, generated: new Date().toISOString() };
    const stem = join(REPORT_OUT, o.out);
    writeFileSync(`${stem}.html`, sweepHtml(results, meta));
    writeFileSync(`${stem}.json`, JSON.stringify({ meta, results: results.map(({ thumbOrig, thumbBoard, ...r }) => r) }, null, 1));

    // Summary.
    const ok = results.filter((r) => r.status === 'ok');
    const bad = results.filter((r) => r.status === 'failed');
    console.log(`\n== summary: ${ok.length} ok, ${bad.length} failed, wall ${wall.toFixed(1)}s ==`);
    const reasons = new Map<string, string[]>();
    for (const r of bad) {
        const k = (r.error ?? '').replace(/\d+/g, 'N').slice(0, 120);
        reasons.set(k, [...(reasons.get(k) ?? []), r.file]);
    }
    for (const [k, v] of reasons) console.log(`  ${v.length}x ${k}  e.g. ${v.slice(0, 3).join(', ')}`);
    const times = ok.map((r) => r.totalMs / 1000).sort((a, b) => a - b);
    console.log(`time (s): p50 ${pctile(times, 50).toFixed(2)}  p90 ${pctile(times, 90).toFixed(2)}  p99 ${pctile(times, 99).toFixed(2)}  max ${pctile(times, 100).toFixed(2)}`);
    const dist = new Map<number, number>();
    for (const r of ok) dist.set(r.finalColors, (dist.get(r.finalColors) ?? 0) + 1);
    console.log('final colors: ' + [...dist].sort((a, b) => a[0] - b[0]).map(([c, n]) => `${c}:${n}`).join('  '));
    if (!o.simplifyOnly) {
        const errs = ok.map((r) => Math.abs((r.difficulty ?? 0) - (r.target ?? 0))).sort((a, b) => a - b);
        console.log(`|difficulty - target|: p50 ${pctile(errs, 50).toFixed(3)}  p90 ${pctile(errs, 90).toFixed(3)}  max ${pctile(errs, 100).toFixed(3)}`);
    }
    console.log('slowest 10:');
    for (const r of [...results].sort((a, b) => b.totalMs - a.totalMs).slice(0, 10)) console.log(`  ${(r.totalMs / 1000).toFixed(2).padStart(6)}s ${r.file} ${r.status === 'failed' ? '(failed)' : ''}`);
    console.log(`\nwrote ${stem}.html\nwrote ${stem}.json`);
}

main();
