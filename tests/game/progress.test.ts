import { describe, expect, test } from 'bun:test';
import {
    PROGRESS_KEY,
    PROGRESS_VERSION,
    ProgressStore,
    currentLevelIn,
    defaultProgress,
    formatTime,
    isUnlockedIn,
    migrateProgress,
    parseProgress,
} from '@game/progress';
import type { StorageLike } from '@game/progress';
import { campaignIds, mergeLevelEntries, nextLevelId, parseLevelIndex } from '@game/levelList';
import { parseProgressFlags, withoutReset } from '@game/urlParams';

class MemoryStorage implements StorageLike {
    items = new Map<string, string>();
    getItem(key: string): string | null {
        return this.items.get(key) ?? null;
    }
    setItem(key: string, value: string): void {
        this.items.set(key, value);
    }
    removeItem(key: string): void {
        this.items.delete(key);
    }
}

const ORDER = ['a', 'b', 'c'];

describe('progress defaults and persistence', () => {
    test('defaults', () => {
        const store = new ProgressStore(new MemoryStorage());
        expect(store.data).toEqual({
            version: PROGRESS_VERSION,
            completed: {},
            attempts: {},
            settings: { music: 0.6, sfx: 0.8, reducedFx: false, colorBlind: false, speed: 1 },
            firstSeen: {},
        });
    });

    test('reducedFx default applies only when nothing is saved', () => {
        const storage = new MemoryStorage();
        expect(new ProgressStore(storage, { reducedFx: true }).data.settings.reducedFx).toBe(true);
        const saved = new ProgressStore(storage, { reducedFx: true });
        saved.updateSettings({ reducedFx: false });
        expect(new ProgressStore(storage, { reducedFx: true }).data.settings.reducedFx).toBe(false);
    });

    test('round-trip through storage', () => {
        const storage = new MemoryStorage();
        const a = new ProgressStore(storage);
        a.recordAttempt('a');
        a.recordAttempt('a');
        a.markCompleted('a', 4200);
        a.updateSettings({ music: 0.3, sfx: 1, colorBlind: true, speed: 2 });
        a.markSeen('tip-lock');
        expect(JSON.parse(storage.items.get(PROGRESS_KEY)!)).toMatchObject({ version: 1 });
        const b = new ProgressStore(storage);
        expect(b.data).toEqual(a.data);
        expect(b.data.completed).toEqual({ a: { bestMs: 4200, attempts: 2 } });
        expect(b.data.settings).toEqual({ music: 0.3, sfx: 1, reducedFx: false, colorBlind: true, speed: 2 });
    });

    test('corrupt or foreign data falls back to defaults', () => {
        for (const junk of ['{nope', '"str"', '[]', 'null', '42', '']) {
            expect(parseProgress(junk)).toEqual(defaultProgress());
        }
        const storage = new MemoryStorage();
        storage.setItem(PROGRESS_KEY, '{{{');
        expect(new ProgressStore(storage).data).toEqual(defaultProgress());
    });

    test('malformed fields are dropped individually, the rest survives', () => {
        const json = JSON.stringify({
            version: 1,
            completed: { good: { bestMs: 1000, attempts: 3 }, badTime: { bestMs: 'x' }, neg: { bestMs: -5 }, noAttempts: { bestMs: 50 } },
            attempts: { good: 3, bad: 'many' },
            settings: { music: 7, sfx: 'loud', reducedFx: 'yes', colorBlind: true, speed: 5 },
            firstSeen: { a: true, b: 'no' },
        });
        const data = parseProgress(json);
        expect(data.completed).toEqual({ good: { bestMs: 1000, attempts: 3 }, noAttempts: { bestMs: 50, attempts: 1 } });
        expect(data.attempts).toEqual({ good: 3 });
        expect(data.settings).toEqual({ music: 1, sfx: 0.8, reducedFx: false, colorBlind: true, speed: 1 });
        expect(data.firstSeen).toEqual({ a: true });
    });

    test('storage that throws never breaks the store', () => {
        const broken: StorageLike = {
            getItem: () => {
                throw new Error('denied');
            },
            setItem: () => {
                throw new Error('quota');
            },
            removeItem: () => {
                throw new Error('denied');
            },
        };
        const store = new ProgressStore(broken);
        store.markCompleted('a', 1000);
        store.updateSettings({ sfx: 0.2 });
        expect(store.isCompleted('a')).toBe(true);
        expect(() => store.reset()).not.toThrow();
        expect(store.isCompleted('a')).toBe(false);
    });

    test('reset wipes the saved file', () => {
        const storage = new MemoryStorage();
        const store = new ProgressStore(storage);
        store.markCompleted('a', 1);
        store.reset();
        expect(storage.items.has(PROGRESS_KEY)).toBe(false);
        expect(store.data).toEqual(defaultProgress());
    });
});

