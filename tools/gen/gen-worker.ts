/** Bun worker for `gen:all`: receives GenJobs, replies with GenResults. */
import { processGenJob } from './gen-core.ts';
import type { GenJob } from './gen-core.ts';

declare const self: Worker;
self.onmessage = (e: MessageEvent<GenJob>) => {
    self.postMessage(processGenJob(e.data));
};
