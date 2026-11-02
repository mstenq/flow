/**
 * The only gameplay entry point for Phaser scenes. Wraps `Sim` with a fixed-timestep clock.
 * Pure TS (no Phaser, no DOM) so it is unit-testable.
 *
 * Usage per frame: `const events = gameFacade.advance(deltaMs)` → hand events to playback;
 * render with `snapshot()` and `tickAlpha`. Taps apply immediately (before the next tick).
 * Lose: when `isDead()` holds the scene starts its grace timer (1s) and shows overload.
 */
import type { LevelData, SimEvent, TapDenial, ViewState } from './types';
import { Sim } from './sim';
import { INF } from './reach';

export type GameSpeed = 1 | 2;

export type TapResult = { ok: true; events: SimEvent[] } | { ok: false; reason: TapDenial };

/** Max ticks run by a single `advance()` call; the rest of the backlog is dropped (no burst after a hidden tab). */
export const MAX_TICKS_PER_ADVANCE = 8;

export class GameFacade {
    private levelData: LevelData | null = null;
    private sim: Sim | null = null;
    private accumulator = 0;
    private speed: GameSpeed = 1;
    /** Extra slow-down from `?speed=0.x` (1 = normal); multiplies with `speed`. */
    private pace = 1;
    private paused = false;
    private history: number[] = [];
    private onSolution = true;
    private readonly maxTicksPerAdvance: number;

    constructor(opts: { maxTicksPerAdvance?: number } = {}) {
        this.maxTicksPerAdvance = opts.maxTicksPerAdvance ?? MAX_TICKS_PER_ADVANCE;
    }

    /** Validate and start `level` (throws `LevelError` on bad data). Speed is kept; pause is cleared. */
    load(level: LevelData): void {
        const sim = Sim.fromLevel(level, { emitPaths: true });
        this.levelData = level;
        this.sim = sim;
        this.resetRound();
    }

    restart(): void {
        const level = this.requireLevel();
        this.sim = Sim.fromLevel(level, { emitPaths: true });
        this.resetRound();
    }

    get level(): LevelData | null {
        return this.levelData;
    }

    get loaded(): boolean {
        return this.sim !== null;
    }

    /** Try to tap `column`. Applies immediately; the result's events contain `tapped` (+ any `revealed`). */
    tap(column: number): TapResult {
        const sim = this.requireSim();
        const reason = sim.tapReason(column);
        if (reason !== null) return { ok: false, reason };
        const events = sim.tap(column);
        const level = this.requireLevel();
        if (this.onSolution && level.solution[this.history.length] !== column) this.onSolution = false;
        this.history.push(column);
        return { ok: true, events };
    }

    /** Legality check without tapping (e.g. for hover/disabled styling). */
    tapReason(column: number): TapDenial | null {
        return this.requireSim().tapReason(column);
    }

    /** Advance the clock by `dtMs` and run the ticks that are due. Returns their events in order. */
    advance(dtMs: number): SimEvent[] {
        const sim = this.sim;
        if (sim === null || this.paused) return [];
        if (!(dtMs > 0)) return [];
        const step = this.stepMs;
        this.accumulator += dtMs;
        let due = Math.floor(this.accumulator / step);
        if (due > this.maxTicksPerAdvance) {
            due = this.maxTicksPerAdvance;
            this.accumulator = 0;
        } else {
            this.accumulator -= due * step;
        }
        if (due === 0) return [];
        const out: SimEvent[] = [];
        for (let i = 0; i < due; i++) {
            const ev = sim.tick();
            for (const e of ev) out.push(e);
        }
        return out;
    }

    /** Debug (dev hotkey `S`): run exactly one tick now. */
    stepTick(): SimEvent[] {
        return this.requireSim().tick();
    }

    /** Debug (dev hotkey `F`): tick until settled now. */
    settleNow(): SimEvent[] {
        const events = this.requireSim().settle();
        this.accumulator = 0;
        return events;
    }

    /** Fraction of the current tick elapsed, in [0, 1). For render interpolation. */
    get tickAlpha(): number {
        return Math.min(this.accumulator / this.stepMs, 0.999999);
    }

    /** Current tick duration in ms (`tickMs`, halved at 2x, stretched by a slow pace). */
    get stepMs(): number {
        const level = this.levelData;
        const base = level ? level.tickMs : 50;
        return base / (this.speed * this.pace);
    }

    setSpeed(speed: GameSpeed): void {
        if (speed === this.speed) return;
        this.retime(() => {
            this.speed = speed;
        });
    }

    /** Slow the clock by `pace` (0 < pace <= 1) on top of the speed toggle. Debug playtests only (`?speed=0.33`). */
    setPace(pace: number): void {
        if (pace === this.pace || !(pace > 0)) return;
        this.retime(() => {
            this.pace = pace;
        });
    }

    /** Keep the same fraction of the tick elapsed across a clock change. */
    private retime(change: () => void): void {
        const alpha = this.accumulator / this.stepMs;
        change();
        this.accumulator = alpha * this.stepMs;
    }

    getSpeed(): GameSpeed {
        return this.speed;
    }

    setPaused(paused: boolean): void {
        this.paused = paused;
    }

    isPaused(): boolean {
        return this.paused;
    }

    snapshot(): ViewState {
        return this.requireSim().snapshot();
    }

    isSettled(): boolean {
        return this.requireSim().isSettled();
    }

    isDead(): boolean {
        return this.requireSim().isDead();
    }

    isWon(): boolean {
        return this.requireSim().isWon();
    }

    /** Debug overlay: BFS distance of `(x, y)` for `color` (`dist_c`), or -1 when unreachable. */
    distAt(color: number, x: number, y: number): number {
        const d = this.requireSim().distAt(color, x, y);
        return d === INF ? -1 : d;
    }

    /** Columns tapped so far this round. */
    get taps(): readonly number[] {
        return this.history;
    }

    /**
     * Next column of the stored solution, if every tap so far followed it; otherwise null (also null when the
     * solution is exhausted). The solution assumes settled play, so show it once `isSettled()`.
     */
    nextHint(): number | null {
        const level = this.levelData;
        if (level === null || !this.onSolution) return null;
        const next = level.solution[this.history.length];
        return next === undefined ? null : next;
    }

    private resetRound(): void {
        this.accumulator = 0;
        this.paused = false;
        this.history = [];
        this.onSolution = true;
    }

    private requireSim(): Sim {
        if (this.sim === null) throw new Error('gameFacade: no level loaded');
        return this.sim;
    }

    private requireLevel(): LevelData {
        if (this.levelData === null) throw new Error('gameFacade: no level loaded');
        return this.levelData;
    }
}

/** Shared instance the Phaser scenes use. */
export const gameFacade = new GameFacade();