describe('migration', () => {
    test('unversioned data migrates to the current version', () => {
        const data = parseProgress(JSON.stringify({ completed: { a: { bestMs: 10, attempts: 1 } } }));
        expect(data.version).toBe(PROGRESS_VERSION);
        expect(data.completed.a).toEqual({ bestMs: 10, attempts: 1 });
    });

    test('a custom chain runs step by step', () => {
        const migrations = {
            0: (old: Record<string, unknown>) => ({ ...old, version: 1 }),
            1: (old: Record<string, unknown>) => ({ ...old, version: 2, renamed: old.legacy }),
        };
        const out = migrateProgress({ version: 0, legacy: 'x' }, migrations, 2);
        expect(out).toEqual({ version: 2, legacy: 'x', renamed: 'x' });
    });

    test('a missing step or a newer version falls back to defaults', () => {
        expect(migrateProgress({ version: 0 }, {}, 1)).toBeNull();
        expect(parseProgress(JSON.stringify({ version: 99, completed: { a: { bestMs: 1, attempts: 1 } } }))).toEqual(defaultProgress());
    });
});

describe('completion, attempts and unlocks', () => {
    test('best time only improves, attempts count', () => {
        const store = new ProgressStore();
        store.recordAttempt('a');
        expect(store.markCompleted('a', 9000)).toEqual({ firstClear: true, improved: true, bestMs: 9000 });
        store.recordAttempt('a');
        expect(store.markCompleted('a', 12000)).toEqual({ firstClear: false, improved: false, bestMs: 9000 });
        expect(store.data.completed.a).toEqual({ bestMs: 9000, attempts: 2 });
        store.recordAttempt('a');
        expect(store.markCompleted('a', 7000)).toEqual({ firstClear: false, improved: true, bestMs: 7000 });
        expect(store.data.completed.a).toEqual({ bestMs: 7000, attempts: 3 });
        expect(store.data.attempts.a).toBe(3);
    });

    test('a clear without a recorded attempt counts as one try', () => {
        const store = new ProgressStore();
        store.markCompleted('a', 1000);
        expect(store.data.completed.a?.attempts).toBe(1);
    });

    test('linear unlock rule', () => {
        const store = new ProgressStore();
        expect(store.isUnlocked('a', ORDER)).toBe(true);
        expect(store.isUnlocked('b', ORDER)).toBe(false);
        expect(store.isUnlocked('c', ORDER)).toBe(false);
        store.markCompleted('a', 1000);
        expect(store.isUnlocked('b', ORDER)).toBe(true);
        expect(store.isUnlocked('c', ORDER)).toBe(false);
        store.markCompleted('c', 1000); // skipping ahead (deep link) does not open b's successor chain backwards
        expect(store.isUnlocked('c', ORDER)).toBe(false);
        store.markCompleted('b', 1000);
        expect(store.isUnlocked('c', ORDER)).toBe(true);
        expect(store.isUnlocked('nope', ORDER)).toBe(false);
        store.unlockAll = true;
        expect(store.isUnlocked('c', ['x', 'c'])).toBe(true);
    });

    test('pure helpers: isUnlockedIn and currentLevelIn', () => {
        const completed = { a: { bestMs: 1, attempts: 1 } };
        expect(isUnlockedIn(completed, 'b', ORDER)).toBe(true);
        expect(isUnlockedIn({}, 'b', ORDER)).toBe(false);
        expect(currentLevelIn({}, ORDER)).toBe('a');
        expect(currentLevelIn(completed, ORDER)).toBe('b');
        expect(currentLevelIn({ a: 1, b: 1, c: 1 }, ORDER)).toBeNull();
    });

    test('unknown or removed ids are ignored but kept', () => {
        const storage = new MemoryStorage();
        const store = new ProgressStore(storage);
        store.markCompleted('removed-level', 3000);
        store.markCompleted('a', 1000);
        const reloaded = new ProgressStore(storage);
        expect(reloaded.data.completed['removed-level']).toEqual({ bestMs: 3000, attempts: 1 });
        // The id is not in the campaign order, so it never unlocks or counts anything.
        expect(reloaded.isUnlocked('removed-level', ORDER)).toBe(false);
        expect(currentLevelIn(reloaded.data.completed, ORDER)).toBe('b');
        expect(isUnlockedIn(reloaded.data.completed, 'b', ORDER)).toBe(true);
    });

    test('settings are clamped and a no-op update keeps the same data object', () => {
        const store = new ProgressStore();
        store.updateSettings({ music: 5, sfx: -1 });
        expect(store.data.settings).toMatchObject({ music: 1, sfx: 0 });
        const before = store.data;
        store.updateSettings({ music: 1 });
        expect(store.data).toBe(before);
    });

    test('firstSeen', () => {
        const storage = new MemoryStorage();
        const store = new ProgressStore(storage);
        expect(store.hasSeen('tip')).toBe(false);
        store.markSeen('tip');
        const before = store.data;
        store.markSeen('tip');
        expect(store.data).toBe(before);
        expect(new ProgressStore(storage).hasSeen('tip')).toBe(true);
    });
});

