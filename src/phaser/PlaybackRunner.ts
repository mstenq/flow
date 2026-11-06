/**
 * PlaybackRunner: the only place `SimEvent`s turn into animations. Scenes hand events to `enqueuePlayback`
 * and never animate outcomes themselves. Real-time game: events are NOT a sequential queue. Everything pending
 * is dispatched in one `pump()`, so claims animate concurrently. After dispatching, every view is refreshed
 * from the sim snapshot, so views cannot drift from the rules.
 *
 * Fill-first levels: while the board waits for every lane to fill, `syncNow` shows the `banner` and makes the empty lane
 * slots pulse; `waveStarted` punches the released lanes and dismisses the banner.
 *
 * Optional targets (`fx`, `grid`, `rig`, `banner`) add the neon flourishes (warp-grid impulses, key flights, win/overload
 * sequences); without them the runner still drives the core views (unit tests use fakes for those only).
 *
 * Hooks for audio / other listeners: `addListener({ ... })` (see `PlaybackListener`). Every dispatched sim event is
 * forwarded as `event`, plus the visual moments that happen later than their sim event (goo landing, pod launch,
 * key landing, denied tap, win / overload sequence start and end).
 */
import type { Layout } from '@game/layout';
import { clipPathToRect } from '@game/layout';
import type { Point2 } from '@game/layout';
import type { SimEvent, ViewState } from '@game/types';
import { emptyLaneCount, waitingToFill } from '@game/waveState';
import { mixColor } from '@data/themeColors';
import type { BoardView } from './view/BoardView';
import type { GooStream } from './view/GooStream';
import type { LaneView } from './view/LaneView';
import type { QueueView } from './view/QueueView';
import type { NeonGrid } from './view/NeonGrid';
import type { WaveBanner } from './view/WaveBanner';
import type { Fx } from './fx/Fx';
import type { CameraRig } from './fx/CameraRig';
import { playOverloadSequence, playWinSequence } from './fx/sequences';

export interface PlaybackTargets {
    layout: Layout;
    palette: number[];
    board: BoardView;
    goo: GooStream;
    lanes: LaneView;
    queue: QueueView;
    /** Latest sim state (the runner syncs the views to it after dispatching). */
    getSnapshot: () => ViewState;
    fx?: Fx;
    grid?: NeonGrid;
    rig?: CameraRig;
    banner?: WaveBanner;
}

export interface PlaybackHooks {
    onWon?: () => void;
    onDead?: () => void;
}

/** Observer hooks (audio attaches here). All optional. */
export interface PlaybackListener {
    /** Every sim event, as it is dispatched (same frame as the sim produced it). */
    event?: (e: SimEvent) => void;
    /** Once per `pump()` that dispatched events: the whole batch plus the sim state after it (audio intensity). */
    batch?: (events: readonly SimEvent[], snapshot: ViewState) => void;
    /** A goo blob landed in its lane pod (the visible count ticks down now). */
    gooArrived?: (lane: number, podId: number, color: number) => void;
    /** A completed pod launched out of its lane (after its last blob landed). */
    podLaunched?: (lane: number, color: number) => void;
    /** A collected key reached its lock (the lock shatters now). */
    keyArrived?: (podId: number) => void;
    /** A tap was denied (the pod wobbles red). */
    denied?: (column: number) => void;
    winSequenceStart?: () => void;
    winSequenceEnd?: () => void;
    overloadSequenceStart?: () => void;
    overloadSequenceEnd?: () => void;
}

const KEY_COLOR = 0xffe600;
/** How far past the board edge a goo dot goes before turning toward its lane (= the neon frame offset). */
const EXIT_MARGIN = 10;

export class PlaybackRunner {
    private pending: SimEvent[] = [];
    /** Lanes of waves started in the current batch (released after the views sync, so the lane pods exist). */
    private releases: number[][] = [];
    private forceSync = true;
    private readonly listeners: PlaybackListener[] = [];

    constructor(
        private readonly t: PlaybackTargets,
        private readonly hooks: PlaybackHooks = {},
    ) {
        activeRunner = this;
        t.lanes.setHooks?.({
            fx: t.fx,
            onPodLaunched: (lane, x, y, color) => {
                t.grid?.applyImpulse(x, y, 520, 300);
                this.notify((l) => l.podLaunched?.(lane, color));
            },
        });
    }

