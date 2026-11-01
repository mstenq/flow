import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { failedGen, processGenJob } from '../../tools/gen/gen-core';
import type { GenJob, GenResult } from '../../tools/gen/gen-core';
import { runPool } from '../../tools/gen/pool';
import { writePng, type RgbaImage } from '../../tools/gen/png';

function image(w: number, h: number, pixel: (x: number, y: number) => [number, number, number, number]): RgbaImage {
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) data.set(pixel(x, y), (y * w + x) * 4);
    }
    return { width: w, height: h, data };
}

describe('parallel gen:all', () => {
    const src = mkdtempSync(join(tmpdir(), 'flow-genall-src-'));
    const seqOut = mkdtempSync(join(tmpdir(), 'flow-genall-seq-'));
    const parOut = mkdtempSync(join(tmpdir(), 'flow-genall-par-'));
    const cols: Array<[number, number, number]> = [[255, 41, 80], [0, 240, 255], [255, 230, 0], [160, 90, 40], [250, 250, 250]];
    writePng(join(src, 'bars.png'), image(10, 8, (x) => [...cols[Math.floor(x / 2)], 255]));
    writePng(join(src, 'blob.png'), image(12, 12, (x, y) => (Math.hypot(x - 5.5, y - 5.5) < 5 ? [...(y < 6 ? cols[0] : cols[1]), 255] : [0, 0, 0, 0])));
    writePng(join(src, 'stripes.png'), image(9, 9, (_x, y) => [...cols[Math.floor(y / 3) % 3], 255]));
    const jobs: GenJob[] = [
        { id: 'bars', png: join(src, 'bars.png'), name: 'Bars', difficulty: 0.2, report: false, quick: true },
        { id: 'blob', png: join(src, 'blob.png'), name: 'Blob', difficulty: 0.5, report: false, quick: true },
        { id: 'stripes', png: join(src, 'stripes.png'), name: 'Stripes', difficulty: 0.8, report: false, quick: true },
    ];

    test('worker pool output is byte-identical to running the levels one after another', async () => {
        const sequential = jobs.map((j) => processGenJob({ ...j, outDir: seqOut }));
        expect(sequential.every((r) => r.status === 'ok')).toBe(true);
        const parallel = await runPool<GenJob, GenResult>({
            workerUrl: new URL('../../tools/gen/gen-worker.ts', import.meta.url),
            jobs: jobs.map((j) => ({ ...j, outDir: parOut })),
            size: 3,
            timeoutMs: 120_000,
            failure: (job, reason) => failedGen(job, reason),
        });
        expect(parallel.map((r) => r.id)).toEqual(['bars', 'blob', 'stripes']);
        expect(parallel.every((r) => r.status === 'ok')).toBe(true);
        for (const j of jobs) {
            expect(readFileSync(join(parOut, `${j.id}.json`), 'utf8')).toBe(readFileSync(join(seqOut, `${j.id}.json`), 'utf8'));
        }
        expect(parallel.map((r) => r.row.replace(/\s+[\d.]+s\s/, ' '))).toEqual(sequential.map((r) => r.row.replace(/\s+[\d.]+s\s/, ' ')));
    }, 120_000);

    test('a level that times out is recorded as a failure and the run keeps going', async () => {
        const results = await runPool<GenJob, GenResult>({
            workerUrl: new URL('../../tools/gen/gen-worker.ts', import.meta.url),
            jobs: jobs.map((j) => ({ ...j, outDir: parOut })),
            size: 2,
            timeoutMs: 1,
            failure: (job, reason) => failedGen(job, reason),
        });
        expect(results).toHaveLength(3);
        for (const r of results) {
            expect(r.status).toBe('failed');
            expect(r.error).toMatch(/timeout/);
        }
        rmSync(src, { recursive: true, force: true });
        rmSync(seqOut, { recursive: true, force: true });
        rmSync(parOut, { recursive: true, force: true });
    });

    test('a missing PNG becomes a failed result, not a crash', () => {
        const r = processGenJob({ id: 'nope', png: '/nonexistent/x.png', name: 'Nope', difficulty: 0.3, report: false, quick: true });
        expect(r.status).toBe('failed');
        expect(r.row).toContain('FAILED');
    });
});
