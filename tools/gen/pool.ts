/**
 * Minimal Bun worker pool: `n` workers pull jobs in order, each job has a timeout and a crash guard, results come
 * back in job order. A timed-out or crashed worker is replaced and the run keeps going (the job becomes a failure).
 */
export interface PoolOptions<J, R> {
    workerUrl: URL;
    jobs: J[];
    size: number;
    timeoutMs: number;
    /** Called as each job finishes, in completion order. */
    onDone?: (result: R, job: J, done: number) => void;
    /** Build the failure result for a job whose worker timed out or crashed. */
    failure: (job: J, reason: string) => R;
}

export async function runPool<J, R>(opts: PoolOptions<J, R>): Promise<R[]> {
    const { jobs, workerUrl, timeoutMs } = opts;
    const results: R[] = new Array(jobs.length);
    let next = 0;
    let done = 0;
    const lane = async () => {
        let worker = new Worker(workerUrl);
        while (true) {
            const idx = next++;
            if (idx >= jobs.length) break;
            const job = jobs[idx];
            const res = await new Promise<R>((resolve) => {
                const replace = () => {
                    worker.terminate();
                    worker = new Worker(workerUrl);
                };
                const timer = setTimeout(() => {
                    replace();
                    resolve(opts.failure(job, `timeout after ${Math.round(timeoutMs / 1000)}s`));
                }, timeoutMs);
                worker.onmessage = (e: MessageEvent<R>) => {
                    clearTimeout(timer);
                    resolve(e.data);
                };
                worker.onerror = (e) => {
                    clearTimeout(timer);
                    replace();
                    resolve(opts.failure(job, `worker crash: ${e.message}`));
                };
                worker.postMessage(job);
            });
            results[idx] = res;
            opts.onDone?.(res, job, ++done);
        }
        worker.terminate();
    };
    await Promise.all(Array.from({ length: Math.min(opts.size, jobs.length) }, lane));
    return results;
}

/** "3m05s" / "42s" for progress lines. */
export function formatDuration(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}
