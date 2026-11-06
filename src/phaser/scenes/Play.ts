/**
 * Play scene: owns the views and the frame loop, nothing else.
 *   update(dt) -> gameFacade.advance(dt) -> enqueuePlayback(events) -> PlaybackRunner.pump() -> views react.
 * Rules live in `src/game` (via `gameFacade`); outcome animations live in `PlaybackRunner` and the views.
 */
import { Core, Scene } from 'phaser';
import type { Time } from 'phaser';
import { gameFacade } from '@game/gameFacade';
import type { GameSpeed } from '@game/gameFacade';
import { computeLayout } from '@game/layout';
import type { Layout } from '@game/layout';
import { nextLevelId } from '@game/levelList';
import { introKey, unseenMechanics } from '@game/mechanics';
import type { MechanicInfo } from '@game/mechanics';
import { getRoundState, getRunState, hasSeen, getSceneState, onRunChange, roundActions, runActions, sceneActions } from '@game/state';
import { formatTime } from '@game/progress';
import type { CompletionResult } from '@game/progress';
import type { TapDenial, LevelData, ViewState } from '@game/types';
import { parseFlags } from '@game/urlParams';
import type { UrlFlags } from '@game/urlParams';
import { fetchLevel, loadLevelList } from '../levels';
import { PlaybackRunner, enqueuePlayback } from '../PlaybackRunner';
import { COLORS, hexNum, keyLetter, paletteArtFromNums } from '../theme';
import { audioDirector } from '../audio';
import { syncLevelParam } from '../bootstrap';
import { introContent } from '../ui/IntroCard';
import { ModalOverlay } from '../ui/ModalOverlay';
import { settingsContent } from '../ui/SettingsOverlay';
import { solutionContent } from '../ui/SolutionOverlay';
import { Toast } from '../ui/Toast';
import { BoardView } from '../view/BoardView';
import { WaveBanner } from '../view/WaveBanner';
import { GooStream } from '../view/GooStream';
import { Hud } from '../view/Hud';
import { LaneView } from '../view/LaneView';
import { QueueView } from '../view/QueueView';
import { KeyTether } from '../view/KeyTether';
import { Background } from '../view/Background';
import { CameraRig } from '../fx/CameraRig';
import { ensureFxTextures } from '../fx/textures';
import { Fx } from '../fx/Fx';
import { NeonGrid } from '../view/NeonGrid';

/** Dead + settled + idle must hold this long before overload. */
const OVERLOAD_GRACE_MS = 1000;
/** With `?autoplay`, an intro card closes itself after this long (so headless runs are not blocked). */
const AUTO_INTRO_MS = 1500;
/** Pause between autoplay taps (test affordance). */
const AUTOPLAY_GAP_MS = 250;

type Phase = 'playing' | 'won' | 'lost';

interface PlayData {
    levelId?: string;
    /** Same level again: rebuild the sim from the loaded JSON without refetching. */
    retry?: boolean;
}

export class Play extends Scene {
    private levelId = '';
    private retry = false;
    private flags: UrlFlags = { debug: false, autoplay: 'off', speed: 1, pace: 1, introOff: false, fillFirst: false };
    private layout!: Layout;
    private palette: number[] = [];

    private board!: BoardView;
    private goo!: GooStream;
    private lanes!: LaneView;
    private queue!: QueueView;
    private tether!: KeyTether;
    private hud!: Hud;
    private banner!: WaveBanner;
    private toast!: Toast;
    private modal!: ModalOverlay;
    private runner!: PlaybackRunner;
    private rig!: CameraRig;
    private bg!: Background;
    private grid!: NeonGrid;
    private fx!: Fx;