    enqueue(events: readonly SimEvent[]): void {
        for (const e of events) this.pending.push(e);
    }

    /** Subscribe to playback moments; returns the unsubscribe function. */
    addListener(listener: PlaybackListener): () => void {
        this.listeners.push(listener);
        return () => {
            const i = this.listeners.indexOf(listener);
            if (i >= 0) this.listeners.splice(i, 1);
        };
    }

    /** Ask for a full view refresh on the next `pump()` even with no events (level start, restart). */
    requestSync(): void {
        this.forceSync = true;
    }

    /** Dispatch everything pending, then refresh the views from the snapshot. Returns true if anything ran. */
    pump(): boolean {
        if (this.pending.length === 0 && !this.forceSync) return false;
        const batch = this.pending;
        this.pending = [];
        this.forceSync = false;
        for (const e of batch) this.dispatch(e);
        const snapshot = this.syncNow();
        for (const lanes of this.releases) this.releaseLanes(lanes);
        this.releases = [];
        if (batch.length > 0 && this.listeners.length > 0) this.notify((l) => l.batch?.(batch, snapshot));
        return true;
    }

    /** Refresh every view from the sim snapshot (returned for convenience). */
    syncNow(): ViewState {
        const s = this.t.getSnapshot();
        this.t.board.sync(s);
        this.t.lanes.sync(s.lanes);
        this.t.queue.sync(s.columns);
        this.syncFillPrompt(s);
        return s;
    }

    /** True when no events wait and no goo, flying pod, key flight or pod launch is still animating. */
    isIdle(): boolean {
        return (
            this.pending.length === 0 &&
            this.t.goo.activeCount === 0 &&
            this.t.queue.flyingCount === 0 &&
            (this.t.lanes.busyCount ?? 0) === 0 &&
            (this.t.fx?.busyCount ?? 0) === 0
        );
    }

    /** Denied tap flourish (the scene calls this instead of animating the queue itself). */
    denied(column: number): void {
        this.t.queue.shake(column);
        this.notify((l) => l.denied?.(column));
    }

    /** Win: frame flare, grid shockwave, fireworks, hologram. `done` fires when it has finished. */
    playWin(done: () => void): void {
        this.notify((l) => l.winSequenceStart?.());
        const finish = () => {
            this.notify((l) => l.winSequenceEnd?.());
            done();
        };
        if (!this.t.fx || !this.t.rig) {
            finish();
            return;
        }
        playWinSequence(
            { layout: this.t.layout, palette: this.t.palette, board: this.t.board, fx: this.t.fx, grid: this.t.grid, rig: this.t.rig },
            finish,
        );
    }

    /** Overload: red lanes, cracked pods, shake, chromatic pulse, grid implosion. `done` fires when finished. */
    playOverload(done: () => void): void {
        this.notify((l) => l.overloadSequenceStart?.());
        const finish = () => {
            this.notify((l) => l.overloadSequenceEnd?.());
            done();
        };
        if (!this.t.fx || !this.t.rig) {
            finish();
            return;
        }
        playOverloadSequence(
            {
                layout: this.t.layout,
                palette: this.t.palette,
                board: this.t.board,
                fx: this.t.fx,
                grid: this.t.grid,
                rig: this.t.rig,
                lanes: this.t.lanes,
                queue: this.t.queue,
            },
            finish,
        );
    }

    /** Fill-first: show the banner and pulse the empty slots while the board waits for the player. */
    private syncFillPrompt(s: ViewState): void {
        const waiting = waitingToFill(s);
        this.t.lanes.setInvite?.(waiting);
        const banner = this.t.banner;
        if (!banner) return;
        if (waiting) banner.show(emptyLaneCount(s));
        else banner.hide();
    }

    private releaseLanes(lanes: readonly number[]): void {
        const { grid, lanes: laneView } = this.t;
        laneView.release?.(lanes);
        for (const l of lanes) {
            const c = laneView.slotCenter(l);
            grid?.applyImpulse(c.x, c.y, 320, 200);
        }
    }

    dispose(): void {
        if (activeRunner === this) activeRunner = null;
        this.pending = [];
        this.releases = [];
        this.listeners.length = 0;
    }

    private notify(fn: (l: PlaybackListener) => void): void {
        for (const l of this.listeners) fn(l);
    }