describe('level list + url helpers', () => {
    test('nextLevelId stays inside the campaign, then inside the dev group', () => {
        const list = mergeLevelEntries(parseLevelIndex([{ id: 'x' }, { id: 'y' }]), true);
        expect(nextLevelId(list, 'x')).toBe('y');
        expect(nextLevelId(list, 'y')).toBeNull();
        expect(nextLevelId(list, 'dev-basic')).toBe('dev-mechanics');
        expect(campaignIds(list)).toEqual(['x', 'y']);
    });

    test('parseLevelIndex keeps thumbnails only when they match the size', () => {
        const [ok, bad] = parseLevelIndex([
            { id: 'ok', width: 2, height: 1, palette: ['#fff'], cells: '0.' },
            { id: 'bad', width: 2, height: 2, palette: ['#fff'], cells: '0.' },
        ]);
        expect(ok?.cells).toBe('0.');
        expect(ok?.palette).toEqual(['#fff']);
        expect(bad?.cells).toBeUndefined();
    });

    test('progress test flags', () => {
        expect(parseProgressFlags('?reset=1&unlockall=1&progress=heart, invader,')).toEqual({ reset: true, unlockAll: true, completed: ['heart', 'invader'], resetIntro: false });
        expect(parseProgressFlags('')).toEqual({ reset: false, unlockAll: false, completed: [], resetIntro: false });
        expect(parseProgressFlags('?intro=reset').resetIntro).toBe(true);
        expect(withoutReset('?intro=reset&level=heart')).toBe('?level=heart');
        expect(withoutReset('?intro=off')).toBe('?intro=off');
        expect(withoutReset('?reset=1&level=heart')).toBe('?level=heart');
        expect(withoutReset('?reset=1')).toBe('');
    });

    test('formatTime', () => {
        expect(formatTime(0)).toBe('0:00');
        expect(formatTime(65_400)).toBe('1:05');
        expect(formatTime(-5)).toBe('0:00');
    });
});