    private ready = false;
    private phase: Phase = 'playing';
    private winPending = false;
    private deadMs = 0;
    private autoMs = 0;
    private clockHeld = false;
    private showDist = false;
    private debugMs = 0;
    private keyHandlers: [string, () => void][] = [];
    private offAudio: (() => void) | null = null;
    private offRun: (() => void) | null = null;
    private offHidden: (() => void) | null = null;
    private introTimer: Time.TimerEvent | null = null;
    /** Last settings seen by `applySettings` (so only real changes touch the board / speed). */
    private seenSettings = { colorBlind: false, speed: 1 as GameSpeed };
    private winResult: CompletionResult | null = null;

    constructor() {
        super('Play');
    }

    init(data: PlayData) {
        this.levelId = data.levelId ?? '';
        syncLevelParam(this.levelId);
        this.retry = data.retry ?? false;
        this.ready = false;
        this.phase = 'playing';
        this.winPending = false;
        this.deadMs = 0;
        this.autoMs = 0;
        this.clockHeld = false;
        this.showDist = false;
        this.winResult = null;
    }

    create() {
        this.flags = parseFlags(window.location.search);
        this.events.once('shutdown', () => this.teardown());
        void this.start();
    }

    // ------------------------------------------------------------------ setup

    private async start(): Promise<void> {
        try {
            const level = await this.obtainLevel();
            if (!this.scene.isActive()) return;
            this.build(level);
        } catch (err) {
            this.showError(err instanceof Error ? err.message : String(err));
        }
    }

    private async obtainLevel(): Promise<LevelData> {
        if (this.retry && gameFacade.level?.id === this.levelId) {
            gameFacade.restart();
            return gameFacade.level;
        }
        const fetched = await fetchLevel(this.levelId);
        const level: LevelData = this.flags.fillFirst ? { ...fetched, fillFirst: true } : fetched;
        gameFacade.load(level);
        return level;
    }

    private build(level: LevelData): void {
        const speed: GameSpeed = this.flags.speed === 2 ? 2 : getRunState().settings.speed;
        sceneActions.reset();
        sceneActions.setSpeed(speed);
        gameFacade.setSpeed(speed);
        gameFacade.setPace(this.flags.pace);
        runActions.setCurrentLevel(level.id);
        runActions.recordAttempt(level.id);
        roundActions.start(level.id);

        ensureFxTextures(this);
        this.rig = new CameraRig(this);
        this.cameras.main.fadeIn(300, 5, 3, 12);
        this.rig.uiCam.fadeIn(300, 5, 3, 12);
        this.bg = new Background(this);
        this.palette = level.palette.map(hexNum);
        this.layout = computeLayout({
            width: level.width,
            height: level.height,
            columns: level.columns.length,
            lanes: level.lanes,
        });
        this.grid = new NeonGrid(this);
        this.board = new BoardView(this, this.layout, this.palette, level.width, level.height);
        this.goo = new GooStream(this);
        this.goo.setFrame(this.board.frameRect());
        this.fx = new Fx(this);
        this.lanes = new LaneView(this, this.layout, this.palette);
        this.queue = new QueueView(this, this.layout, this.palette, {
            onColumnTap: (col) => this.onColumnTap(col),
            onLockHold: (podId) => this.tether.show(podId),
            onColorHold: (colors) => this.board.setFocus(colors),
            fx: this.fx,
        });
        const board = this.board;
        const queue = this.queue;
        this.tether = new KeyTether(
            this,
            { keyCenterFor: (podId) => board.keyCenterFor(podId), podCenter: (podId) => queue.podCenter(podId) },
            () => board.cellSize(),
            this.fx,
        );
        this.hud = new Hud(this, {
            levelName: level.name,
            speed,
            onPause: () => this.openPause(),
            onSpeed: (next) => this.setSpeed(next),
        });
        this.banner = new WaveBanner(this, 360, this.layout.toastY);
        this.toast = new Toast(this, 360, this.layout.toastY);
        this.modal = new ModalOverlay(this);
        this.board.setDistProvider((color, x, y) => gameFacade.distAt(color, x, y));
        this.runner = new PlaybackRunner(
            {
                layout: this.layout,
                palette: this.palette,
                board: this.board,
                goo: this.goo,
                lanes: this.lanes,
                queue: this.queue,
                getSnapshot: () => this.snapshot(),
                fx: this.fx,
                grid: this.grid,
                rig: this.rig,
                banner: this.banner,
            },
            { onWon: () => (this.winPending = true) },
        );
        this.runner.syncNow();
        this.hookAudio(level.meta.seed);
        if (new URLSearchParams(window.location.search).get('cb') === '1') runActions.updateSettings({ colorBlind: true });
        this.seenSettings = { colorBlind: false, speed: getRunState().settings.speed };
        this.applySettings();
        this.offRun = onRunChange(() => this.applySettings());
        if (this.devTools()) {
            this.setupDebugButtons();
            this.setupHotkeys();
        }
        this.game.events.on(Core.Events.HIDDEN, this.onPageHidden, this);
        this.offHidden = () => this.game.events.off(Core.Events.HIDDEN, this.onPageHidden, this);
        this.ready = true;
        this.showIntros(unseenMechanics(level, hasSeen));
    }

