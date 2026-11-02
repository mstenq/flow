export type StartTarget =
    | { scene: 'Spike' }
    | { scene: 'Play'; data: { levelId: string } }
    | { scene: 'LevelSelect' };

/** `?autoplay=1` plays the stored solution; `?autoplay=random` taps random legal columns (to exercise losing). */
export type AutoplayMode = 'off' | 'solution' | 'random';

export interface UrlFlags {
    debug: boolean;
    autoplay: AutoplayMode;
    /** `?speed=2` starts at 2x (handy for headless runs). */
    speed: 1 | 2;
    /** `?speed=0.33` (any value in 0.05..1) slows the clock for this session, on top of the 1x/2x toggle (pace playtests). */
    pace: number;
    /** `?intro=off` never shows the mechanic intro cards this session. */
    introOff: boolean;
}

/** Decide which scene to start from a query string (with or without leading "?"). */
export function parseStartTarget(search: string): StartTarget {
    const params = new URLSearchParams(search);
    if (params.get('spike') === '1') return { scene: 'Spike' };
    const levelId = params.get('level');
    if (levelId) return { scene: 'Play', data: { levelId } };
    return { scene: 'LevelSelect' };
}

export function parseFlags(search: string): UrlFlags {
    const params = new URLSearchParams(search);
    return {
        debug: params.get('debug') === '1',
        autoplay: parseAutoplay(params.get('autoplay')),
        speed: params.get('speed') === '2' ? 2 : 1,
        pace: parsePace(params.get('speed')),
        introOff: params.get('intro') === 'off',
    };
}

/** Slow-down factor from `?speed=`: a number in [0.05, 1), otherwise 1 (normal pace). */
function parsePace(value: string | null): number {
    const n = Number(value);
    if (value === null || !Number.isFinite(n) || n >= 1 || n < 0.05) return 1;
    return n;
}

function parseAutoplay(value: string | null): AutoplayMode {
    if (value === 'random') return 'random';
    if (value === '1' || value === 'solution') return 'solution';
    return 'off';
}

/** Test affordances for saved progress. */
export interface ProgressFlags {
    /** `?reset=1` wipes saved progress and settings. */
    reset: boolean;
    /** `?unlockall=1` unlocks every level (not saved). */
    unlockAll: boolean;
    /** `?progress=heart,invader` pre-marks those levels as completed. */
    completed: string[];
    /** `?intro=reset` forgets the one-time mechanic cards (`?reset=1` does too). */
    resetIntro: boolean;
}

export function parseProgressFlags(search: string): ProgressFlags {
    const params = new URLSearchParams(search);
    const completed = (params.get('progress') ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id !== '');
    return {
        reset: params.get('reset') === '1',
        unlockAll: params.get('unlockall') === '1',
        completed,
        resetIntro: params.get('intro') === 'reset',
    };
}

/** The query string without the one-shot wipe flags (`reset`, `intro=reset`), so a reload keeps the fresh state. */
export function withoutReset(search: string): string {
    const params = new URLSearchParams(search);
    params.delete('reset');
    if (params.get('intro') === 'reset') params.delete('intro');
    const rest = params.toString();
    return rest === '' ? '' : `?${rest}`;
}
