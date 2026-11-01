/**
 * Reduced-effects switch (no bloom, no grid warp, fewer particles). The saved setting lives in
 * `getRunState().settings.reducedFx`; `bootstrap.ts` pushes it here with `setReducedFx`, and views follow via
 * `onReducedFxChange`. `?fx=low` / `?fx=high` force it for the session (dev / test override). With nothing saved the
 * default comes from `prefers-reduced-motion` (`reducedFxDefault`).
 */
type Listener = (reduced: boolean) => void;

let reduced: boolean | null = null;
const listeners = new Set<Listener>();

/** `?fx=low` -> true, `?fx=high` -> false, otherwise null (no override). */
export function fxOverride(): boolean | null {
    if (typeof window === 'undefined') return null;
    const flag = new URLSearchParams(window.location.search).get('fx');
    if (flag === 'low') return true;
    if (flag === 'high') return false;
    return null;
}

/** The OS-level preference, used as the default when nothing is saved. */
export function reducedFxDefault(): boolean {
    if (typeof window === 'undefined') return false;
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

function detect(): boolean {
    return fxOverride() ?? reducedFxDefault();
}

export function isReducedFx(): boolean {
    if (reduced === null) reduced = detect();
    return reduced;
}

export function setReducedFx(on: boolean): void {
    if (isReducedFx() === on) return;
    reduced = on;
    for (const fn of listeners) fn(on);
}

/** Subscribe; returns the unsubscribe function. */
export function onReducedFxChange(fn: Listener): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/** Particle budget multiplier for the current setting. */
export function particleScale(): number {
    return isReducedFx() ? 0.35 : 1;
}