    /** Page hidden (tab switch, app switch, screen lock): open the pause menu so the clock is stopped on return. */
    private onPageHidden(): void {
        this.openPause();
    }

    /** Audio listens to the playback moments (visual timing) and the sim batches (music intensity). */
    private hookAudio(seed: number): void {
        this.offAudio = this.runner.addListener({
            batch: (events, snapshot) => audioDirector.onEvents(events, snapshot, true),
            gooArrived: () => audioDirector.onGooArrived(),
            podLaunched: () => audioDirector.onPodLaunched(),
            keyArrived: () => audioDirector.onKeyArrived(),
            denied: () => audioDirector.onDenied(),
            winSequenceStart: () => audioDirector.onWin(),
            overloadSequenceStart: () => audioDirector.onOverload(),
        });
        audioDirector.onLevelStart(seed);
    }

    /** Apply settings changed while playing (from the settings overlay): glyph overlay and speed. */
    private applySettings(): void {
        const { colorBlind, speed } = getRunState().settings;
        if (colorBlind !== this.seenSettings.colorBlind) this.board.setOverlayGlyphs(colorBlind);
        if (speed !== this.seenSettings.speed) this.setSpeed(speed);
        this.seenSettings = { colorBlind, speed };
    }

    private devTools(): boolean {
        return import.meta.env.DEV || this.flags.debug;
    }

    private snapshot(): ViewState {
        const s = gameFacade.snapshot();
        roundActions.setSnapshot(s);
        return s;
    }

    private showError(message: string): void {
        console.error(`[flow] ${message}`);
        const modal = new ModalOverlay(this);
        modal.show({
            title: 'ERROR',
            titleColor: COLORS.bad,
            lines: ['Could not load this level'],
            buttons: [{ label: 'LEVEL SELECT', onPress: () => this.toLevelSelect(), primary: true }],
        });
    }

    // ------------------------------------------------------------------ frame loop

    update(time: number, delta: number): void {
        if (!this.ready) return;
        this.bg.update(delta);
        this.rig.update(delta);
        this.grid.update(delta);
        this.goo.update(delta * gameFacade.getSpeed());
        this.queue.update(time);
        this.tether.update(delta);
        this.lanes.update(delta);
        this.banner.setCovered(this.modal.isOpen || this.toast.isShowing);
        this.banner.update(delta);
        this.fx.update(delta);
        if (this.phase === 'playing') this.advanceClock(delta);
        this.runner.pump();
        this.board.update(delta);
        if (this.phase === 'playing') {
            this.checkWin();
            this.checkLose(delta);
            this.autoplay(delta);
        }
        this.updateDebug(delta);
    }

    private advanceClock(delta: number): void {
        const events = gameFacade.advance(delta);
        if (events.length > 0) enqueuePlayback(events);
        if (!getSceneState().paused) roundActions.addElapsed(delta);
    }

