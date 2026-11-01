/**
 * Small typed app store: run (progress/settings), round (current level), scene (paused/speed/overlay).
 * Read with `get*State()`, mutate only through the matching `*Actions`.
 * Run state is backed by a `ProgressStore` (see progress.ts), which saves to the injected storage on every change;
 * `runActions.init(storage)` attaches `localStorage` at boot, tests stay in memory.
 */
import type { ViewState } from './types';
import type { GameSpeed } from './gameFacade';
import { ProgressStore } from './progress';
import type { CompletedEntry, CompletionResult, ProgressDefaults, ProgressSettings, StorageLike } from './progress';

export type Settings = ProgressSettings;

export interface RunState {
    currentLevelId: string | null;
    /** Cleared levels with best time and attempts. */
    completed: Readonly<Record<string, CompletedEntry>>;
    /** Tries per level id. */
    attempts: Readonly<Record<string, number>>;
    settings: Settings;
    firstSeen: Readonly<Record<string, true>>;
    /** `?unlockall=1`: treat every level as unlocked (not saved). */
    unlockAll: boolean;
}

export type RoundStatus = 'idle' | 'playing' | 'won' | 'lost';

export interface RoundState {
    levelId: string | null;
    status: RoundStatus;
    /** Latest sim view (set by the scene after advancing). */
    snapshot: ViewState | null;
    elapsedMs: number;
    taps: number;
    attempts: number;
}

export type Overlay = 'none' | 'pause' | 'win' | 'lose' | 'intro';

export interface SceneState {
    paused: boolean;
    speed: GameSpeed;
    overlay: Overlay;
}

let store = new ProgressStore();

const runFromStore = (currentLevelId: string | null): RunState => ({
    currentLevelId,
    completed: store.data.completed,
    attempts: store.data.attempts,
    settings: store.data.settings,
    firstSeen: store.data.firstSeen,
    unlockAll: store.unlockAll,
});

const initialRound = (): RoundState => ({
    levelId: null,
    status: 'idle',
    snapshot: null,
    elapsedMs: 0,
    taps: 0,
    attempts: 0,
});

const initialScene = (): SceneState => ({ paused: false, speed: 1, overlay: 'none' });

let run: RunState = runFromStore(null);
const runListeners = new Set<() => void>();
let round: RoundState = initialRound();
let scene: SceneState = initialScene();

export function getRunState(): Readonly<RunState> {
    return run;
}

export function getRoundState(): Readonly<RoundState> {
    return round;
}

export function getSceneState(): Readonly<SceneState> {
    return scene;
}

/** Re-read the store into `run` and tell subscribers. */
function syncRun(currentLevelId: string | null = run.currentLevelId): void {
    run = runFromStore(currentLevelId);
    for (const fn of runListeners) fn();
}

/** Subscribe to any run-state change (settings, progress); returns the unsubscribe function. */
export function onRunChange(fn: () => void): () => void {
    runListeners.add(fn);
    return () => runListeners.delete(fn);
}

export function hasSeen(key: string): boolean {
    return store.hasSeen(key);
}

/** Whether the level is playable from the select screen. `order` = campaign ids in index order. */
export function isLevelUnlocked(id: string, order: readonly string[]): boolean {
    return store.isUnlocked(id, order);
}

export const runActions = {
    /** Attach storage and load saved progress (boot). `defaults.reducedFx` only applies when nothing is saved. */
    init(storage: StorageLike | null, defaults: ProgressDefaults = {}): void {
        store = new ProgressStore(storage, defaults);
        syncRun(null);
    },
    setCurrentLevel(levelId: string | null): void {
        run = { ...run, currentLevelId: levelId };
    },
    /** Level cleared in `ms`; keeps the best time. */
    markCompleted(levelId: string, ms: number): CompletionResult {
        const result = store.markCompleted(levelId, ms);
        syncRun();
        return result;
    },
    recordAttempt(levelId: string): void {
        store.recordAttempt(levelId);
        syncRun();
    },
    updateSettings(patch: Partial<Settings>): void {
        const before = store.data;
        store.updateSettings(patch);
        if (store.data !== before) syncRun();
    },
    markSeen(key: string): void {
        const before = store.data;
        store.markSeen(key);
        if (store.data !== before) syncRun();
    },
    /** Forget the one-time intro cards (`?intro=reset`). */
    resetSeen(): void {
        const before = store.data;
        store.resetSeen();
        if (store.data !== before) syncRun();
    },
    /** Wipe saved progress and settings (`?reset=1`). */
    resetProgress(): void {
        store.reset();
        syncRun();
    },
    setUnlockAll(on: boolean): void {
        store.unlockAll = on;
        syncRun();
    },
    /** Fresh in-memory state, detached from storage (tests). */
    reset(): void {
        store = new ProgressStore();
        run = runFromStore(null);
        for (const fn of runListeners) fn();
    },
};

export const roundActions = {
    /** New level, or a retry of the same level (bumps `attempts`). */
    start(levelId: string): void {
        const attempts = round.levelId === levelId ? round.attempts + 1 : 1;
        round = { ...initialRound(), levelId, status: 'playing', attempts };
    },
    setSnapshot(snapshot: ViewState): void {
        round = { ...round, snapshot };
    },
    addElapsed(ms: number): void {
        if (round.status !== 'playing') return;
        round = { ...round, elapsedMs: round.elapsedMs + ms };
    },
    recordTap(): void {
        round = { ...round, taps: round.taps + 1 };
    },
    setStatus(status: RoundStatus): void {
        round = { ...round, status };
    },
    reset(): void {
        round = initialRound();
    },
};

export const sceneActions = {
    setPaused(paused: boolean): void {
        scene = { ...scene, paused };
    },
    setSpeed(speed: GameSpeed): void {
        scene = { ...scene, speed };
    },
    setOverlay(overlay: Overlay): void {
        scene = { ...scene, overlay };
    },
    reset(): void {
        scene = initialScene();
    },
};
