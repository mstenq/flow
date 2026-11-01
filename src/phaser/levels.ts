/** Fetching level JSON and the level list (index.json + dev levels). Browser only. */
import type { LevelData } from '@game/types';
import { mergeLevelEntries, parseLevelIndex, repeatEntries } from '@game/levelList';
import type { LevelEntry } from '@game/levelList';

let listPromise: Promise<LevelEntry[]> | null = null;

export async function fetchLevel(id: string): Promise<LevelData> {
    const res = await fetch(`levels/${encodeURIComponent(id)}.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`Level "${id}" not found (HTTP ${res.status})`);
    return (await res.json()) as LevelData;
}

/** Dev builds only: `?fakelevels=N` repeats the index entries in memory up to N (stress-tests the level select). */
function fakeLevelCount(): number {
    if (!import.meta.env.DEV) return 0;
    const n = Number(new URLSearchParams(window.location.search).get('fakelevels'));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * `levels/index.json` entries (if the file exists), plus the dev levels in dev builds. Parsed once and cached per
 * session (start it early: the Preloader does).
 */
export function loadLevelList(): Promise<LevelEntry[]> {
    listPromise ??= fetchIndex().then((index) => {
        const fake = fakeLevelCount();
        return mergeLevelEntries(fake > 0 ? repeatEntries(index, fake) : index, import.meta.env.DEV);
    });
    return listPromise;
}

async function fetchIndex(): Promise<LevelEntry[]> {
    try {
        const res = await fetch('levels/index.json', { cache: 'no-cache' });
        if (!res.ok) return [];
        return parseLevelIndex(await res.json());
    } catch {
        return [];
    }
}