    private checkWin(): void {
        if (!this.winPending && gameFacade.isWon()) this.winPending = true;
        if (!this.winPending || !this.runner.isIdle()) return;
        this.winPending = false;
        this.phase = 'won';
        roundActions.setStatus('won');
        this.winResult = runActions.markCompleted(this.levelId, getRoundState().elapsedMs);
        this.runner.playWin(() => this.showWin());
    }

    private checkLose(delta: number): void {
        const dead = !this.winPending && gameFacade.isSettled() && gameFacade.isDead();
        if (!dead || !this.runner.isIdle() || this.modal.isOpen) {
            this.deadMs = 0;
            return;
        }
        this.deadMs += delta;
        if (this.deadMs < OVERLOAD_GRACE_MS) return;
        this.phase = 'lost';
        roundActions.setStatus('lost');
        this.runner.playOverload(() => this.showLose());
    }

    /** Test affordance: `?autoplay=1` follows the stored solution, `?autoplay=random` taps random legal columns. */
    private autoplay(delta: number): void {
        if (this.flags.autoplay === 'off' || this.modal.isOpen) return;
        this.autoMs += delta;
        if (this.autoMs < AUTOPLAY_GAP_MS / gameFacade.getSpeed() || !this.runner.isIdle() || !gameFacade.isSettled()) return;
        const column = this.flags.autoplay === 'solution' ? gameFacade.nextHint() : this.randomLegalColumn();
        if (column === null) return;
        this.autoMs = 0;
        this.tapColumn(column);
    }

    private randomLegalColumn(): number | null {
        const legal: number[] = [];
        for (let c = 0; c < this.layout.queue.centers.length; c++) {
            if (gameFacade.tapReason(c) === null) legal.push(c);
        }
        if (legal.length === 0) return null;
        return legal[Math.floor(Math.random() * legal.length)]!;
    }

    // ------------------------------------------------------------------ input

    private onColumnTap(column: number): void {
        if (!this.ready || this.phase !== 'playing' || this.modal.isOpen) return;
        this.tapColumn(column);
    }

    private tapColumn(column: number): void {
        const result = gameFacade.tap(column);
        if (result.ok) {
            roundActions.recordTap();
            enqueuePlayback(result.events);
            return;
        }
        if (result.reason === 'empty') return;
        this.runner.denied(column);
        this.toast.show(this.denialText(column, result.reason));
    }

    private denialText(column: number, reason: TapDenial): string {
        if (reason === 'locked') {
            const lock = gameFacade.snapshot().columns[column]?.[0]?.lock;
            return lock === null || lock === undefined ? 'LOCKED' : `LOCKED - DRAIN KEY ${keyLetter(lock)} FIRST`;
        }
        if (reason === 'noLane') return 'NO FREE LANE';
        if (reason === 'partnerUnavailable') return 'PARTNER NOT AT THE FRONT';
        return '';
    }

    private setSpeed(speed: GameSpeed): void {
        gameFacade.setSpeed(speed);
        sceneActions.setSpeed(speed);
        runActions.updateSettings({ speed });
        this.hud.setSpeed(speed);
    }

    // ------------------------------------------------------------------ intro cards

    /** First time a level has hidden / locked / linked pods: one card per new mechanic, clock paused meanwhile. */
    private showIntros(cards: MechanicInfo[]): void {
        if (cards.length === 0 || this.flags.introOff) return;
        this.applyPause(true);
        sceneActions.setOverlay('intro');
        this.showIntro(cards, 0);
    }

    private showIntro(cards: MechanicInfo[], index: number): void {
        const info = cards[index];
        if (!info) return;
        let done = false;
        const onDone = () => {
            if (done) return;
            done = true;
            this.introTimer?.remove();
            this.introTimer = null;
            runActions.markSeen(introKey(info.id));
            if (index + 1 < cards.length) {
                this.showIntro(cards, index + 1);
                return;
            }
            this.modal.hide();
            sceneActions.setOverlay('none');
            this.applyPause(false);
        };
        this.modal.show(introContent(this, { info, art: paletteArtFromNums(this.palette), remaining: cards.length - index - 1, onDone }));
        if (this.flags.autoplay !== 'off') this.introTimer = this.time.delayedCall(AUTO_INTRO_MS, onDone);
    }

