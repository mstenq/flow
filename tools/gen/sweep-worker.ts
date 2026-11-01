/** Bun worker: receives SweepJobs, replies with SweepResults. */
import { processJob } from './sweep-core.ts';
import type { SweepJob } from './sweep-core.ts';

declare const self: Worker;
self.onmessage = (e: MessageEvent<SweepJob>) => {
    self.postMessage(processJob(e.data));
};
