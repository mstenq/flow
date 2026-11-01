import { expect, test } from 'bun:test';
import { Sim } from '@game/sim';
import type { SimOptions } from '@game/sim';
import type { LevelData } from '@game/types';
import { Rng } from '@game/rng';
import { lvl } from './helpers';
import type { PodSpecInput } from './helpers';

/** Random clumpy board with `k` colors, pods sized 8..40 dealt round-robin into `cols` columns. */
function randomLevel(seed: number, w: number, h: number, k: number, cols: number, lanes: number): LevelData {
    const rng = new Rng(seed);
    const rows: string[] = [];
    const counts = new Array<number>(k).fill(0);
    let prevRow = '';
    for (let y = 0; y < h; y++) {
        let row = '';
        for (let x = 0; x < w; x++) {
            let c = rng.below(k);
            if (x > 0 && rng.chance(0.45)) c = Number(row[x - 1]);
            else if (y > 0 && rng.chance(0.45)) c = Number(prevRow[x]);
            counts[c]++;
            row += String(c);
        }
        rows.push(row);
        prevRow = row;
    }
    const pods: PodSpecInput[] = [];
    counts.forEach((total, c) => {
        let left = total;
        while (left > 0) {
            const cap = Math.min(left, rng.int(8, 40));
            pods.push([c, cap]);
            left -= cap;
        }
    });
    rng.shuffle(pods);
    const columns: PodSpecInput[][] = Array.from({ length: cols }, () => []);
    pods.forEach((p, i) => columns[i % cols].push(p));
    return lvl(rows.join('\n'), columns, lanes);
}

function greedyPlay(level: LevelData, opts: SimOptions): { sim: Sim; taps: number } {
    const sim = Sim.fromLevel(level, opts);
    let taps = 0;
    for (;;) {
        sim.settle();
        const legal = sim.legalTaps();
        if (legal.length === 0) break;
        const good = legal.find((col) => sim.hasReachable(sim.frontColor(col)));
        sim.tap(good ?? legal[0]);
        taps++;
    }
    return { sim, taps };
}

test('perf smoke: 48×48, 8 colors, greedy taps + settle in < 50ms', () => {
    const level = randomLevel(1, 48, 48, 8, 5, 6);
    const t0 = performance.now();
    const { sim, taps } = greedyPlay(level, { emitPaths: true });
    const ms = performance.now() - t0;
    console.log(`[perf] 48×48×8 greedy (events + paths): ${ms.toFixed(1)}ms, ${taps} taps, ${sim.ticks} ticks, won=${sim.isWon()}, left=${sim.cellsRemaining}`);
    expect(sim.isWon()).toBe(true);
    expect(ms).toBeLessThan(50);

    const t1 = performance.now();
    const quiet = greedyPlay(level, { events: false });
    const ms1 = performance.now() - t1;
    console.log(`[perf] 48×48×8 greedy (events off): ${ms1.toFixed(1)}ms`);
    expect(ms1).toBeLessThan(50);
    expect(quiet.sim.hash()).toBe(sim.hash());
});

for (const [w, k, cols, lanes] of [
    [24, 6, 4, 4],
    [48, 8, 5, 6],
] as const) {
    test(`solver throughput: clone() + tap() + settle() cycles per second (${w}×${w}, ${k} colors)`, () => {
        const level = randomLevel(7, w, w, k, cols, lanes);
        const root = Sim.fromLevel(level, { events: false });
        // Collect mid-game states along a greedy line to branch from.
        const states: Sim[] = [];
        const walker = root.clone();
        for (;;) {
            walker.settle();
            const legal = walker.legalTaps();
            if (legal.length === 0) break;
            states.push(walker.clone());
            const good = legal.find((col) => walker.hasReachable(walker.frontColor(col)));
            walker.tap(good ?? legal[0]);
        }
        expect(states.length).toBeGreaterThan(3);
        const seen = new Set<number>();
        let cycles = 0;
        const t0 = performance.now();
        while (performance.now() - t0 < 300) {
            for (const s of states) {
                for (const col of s.legalTaps()) {
                    const c = s.clone();
                    c.tap(col);
                    c.settle();
                    seen.add(c.hashKey());
                    cycles++;
                }
            }
        }
        const sec = (performance.now() - t0) / 1000;
        console.log(`[perf] ${w}×${w}×${k}: ${Math.round(cycles / sec).toLocaleString()} clone+tap+settle cycles/s (${states.length} branch states, ${seen.size} distinct)`);
        expect(cycles).toBeGreaterThan(0);
    });
}