    // ------------------------------------------------------------------ overlays

    private openPause(): void {
        if (!this.ready || this.phase !== 'playing' || this.modal.isOpen) return;
        this.applyPause(true);
        sceneActions.setOverlay('pause');
        this.showPauseMenu();
    }

    private showPauseMenu(): void {
        this.modal.show({
            title: 'PAUSED',
            buttons: [
                { label: 'RESUME', primary: true, onPress: () => this.closePause() },
                { label: 'SETTINGS', onPress: () => this.modal.show(settingsContent(this, () => this.showPauseMenu())) },
                { label: 'SOLUTION', onPress: () => this.showSolution() },
                { label: 'RESTART', onPress: () => this.restartLevel() },
                { label: 'LEVEL SELECT', onPress: () => this.toLevelSelect() },
            ],
        });
    }

    private showSolution(): void {
        this.modal.show(
            solutionContent(this, {
                guide: gameFacade.solutionGuide(),
                art: paletteArtFromNums(this.palette),
                columns: this.layout.queue.centers.length,
                onResume: () => this.closePause(),
                onBack: () => this.showPauseMenu(),
            }),
        );
    }

    private closePause(): void {
        this.modal.hide();
        sceneActions.setOverlay('none');
        this.applyPause(false);
    }

    /** The clock stops while the pause overlay is open or the debug clock is held. */
    private applyPause(overlayPaused: boolean): void {
        sceneActions.setPaused(overlayPaused);
        gameFacade.setPaused(overlayPaused || this.clockHeld);
        audioDirector.onPauseChanged(overlayPaused);
    }

    private showWin(): void {
        if (!this.scene.isActive()) return;
        sceneActions.setOverlay('win');
        const round = getRoundState();
        const result = this.winResult;
        const lines = [`${round.taps} taps`, formatTime(round.elapsedMs)];
        if (result?.improved && !result.firstClear) lines.push('NEW BEST');
        else if (result && !result.improved) lines.push(`best ${formatTime(result.bestMs)}`);
        const buttons = [{ label: 'REPLAY', onPress: () => this.restartLevel() }, { label: 'LEVEL SELECT', onPress: () => this.toLevelSelect() }];
        void loadLevelList().then((list) => {
            if (!this.scene.isActive()) return;
            const next = nextLevelId(list, this.levelId);
            this.modal.show({
                title: 'LEVEL CLEAR',
                titleColor: COLORS.good,
                lines,
                // After the last level the select screen is the natural next step.
                buttons: next === null ? [{ ...buttons[1]!, primary: true }, buttons[0]!] : [{ label: 'NEXT', primary: true, onPress: () => this.goToLevel(next) }, ...buttons],
            });
        });
    }

    private showLose(): void {
        if (!this.scene.isActive()) return;
        sceneActions.setOverlay('lose');
        this.modal.show({
            title: 'OVERLOAD',
            titleColor: COLORS.bad,
            lines: ['No lane can make progress'],
            buttons: [
                { label: 'RETRY', primary: true, onPress: () => this.restartLevel() },
                { label: 'LEVEL SELECT', onPress: () => this.toLevelSelect() },
            ],
        });
    }

    // ------------------------------------------------------------------ navigation

    private restartLevel(): void {
        this.scene.restart({ levelId: this.levelId, retry: true } satisfies PlayData);
    }

    private goToLevel(id: string): void {
        this.scene.restart({ levelId: id } satisfies PlayData);
    }

    private toLevelSelect(): void {
        this.scene.start('LevelSelect');
    }

    // ------------------------------------------------------------------ debug (dev builds or ?debug=1)

