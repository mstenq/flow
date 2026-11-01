/**
 * bun run verify — replay every public/levels/*.json (dev fixtures included) with settled play against the
 * current rules. Exits non-zero if any level fails validation, has a stale rulesVersion, or does not win.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LevelData } from '@game/types';
import { RULES_VERSION } from '@game/level';
import { replay } from './board.ts';
import { LEVELS_OUT } from './output.ts';

function main(): void {
    const files = readdirSync(LEVELS_OUT)
        .filter((f) => f.endsWith('.json') && f !== 'index.json')
        .sort();
    let failed = 0;
    for (const f of files) {
        let level: LevelData;
        try {
            level = JSON.parse(readFileSync(join(LEVELS_OUT, f), 'utf8')) as LevelData;
        } catch (e) {
            console.log(`FAIL ${f}: invalid JSON (${(e as Error).message})`);
            failed++;
            continue;
        }
        if (level.rulesVersion !== RULES_VERSION) {
            console.log(`FAIL ${f}: rulesVersion ${level.rulesVersion} != current ${RULES_VERSION} (regenerate it)`);
            failed++;
            continue;
        }
        const r = replay(level);
        if (!r.won) {
            console.log(`FAIL ${f}: ${r.reason}`);
            failed++;
            continue;
        }
        console.log(`ok   ${f}  (${level.solution.length} taps, ${level.width}x${level.height})`);
    }
    console.log(failed ? `\n${failed} of ${files.length} level(s) FAILED` : `\nall ${files.length} level(s) verified`);
    if (failed) process.exit(1);
}

main();
