/**
 * Which special mechanics a level contains, and the one-time intro cards that explain them.
 * Pure data (no Phaser, no DOM). A card is shown the first time its mechanic appears in a level the player opens;
 * "seen" is stored with `hasSeen` / `markSeen` (see state.ts) under `introKey(id)`.
 */
import type { LevelData } from './types';

export type MechanicId = 'hidden' | 'locked' | 'linked' | 'pushy';

export interface MechanicInfo {
    id: MechanicId;
    title: string;
    text: string;
}

/** Order = the order cards are shown in when several are new in the same level. */
export const MECHANICS: readonly MechanicInfo[] = [
    { id: 'hidden', title: 'HIDDEN POD', text: 'Its color stays secret until it reaches the front of its column.' },
    { id: 'locked', title: 'LOCKED POD', text: 'Drain the key out of the image to open it.' },
    { id: 'linked', title: 'LINKED PODS', text: 'Tap one and its partner joins it. Needs two free lanes.' },
    { id: 'pushy', title: 'PUSHY POD', text: 'Drops into a free lane by itself when it reaches the front. Plan around it.' },
];

export function introKey(id: MechanicId): string {
    return `intro:${id}`;
}

/** Mechanics present in `level`, in `MECHANICS` order. */
export function levelMechanics(level: Pick<LevelData, 'columns'>): MechanicId[] {
    const found = new Set<MechanicId>();
    for (const column of level.columns) {
        for (const pod of column) {
            if (pod.hidden) found.add('hidden');
            if (pod.lock !== undefined) found.add('locked');
            if (pod.link !== undefined) found.add('linked');
            if (pod.pushy) found.add('pushy');
        }
    }
    return MECHANICS.filter((m) => found.has(m.id)).map((m) => m.id);
}

/** The intro cards still to show for `level`, given a `hasSeen` lookup. */
export function unseenMechanics(level: Pick<LevelData, 'columns'>, hasSeen: (key: string) => boolean): MechanicInfo[] {
    const present = new Set(levelMechanics(level));
    return MECHANICS.filter((m) => present.has(m.id) && !hasSeen(introKey(m.id)));
}
