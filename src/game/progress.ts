/**
 * Saved progress (pure; storage is injected so bun tests run without a browser).
 *
 * `localStorage['flow.progress.v1']` holds `{ version, completed, attempts, settings, firstSeen }`:
 *   completed  level id -> { bestMs, attempts }  (attempts = total tries when it was last cleared)
 *   attempts   level id -> tries so far
 *   settings   volumes, reduced effects, color-blind glyphs, default speed, unlock all levels
 *   firstSeen  key -> true (Phase 6 mechanic tooltips: `hasSeen` / `markSeen`)
 *
 * Loading never throws: corrupt or unreadable data falls back to defaults. Unknown or removed level ids stay in the
 * file untouched and are simply ignored by the unlock rule. Old versions go through `MIGRATIONS`.
 */
import type { GameSpeed } from './gameFacade';
import { DEFAULT_VOLUMES } from './music';

export const PROGRESS_KEY = 'flow.progress.v1';
export const PROGRESS_VERSION = 1;

export interface StorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

export interface ProgressSettings {
    /** Music volume 0..1. */
    music: number;
    /** SFX volume 0..1. */
    sfx: number;
    reducedFx: boolean;
    colorBlind: boolean;
    speed: GameSpeed;
    /** Every campaign level is playable (skip the linear unlock chain). */
    unlockAll: boolean;
}

export interface CompletedEntry {
    bestMs: number;
    attempts: number;
}

export interface ProgressData {
    version: number;
    completed: Record<string, CompletedEntry>;
    attempts: Record<string, number>;
    settings: ProgressSettings;
    firstSeen: Record<string, true>;
}

export interface ProgressDefaults {
    /** Where `reducedFx` starts when nothing is saved (`prefers-reduced-motion`). */
    reducedFx?: boolean;
}

export interface CompletionResult {
    /** First time this level was cleared. */
    firstClear: boolean;
    /** The time beat the previous best (also true on the first clear). */
    improved: boolean;
    bestMs: number;
}

/** m:ss for a duration in ms. */
export function formatTime(ms: number): string {
    const total = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function defaultSettings(defaults: ProgressDefaults = {}): ProgressSettings {
    return {
        music: DEFAULT_VOLUMES.music,
        sfx: DEFAULT_VOLUMES.sfx,
        reducedFx: defaults.reducedFx ?? false,
        colorBlind: false,
        speed: 1,
        unlockAll: false,
    };
}

export function defaultProgress(defaults: ProgressDefaults = {}): ProgressData {
    return { version: PROGRESS_VERSION, completed: {}, attempts: {}, settings: defaultSettings(defaults), firstSeen: {} };
}

/** Upgrade functions keyed by the version they upgrade FROM (each returns data of the next version). */
export type Migrations = Record<number, (old: Record<string, unknown>) => Record<string, unknown>>;

export const MIGRATIONS: Migrations = {
    // Unversioned data predates the version field; its shape already matches v1.
    0: (old) => ({ ...old, version: 1 }),
};

/** Run the migration chain up to `PROGRESS_VERSION`. Returns null when a step is missing or the version is newer. */
export function migrateProgress(raw: Record<string, unknown>, migrations: Migrations = MIGRATIONS, target = PROGRESS_VERSION): Record<string, unknown> | null {
    let data = raw;
    let version = typeof data.version === 'number' ? data.version : 0;
    if (version > target) return null;
    while (version < target) {
        const step = migrations[version];
        if (!step) return null;
        data = step(data);
        version = typeof data.version === 'number' && data.version > version ? data.version : version + 1;
    }
    return { ...data, version: target };
}

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clamp01(v: number): number {
    return Math.max(0, Math.min(1, v));
}

function sanitizeSettings(raw: unknown, defaults: ProgressDefaults): ProgressSettings {
    const base = defaultSettings(defaults);
    if (!isRecord(raw)) return base;
    return {
        music: typeof raw.music === 'number' && Number.isFinite(raw.music) ? clamp01(raw.music) : base.music,
        sfx: typeof raw.sfx === 'number' && Number.isFinite(raw.sfx) ? clamp01(raw.sfx) : base.sfx,
        reducedFx: typeof raw.reducedFx === 'boolean' ? raw.reducedFx : base.reducedFx,
        colorBlind: typeof raw.colorBlind === 'boolean' ? raw.colorBlind : base.colorBlind,
        speed: raw.speed === 2 ? 2 : 1,
        unlockAll: typeof raw.unlockAll === 'boolean' ? raw.unlockAll : base.unlockAll,
    };
}

/** Keep well-formed entries only (ids are not checked against the level list: unknown ids are harmless). */
function sanitizeCompleted(raw: unknown): Record<string, CompletedEntry> {
    const out: Record<string, CompletedEntry> = {};
    if (!isRecord(raw)) return out;
    for (const [id, v] of Object.entries(raw)) {
        if (!isRecord(v) || typeof v.bestMs !== 'number' || !Number.isFinite(v.bestMs) || v.bestMs < 0) continue;
        const attempts = typeof v.attempts === 'number' && Number.isFinite(v.attempts) ? Math.max(1, Math.floor(v.attempts)) : 1;
        out[id] = { bestMs: Math.round(v.bestMs), attempts };
    }
    return out;
}

function sanitizeAttempts(raw: unknown): Record<string, number> {
    const out: Record<string, number> = {};
    if (!isRecord(raw)) return out;
    for (const [id, v] of Object.entries(raw)) {
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[id] = Math.floor(v);
    }
    return out;
}

function sanitizeSeen(raw: unknown): Record<string, true> {
    const out: Record<string, true> = {};
    if (!isRecord(raw)) return out;
    for (const [k, v] of Object.entries(raw)) if (v === true) out[k] = true;
    return out;
}

/** Parse stored JSON into progress data. Anything unusable gives the defaults. */
export function parseProgress(json: string | null, defaults: ProgressDefaults = {}, migrations: Migrations = MIGRATIONS): ProgressData {
    if (json === null) return defaultProgress(defaults);
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        return defaultProgress(defaults);
    }
    if (!isRecord(parsed)) return defaultProgress(defaults);
    const migrated = migrateProgress(parsed, migrations);
    if (!migrated) return defaultProgress(defaults);
    return {
        version: PROGRESS_VERSION,
        completed: sanitizeCompleted(migrated.completed),
        attempts: sanitizeAttempts(migrated.attempts),
        settings: sanitizeSettings(migrated.settings, defaults),
        firstSeen: sanitizeSeen(migrated.firstSeen),
    };
}

