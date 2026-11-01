/** Level list helpers (pure). The index file is written by the generator: `[{ id, name, width, height, difficulty }]`. */

export interface LevelEntry {
    id: string;
    name: string;
    width: number;
    height: number;
    difficulty: number;
    /** Palette and image (row-major, '.' = empty) for thumbnails. Missing for dev levels / old indexes; fetch the level instead. */
    palette?: string[];
    cells?: string;
    /** Handmade dev level (only listed in dev builds). */
    dev?: true;
}

export const DEV_LEVELS: readonly LevelEntry[] = [
    { id: 'dev-basic', name: 'Dev Basic', width: 10, height: 10, difficulty: 0.2, dev: true },
    { id: 'dev-mechanics', name: 'Dev Mechanics', width: 12, height: 12, difficulty: 0.5, dev: true },
    { id: 'dev-big', name: 'Dev Big', width: 40, height: 40, difficulty: 0.8, dev: true },
    { id: 'dev-colors', name: 'Dev Colors', width: 18, height: 18, difficulty: 0.6, dev: true },
];

/** Keep only well-formed entries from parsed index JSON (anything else is ignored). */
export function parseLevelIndex(json: unknown): LevelEntry[] {
    if (!Array.isArray(json)) return [];
    const out: LevelEntry[] = [];
    for (const raw of json) {
        if (typeof raw !== 'object' || raw === null) continue;
        const e = raw as Record<string, unknown>;
        if (typeof e.id !== 'string' || e.id === '') continue;
        const thumb = parseThumb(e);
        out.push({
            ...thumb,
            id: e.id,
            name: typeof e.name === 'string' ? e.name : e.id,
            width: typeof e.width === 'number' ? e.width : 0,
            height: typeof e.height === 'number' ? e.height : 0,
            difficulty: typeof e.difficulty === 'number' ? e.difficulty : 0,
        });
    }
    return out;
}

function parseThumb(e: Record<string, unknown>): Pick<LevelEntry, 'palette' | 'cells'> {
    const { palette, cells, width, height } = e;
    if (!Array.isArray(palette) || !palette.every((c) => typeof c === 'string')) return {};
    if (typeof cells !== 'string' || typeof width !== 'number' || typeof height !== 'number') return {};
    if (cells.length !== width * height) return {};
    return { palette: palette as string[], cells };
}

/** Index entries first (in index order), then dev levels when `includeDev`. Duplicate ids keep the first. */
export function mergeLevelEntries(index: readonly LevelEntry[], includeDev: boolean): LevelEntry[] {
    const seen = new Set<string>();
    const out: LevelEntry[] = [];
    for (const e of includeDev ? [...index, ...DEV_LEVELS] : index) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        out.push(e);
    }
    return out;
}

/** Id of the level after `currentId` within the same group (campaign or dev), or null if it is last or unknown. */
export function nextLevelId(list: readonly LevelEntry[], currentId: string): string | null {
    const i = list.findIndex((e) => e.id === currentId);
    if (i < 0) return null;
    const next = list[i + 1];
    if (!next || Boolean(next.dev) !== Boolean(list[i]!.dev)) return null;
    return next.id;
}

/** Campaign levels only (in index order). The linear unlock chain runs over these; dev levels are always open. */
export function campaignIds(list: readonly LevelEntry[]): string[] {
    return list.filter((e) => !e.dev).map((e) => e.id);
}

/**
 * Dev-only stress helper (`?fakelevels=N`): repeat the entries, in order, until there are `count` of them. Repeats get
 * ids `<id>~<pass>` and a numbered name, so ids stay unique (locks, progress) and neighbours look different.
 * Returns the input unchanged when it is empty or already has at least `count` entries.
 */
export function repeatEntries(entries: readonly LevelEntry[], count: number): LevelEntry[] {
    if (entries.length === 0 || entries.length >= count) return [...entries];
    const out: LevelEntry[] = [];
    for (let i = 0; i < count; i++) {
        const base = entries[i % entries.length]!;
        const pass = Math.floor(i / entries.length);
        out.push(pass === 0 ? base : { ...base, id: `${base.id}~${pass}`, name: `${base.name} ${pass + 1}` });
    }
    return out;
}
