/**
 * One-time app setup, run from the first scene: attach saved progress, apply the URL test flags
 * (`?reset=1`, `?intro=reset`, `?progress=a,b`, `?unlockall=1`), push the saved settings to audio and effects, and install the
 * audio unlock / tab-visibility handlers.
 */
import { getRunState, onRunChange, runActions } from '@game/state';
import type { StorageLike } from '@game/progress';
import { parseProgressFlags, withLevel, withoutReset } from '@game/urlParams';
import { audioDirector } from './audio';
import { fxOverride, reducedFxDefault, setReducedFx } from './fx/fxSettings';

/** Best time given to levels pre-marked with `?progress=`. */
const PREFILLED_MS = 90_000;

let booted = false;

function browserStorage(): StorageLike | null {
    try {
        return window.localStorage;
    } catch {
        return null; // blocked (private mode / cookies off): progress lasts for the session
    }
}

/** Settings -> audio volumes and reduced effects (a `?fx=` flag wins for the session). */
function applySettings(): void {
    const s = getRunState().settings;
    audioDirector.setVolumes({ music: s.music, sfx: s.sfx });
    setReducedFx(fxOverride() ?? s.reducedFx);
}

export function bootstrap(): void {
    if (booted) return;
    booted = true;
    const search = window.location.search;
    runActions.init(browserStorage(), { reducedFx: reducedFxDefault() });
    const flags = parseProgressFlags(search);
    if (flags.reset || flags.resetIntro) {
        if (flags.reset) runActions.resetProgress();
        // Drop the flag so a reload keeps the fresh progress instead of wiping it again.
        window.history.replaceState(null, '', `${window.location.pathname}${withoutReset(search)}${window.location.hash}`);
    }
    if (flags.resetIntro) runActions.resetSeen();
    for (const id of flags.completed) runActions.markCompleted(id, PREFILLED_MS);
    if (flags.unlockAll) runActions.setUnlockAll(true);
    onRunChange(applySettings);
    applySettings();
    audioDirector.installUnlock();
    audioDirector.installVisibility();
}

/** Mirror the current level in the address bar (`?level=<id>`, or none on level select) so a reload returns to it. */
export function syncLevelParam(levelId: string | null): void {
    const search = withLevel(window.location.search, levelId);
    if (search === window.location.search) return;
    window.history.replaceState(null, '', `${window.location.pathname}${search}${window.location.hash}`);
}
