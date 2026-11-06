/**
 * Fill-first helpers for the views (pure, no Phaser): is the board waiting for the player to fill the lanes, and how
 * many lanes are still empty. See `Sim` for the rule.
 */
import type { ViewState } from './types';

/** Lanes without a pod. */
export function emptyLaneCount(view: Pick<ViewState, 'lanes'>): number {
    return view.lanes.filter((l) => l === null).length;
}

/** A fill-first board with no wave running, waiting on the player to put pods in every empty lane. */
export function waitingToFill(view: Pick<ViewState, 'fillFirst' | 'wave' | 'won' | 'dead' | 'lanes'>): boolean {
    return view.fillFirst && !view.wave && !view.won && !view.dead && emptyLaneCount(view) > 0;
}
