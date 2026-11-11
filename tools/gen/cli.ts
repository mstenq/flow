/**
 * bun run gen <png> [--difficulty 0.4] [--seed 7] [--name X] [--id X] [--report] [--max-colors N] [--min-region N] [--max-pod N] [--outline 0|1] [--background 0|1]
 *
 * Writes public/levels/<id>.json, regenerates public/levels/index.json, prints a summary.
 * Defaults come from the matching levels-src/levels.json entry (by id, else by file), then from the file name.
 */
import { basename, resolve } from 'node:path';
import { entryId, idFromFile, loadEntries, runOne, writeIndex } from './output.ts';

const USAGE = 'usage: bun run gen <png> [--difficulty 0.4] [--seed 7] [--name X] [--id X] [--report] [--max-colors N] [--min-region N] [--max-pod N] [--outline 0|1] [--background 0|1]';

function parseArgs(argv: string[]): { png: string; flags: Map<string, string | true> } {
    const flags = new Map<string, string | true>();
    let png = '';
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) {
            png = a;
            continue;
        }
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
            flags.set(a, true);
            continue;
        }
        flags.set(a, next);
        i++;
    }
    return { png, flags };
}

function num(flags: Map<string, string | true>, name: string): number | undefined {
    const v = flags.get(name);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (v === true || !Number.isFinite(n)) throw new Error(`${name} needs a number`);
    return n;
}

function str(flags: Map<string, string | true>, name: string): string | undefined {
    const v = flags.get(name);
    if (v === undefined) return undefined;
    if (v === true) throw new Error(`${name} needs a value`);
    return v;
}

function main(): void {
    const { png, flags } = parseArgs(process.argv.slice(2));
    if (!png || flags.has('--help')) {
        console.error(USAGE);
        process.exit(png ? 0 : 1);
    }
    const file = basename(png);
    const wantId = str(flags, '--id');
    const entries = loadEntries();
    const entry = entries.find((e) => (wantId ? entryId(e) === wantId : e.file === file && e.id === undefined)) ?? entries.find((e) => e.file === file);
    const id = wantId ?? (entry ? entryId(entry) : idFromFile(file));
    const run = runOne({
        png: resolve(png),
        id,
        name: str(flags, '--name') ?? entry?.name ?? id,
        difficulty: num(flags, '--difficulty') ?? entry?.difficulty ?? 0.4,
        seed: num(flags, '--seed') ?? entry?.seed,
        maxColors: num(flags, '--max-colors') ?? entry?.maxColors,
        minRegion: num(flags, '--min-region') ?? entry?.minRegion,
        maxPod: num(flags, '--max-pod') ?? entry?.maxPod,
        outline: flags.has('--outline') ? num(flags, '--outline') === 1 : undefined,
        background: flags.has('--background') ? num(flags, '--background') === 1 : undefined,
        report: flags.has('--report'),
    });
    console.log(run.summary.join('\n'));
    const index = writeIndex();
    const listed = index.some((e) => e.id === id);
    console.log(`index    ${index.length} level(s)${listed ? '' : ` — note: "${id}" is not in levels-src/levels.json, so it is not listed (open it with ?level=${id})`}`);
}

main();