    private setupDebugButtons(): void {
        if (!this.flags.debug) return;
        const dist = this.hud.addDebugButton('DIST', () => {
            this.showDist = !this.showDist;
            this.board.setShowDist(this.showDist);
            dist.setLabel(this.showDist ? 'DIST*' : 'DIST');
        });
        const hold = this.hud.addDebugButton('HOLD', () => {
            this.clockHeld = !this.clockHeld;
            this.applyPause(getSceneState().paused);
            hold.setLabel(this.clockHeld ? 'HOLD*' : 'HOLD');
        });
        this.hud.addDebugButton('STEP', () => this.debugStep());
        this.hud.addDebugButton('SETTLE', () => this.debugSettle());
        this.hud.addDebugButton('HINT', () => this.debugHint());
    }

    private setupHotkeys(): void {
        const keyboard = this.input.keyboard;
        if (!keyboard) return;
        const bind = (key: string, fn: () => void) => {
            const event = `keydown-${key}`;
            keyboard.on(event, fn);
            this.keyHandlers.push([event, fn]);
        };
        bind('S', () => this.debugStep());
        bind('F', () => this.debugSettle());
        bind('R', () => this.restartLevel());
        bind('N', () => {
            void loadLevelList().then((list) => {
                const next = nextLevelId(list, this.levelId);
                if (next !== null) this.goToLevel(next);
            });
        });
        bind('H', () => this.debugHint());
        bind('G', () => this.toggleGlyphs());
    }

    /** Color-blind aid: glyph overlay on the board tiles (settings, `?cb=1`, or `G` in dev). Persisted like the setting. */
    toggleGlyphs(): void {
        runActions.updateSettings({ colorBlind: !getRunState().settings.colorBlind });
    }

    private debugStep(): void {
        if (!this.ready || this.phase !== 'playing') return;
        enqueuePlayback(gameFacade.stepTick());
    }

    private debugSettle(): void {
        if (!this.ready || this.phase !== 'playing') return;
        enqueuePlayback(gameFacade.settleNow());
    }

    private debugHint(): void {
        if (!this.ready || this.phase !== 'playing' || this.modal.isOpen) return;
        const hint = gameFacade.nextHint();
        if (hint === null) return;
        this.tapColumn(hint);
    }

    private updateDebug(delta: number): void {
        if (!this.flags.debug) return;
        const settled = gameFacade.isSettled();
        this.queue.setHint(settled && this.phase === 'playing' ? gameFacade.nextHint() : null);
        this.debugMs += delta;
        if (this.debugMs < 100) return;
        this.debugMs = 0;
        const hint = gameFacade.nextHint();
        const fps = Math.round(this.game.loop.actualFps);
        const hintText = hint === null ? 'none' : settled ? `col ${hint + 1}` : 'wait';
        this.hud.setDebugLine(`hint: ${hintText}  ${settled ? 'SETTLED' : 'running'}  taps ${gameFacade.taps.length}  goo ${this.goo.activeCount}  ${fps}fps`);
    }

    // ------------------------------------------------------------------ teardown

    private teardown(): void {
        const keyboard = this.input.keyboard;
        for (const [event, fn] of this.keyHandlers) keyboard?.off(event, fn);
        this.keyHandlers = [];
        this.offAudio?.();
        this.offAudio = null;
        this.offRun?.();
        this.offRun = null;
        this.offHidden?.();
        this.offHidden = null;
        this.introTimer?.remove();
        this.introTimer = null;
        audioDirector.onPauseChanged(false);
        audioDirector.onLevelExit();
        this.runner?.dispose();
        this.goo?.destroy();
        this.fx?.clear();
        // The display list destroys the game objects on shutdown; these also free what it does not know about
        // (the board's dynamic textures would otherwise pile up, two per restart).
        this.board?.destroy();
        this.queue?.destroy();
        this.tether?.destroy();
        this.lanes?.destroy();
        this.hud?.destroy();
        this.banner?.destroy();
        this.toast?.destroy();
        this.modal?.destroy();
        gameFacade.setPaused(false);
        this.ready = false;
    }
}