/**
 * Linear unlock: the first level is always open, level n opens once level n-1 is cleared.
 * `order` is the campaign level ids in index order; an id that is not in it is locked.
 */
export function isUnlockedIn(completed: Readonly<Record<string, unknown>>, id: string, order: readonly string[]): boolean {
    const i = order.indexOf(id);
    if (i < 0) return false;
    if (i === 0) return true;
    return completed[order[i - 1]!] !== undefined;
}

/** First campaign level not yet cleared (the "current" one), or null when everything is cleared. */
export function currentLevelIn(completed: Readonly<Record<string, unknown>>, order: readonly string[]): string | null {
    return order.find((id) => completed[id] === undefined) ?? null;
}

/**
 * Mutable holder around `ProgressData`. Every mutation replaces `data` with a new object (so it can sit in app
 * state), saves, and returns. A no-op mutation keeps the same object. Storage errors (private mode, quota) are
 * swallowed: progress then lives for the session only.
 */
export class ProgressStore {
    data: ProgressData;
    /** Dev affordance (`?unlockall=1`): everything unlocked, never saved. */
    unlockAll = false;

    constructor(
        private readonly storage: StorageLike | null = null,
        private readonly defaults: ProgressDefaults = {},
        private readonly migrations: Migrations = MIGRATIONS,
    ) {
        this.data = this.read();
    }

    private read(): ProgressData {
        let json: string | null = null;
        try {
            json = this.storage?.getItem(PROGRESS_KEY) ?? null;
        } catch {
            json = null;
        }
        return parseProgress(json, this.defaults, this.migrations);
    }

    private commit(next: ProgressData): void {
        this.data = next;
        try {
            this.storage?.setItem(PROGRESS_KEY, JSON.stringify(next));
        } catch {
            // Storage unavailable: keep going in memory.
        }
    }

    /** Wipe everything (`?reset=1`). */
    reset(): void {
        try {
            this.storage?.removeItem(PROGRESS_KEY);
        } catch {
            // ignore
        }
        this.data = defaultProgress(this.defaults);
    }

    isCompleted(id: string): boolean {
        return this.data.completed[id] !== undefined;
    }

    /** Every level is open: the dev flag or the saved setting. */
    get unlocksAll(): boolean {
        return this.unlockAll || this.data.settings.unlockAll;
    }

    isUnlocked(id: string, order: readonly string[]): boolean {
        return this.unlocksAll || isUnlockedIn(this.data.completed, id, order);
    }

    /** A try started (first start, retry, restart). */
    recordAttempt(id: string): void {
        this.commit({ ...this.data, attempts: { ...this.data.attempts, [id]: (this.data.attempts[id] ?? 0) + 1 } });
    }

    /** Level cleared in `ms`. The best time only improves; `attempts` records the tries so far. */
    markCompleted(id: string, ms: number): CompletionResult {
        const time = Math.max(0, Math.round(ms));
        const prev = this.data.completed[id];
        const improved = prev === undefined || time < prev.bestMs;
        const bestMs = improved ? time : prev.bestMs;
        const attempts = Math.max(1, this.data.attempts[id] ?? 1);
        this.commit({ ...this.data, completed: { ...this.data.completed, [id]: { bestMs, attempts } } });
        return { firstClear: prev === undefined, improved, bestMs };
    }

    updateSettings(patch: Partial<ProgressSettings>): void {
        const merged = sanitizeSettings({ ...this.data.settings, ...patch }, this.defaults);
        const same = (Object.keys(merged) as (keyof ProgressSettings)[]).every((k) => merged[k] === this.data.settings[k]);
        if (same) return;
        this.commit({ ...this.data, settings: merged });
    }

    hasSeen(key: string): boolean {
        return this.data.firstSeen[key] === true;
    }

    /** Forget every one-time hint (`?intro=reset`). */
    resetSeen(): void {
        if (Object.keys(this.data.firstSeen).length === 0) return;
        this.commit({ ...this.data, firstSeen: {} });
    }

    markSeen(key: string): void {
        if (this.hasSeen(key)) return;
        this.commit({ ...this.data, firstSeen: { ...this.data.firstSeen, [key]: true } });
    }
}