    /**
     * Claim path in logical pixels (as the board is shown, zoom included). It is cut where it leaves the board rect and
     * ends just past that edge, on the neon frame (zoomed in, the grid edge can lie far outside the frame).
     */
    private worldPath(e: Extract<SimEvent, { t: 'claimed' }>): Point2[] {
        const { board, layout } = this.t;
        const points = e.path.map((p) => board.cellCenter(p.x, p.y));
        return clipPathToRect(points, layout.board.rect, EXIT_MARGIN);
    }

    private dispatch(e: SimEvent): void {
        const { board, goo, lanes, queue, palette, fx, grid } = this.t;
        if (this.listeners.length > 0) this.notify((l) => l.event?.(e));
        switch (e.t) {
            case 'tapped': {
                const centers = e.lanes.map((l) => lanes.slotCenter(l));
                for (const l of e.lanes) lanes.expectPod?.(l);
                queue.onTapped(e.podIds, centers, (i) => {
                    const lane = e.lanes[i];
                    if (lane !== undefined) lanes.podLanded?.(lane);
                });
                for (const l of e.lanes) lanes.flash(l);
                if (grid) for (const c of centers) grid.applyImpulse(c.x, c.y, 260, 170);
                return;
            }
            case 'pushed': {
                // A pushy pod dropped into a free lane by itself: the tapped flight, plus an orange flourish.
                const to = lanes.slotCenter(e.lane);
                lanes.expectPod?.(e.lane);
                queue.onTapped([e.podId], [to], () => lanes.podLanded?.(e.lane), true);
                lanes.flash(e.lane);
                grid?.applyImpulse(to.x, to.y, 380, 220);
                return;
            }
            case 'claimed': {
                board.onClaimed(e);
                const points = this.worldPath(e);
                if (points.length === 0) points.push(board.cellCenter(e.x, e.y));
                const exit = points[points.length - 1]!;
                points.push(lanes.slotCenter(e.lane));
                const color = palette[e.color] ?? 0xffffff;
                const lane = e.lane;
                const podId = e.podId;
                lanes.expectGoo?.(lane, podId);
                grid?.applyImpulse(exit.x, exit.y, -70, 46);
                goo.launch({
                    points,
                    color,
                    glow: mixColor(color, 0xffffff, 0.45),
                    radius: Math.max(6, Math.min(9, board.cellSize() * 0.3)),
                    rideFrame: true,
                    onArrive: () => {
                        lanes.pulse(lane, podId);
                        if (this.listeners.length > 0) this.notify((l) => l.gooArrived?.(lane, podId, color));
                    },
                });
                return;
            }
            case 'keyCollected': {
                const to = queue.podCenter(e.podId);
                if (!to) return;
                const from = board.cellCenter(e.x, e.y);
                if (!fx) {
                    goo.launch({ points: [from, to], color: KEY_COLOR, radius: 11, speed: 700 });
                    return;
                }
                const podId = e.podId;
                queue.holdLock(podId);
                grid?.applyImpulse(from.x, from.y, 300, 120);
                fx.keyFlight(from, to, () => {
                    queue.releaseLock(podId);
                    grid?.applyImpulse(to.x, to.y, 380, 160);
                    this.notify((l) => l.keyArrived?.(podId));
                }, Math.max(0.7, Math.min(1.2, board.cellSize() / 30)));
                return;
            }
            case 'unlocked':
                queue.onUnlocked(e.podId);
                return;
            case 'podCompleted':
                lanes.flash(e.lane);
                return;
            case 'won':
                this.hooks.onWon?.();
                return;
            case 'dead':
                this.hooks.onDead?.();
                return;
            case 'revealed':
                queue.onRevealed?.(e.podId);
                return;
            case 'waveStarted':
                this.t.banner?.hide(true);
                this.releases.push(e.lanes);
                return;
            case 'waveEnded':
                // Silent: the next wait for the lanes is announced by `syncFillPrompt` once the state says so.
                return;
        }
    }
}

let activeRunner: PlaybackRunner | null = null;

/** Hand sim events to the active scene's runner. They are dispatched on the next frame. */
export function enqueuePlayback(events: readonly SimEvent[]): void {
    activeRunner?.enqueue(events);
}

/** The active scene's runner (for attaching listeners, e.g. audio). */
export function getPlaybackRunner(): PlaybackRunner | null {
    return activeRunner;
}
