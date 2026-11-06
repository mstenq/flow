/**
 * Level select, which doubles as the title screen: "FLOW" and a settings cog on top, a vertically scrolling grid of
 * level tiles below (drag / swipe with inertia, mouse wheel). Each tile shows a mini render of the level image:
 *   locked     dark tile with a padlock
 *   open       the image, dimmed (the current level, the first one not yet cleared, pulses)
 *   cleared    the full neon image, slowly shimmering, with the best time
 * Name and status sit above the image; along the bottom every tile shows the lane count and the difficulty tier (pips, cooler to hotter).
 * The list is virtualized: only the tiles in or near the viewport exist as display objects (a small pool of
 * `TileView`s, rebound to other levels while scrolling). Mini images are drawn lazily into canvas textures (see
 * `miniArt.ts`) held in a bounded LRU (`MiniCache`), so 400 levels cost the same as 12.
 * A thin scrollbar with a "124 / 398" read-out shows the position; dragging it jumps through long lists.
 * Picking a level punches the camera in and fades to Play.
 */
import { BlendModes, Scene } from 'phaser';
import type { GameObjects, Input, Time, Tweens } from 'phaser';
import type { LevelEntry } from '@game/levelList';
import { DIFFICULTY_TIERS, campaignIds, difficultyTier } from '@game/levelList';
import { currentLevelIn, formatTime } from '@game/progress';
import { LOGICAL_H, LOGICAL_W } from '@game/layout';
import { SELECT, TILE_W, clampScroll, hitRect, isTap, layoutSelect, maxScroll, nearestRect, scrollFromTrack, scrollThumb, scrollToCenter, visibleRange } from '@game/selectLayout';
import type { Rect, SelectLayout } from '@game/selectLayout';
import { getRunState, isLevelUnlocked, onRunChange } from '@game/state';
import { fetchLevel, loadLevelList } from '../levels';
import { COLORS, font } from '../theme';
import { audioDirector } from '../audio';
import { syncLevelParam } from '../bootstrap';
import { Button } from '../ui/Button';
import { ModalOverlay } from '../ui/ModalOverlay';
import { settingsContent } from '../ui/SettingsOverlay';
import { Toast } from '../ui/Toast';
import { CameraRig, ui } from '../fx/CameraRig';
import { ensureFxTextures } from '../fx/textures';
import { isReducedFx, onReducedFxChange } from '../fx/fxSettings';
import { Background } from '../view/Background';
import { NeonGrid } from '../view/NeonGrid';
import { MiniCache } from '../view/miniCache';
import type { MiniKind, MiniSource } from '../view/miniArt';

const HEADER_H = 190;
const LIST_TOP = HEADER_H;
const VIEW_H = LOGICAL_H - LIST_TOP;
/** On-screen box for the mini image inside a tile. */
const ART_W = TILE_W - 36;
const ART_H = 256;
/** Tile rows, as offsets from the tile center: name and status on top, the image, then the stats row. */
const NAME_DY = -SELECT.tileH / 2 + 28;
const META_DY = NAME_DY + 24;
const ART_DY = META_DY + 16 + ART_H / 2;
/** Stats row (lanes left, difficulty pips right), inset from the tile edges. */
const STATS_DY = SELECT.tileH / 2 - 20;
const STATS_INSET = 22;
const PIP_R = 5;
const PIP_GAP = 15;
/** Pip color per difficulty tier (1..DIFFICULTY_TIERS). */
const TIER_COLORS = [0x7dff3a, 0x22e6ff, 0xffe600, 0xffb020, 0xff3b5c] as const;
/** Pixels of movement before a press becomes a drag (never a tap). */
const DRAG_THRESHOLD = 14;
/** Scroll friction (per ms) and the minimum speed (px/ms) that still coasts. */
const FRICTION = 0.0042;
const MIN_COAST = 0.012;

/** Rows above and below the viewport that already have tiles bound (so a fling never shows empty rows). */
const OVERSCAN = SELECT.tileH + SELECT.gapY;
/** Mini textures generated per frame at most (a fling can reveal several tiles at once). */
const ARTS_PER_FRAME = 2;
/** Scrollbar geometry (right edge) and how long the read-out stays after the last movement. */
const BAR_X = LOGICAL_W - 14;
const BAR_TOP = LIST_TOP + 18;
const BAR_H = LOGICAL_H - 18 - BAR_TOP;
const BAR_HIT_W = 40;
const READOUT_MS = 1100;

type TileState = 'locked' | 'open' | 'done';

/** One pooled set of display objects; rebound to whichever level is scrolled into view. */
interface TileView {
    /** Index into `all` (rects/entries) while bound, else -1. */
    index: number;
    entry: LevelEntry | null;
    state: TileState;
    current: boolean;
    kind: MiniKind;
    artKey: string | null;
    shakeX: number;
    frame: GameObjects.Graphics;
    halo: GameObjects.Graphics;
    padlock: GameObjects.Graphics;
    art: GameObjects.Image;
    sheen: GameObjects.Image;
    name: GameObjects.Text;
    meta: GameObjects.Text;
    lanes: GameObjects.Text;
    pips: GameObjects.Graphics;
    tweens: Tweens.Tween[];
}

interface Drag {
    id: number;
    startY: number;
    startX: number;
    startScroll: number;
    lastY: number;
    lastT: number;
    vel: number;
    moved: boolean;
}

export class LevelSelect extends Scene {
    private list: LevelEntry[] = [];
    private layout: SelectLayout = layoutSelect(0, 0);
    private all: Rect[] = [];
    private entries: LevelEntry[] = [];
    private campaignCount = 0;
    private order: string[] = [];
    private currentId: string | null = null;
    private views: TileView[] = [];
    private pool: TileView[] = [];
    private bound = new Map<number, TileView>();
    private artQueue: TileView[] = [];
    private fetching = new Set<string>();
    private sources = new Map<string, MiniSource>();
    private minis: MiniCache | null = null;
    private barGfx: GameObjects.Graphics | null = null;
    private readout: GameObjects.Text | null = null;
    private readoutUntil = 0;
    private scrubId: number | null = null;
    private barZone: GameObjects.Zone | null = null;
    private devTitle: GameObjects.Text | null = null;
    private subtitleText: GameObjects.Text | null = null;
    private subtitleTimer: Time.TimerEvent | null = null;
    private bg: Background | null = null;
    private grid: NeonGrid | null = null;
    private rig: CameraRig | null = null;
    private modal: ModalOverlay | null = null;
    private toast: Toast | null = null;
    private scrollZone: GameObjects.Zone | null = null;
    private offFx: (() => void) | null = null;
    private offRun: (() => void) | null = null;
    /** Last `unlockAll` seen, so only a real flip rebinds the tiles. */
    private unlockAll = false;
    private scroll = 0;
    private vel = 0;
    private drag: Drag | null = null;
    private dirty = true;
    private leaving = false;

    constructor() {
        super('LevelSelect');
    }

    create() {
        syncLevelParam(null);
        this.all = [];
        this.entries = [];
        this.views = [];
        this.pool = [];
        this.bound = new Map();
        this.artQueue = [];
        this.fetching = new Set();
        this.sources = new Map();
        this.minis = new MiniCache(this);
        this.barGfx = null;
        this.readout = null;
        this.readoutUntil = 0;
        this.scrubId = null;
        this.barZone = null;
        this.devTitle = null;
        this.subtitleText = null;
        this.subtitleTimer = null;
        this.scroll = 0;
        this.vel = 0;
        this.drag = null;
        this.dirty = true;
        this.leaving = false;
        ensureFxTextures(this);
        this.rig = new CameraRig(this);
        this.bg = new Background(this);
        this.grid = new NeonGrid(this);
        this.cameras.main.fadeIn(250, 5, 3, 12);
        this.buildHeader();
        this.scrollZone = this.add.zone(LOGICAL_W / 2, LIST_TOP + VIEW_H / 2, LOGICAL_W, VIEW_H);
        this.scrollZone.setInteractive();
        this.scrollZone.on('pointerdown', (p: Input.Pointer) => this.beginDrag(p));
        this.input.on('pointermove', this.onMove, this);
        this.input.on('pointerup', this.onRelease, this);
        this.input.on('pointerupoutside', this.onRelease, this);
        this.input.on('wheel', this.onWheel, this);
        this.toast = new Toast(this, LOGICAL_W / 2, 150);
        this.modal = new ModalOverlay(this);
        this.offFx = onReducedFxChange(() => this.views.forEach((v) => this.animate(v)));
        this.unlockAll = getRunState().unlockAll;
        this.offRun = onRunChange(() => this.onRunChanged());
        this.events.once('shutdown', () => this.teardown());
        const loading = ui(this.add.text(LOGICAL_W / 2, 640, 'Loading...', font(24, COLORS.dim)).setOrigin(0.5));
        void loadLevelList().then((list) => {
            if (!this.scene.isActive()) return;
            loading.destroy();
            this.list = list;
            this.buildTiles();
        });
    }

    // ------------------------------------------------------------------ header

    private buildHeader(): void {
        const bar = this.add.graphics().setDepth(5);
        bar.fillStyle(0x05030c, 0.985);
        bar.fillRect(0, 0, LOGICAL_W, HEADER_H);
        bar.lineStyle(6, COLORS.frame, 0.08);
        bar.lineBetween(0, HEADER_H, LOGICAL_W, HEADER_H);
        bar.lineStyle(1.5, COLORS.frame, 0.55);
        bar.lineBetween(0, HEADER_H, LOGICAL_W, HEADER_H);
        bar.fillStyle(COLORS.frame, 0.9);
        bar.fillRect(LOGICAL_W / 2 - 40, HEADER_H - 1, 80, 3);
        // The title is deliberately on the bloomed camera: it glows.
        this.add.text(LOGICAL_W / 2, 84, 'FLOW', { ...font(76, COLORS.accent), letterSpacing: 10 }).setOrigin(0.5).setDepth(6);
        const cog = new Button(this, { x: LOGICAL_W - 66, y: 70, w: 84, h: 84, label: '', onPress: () => this.openSettings(), edge: COLORS.frame });
        cog.container.add(this.gear());
        ui(cog.container);
    }

    /** Settings cog (drawn, so it does not depend on the font having a gear glyph). */
    private gear(): GameObjects.Graphics {
        const g = this.add.graphics();
        const teeth = 8;
        const pts: { x: number; y: number }[] = [];
        for (let i = 0; i < teeth; i++) {
            const a = (i / teeth) * Math.PI * 2;
            const span = Math.PI / teeth;
            for (const [da, r] of [[-span * 0.62, 17], [-span * 0.36, 24], [span * 0.36, 24], [span * 0.62, 17]] as const) {
                pts.push({ x: Math.cos(a + da) * r, y: Math.sin(a + da) * r });
            }
        }
        g.lineStyle(3, 0xe8f6ff, 1);
        g.beginPath();
        pts.forEach((pt, i) => (i === 0 ? g.moveTo(pt.x, pt.y) : g.lineTo(pt.x, pt.y)));
        g.closePath();
        g.strokePath();
        g.strokeCircle(0, 0, 8);
        return g;
    }

    private openSettings(): void {
        const modal = this.modal;
        if (!modal || modal.isOpen || this.leaving) return;
        modal.show(settingsContent(this, () => modal.hide()));
    }

    /** The unlock-all setting flipped (settings overlay): rebind every tile so locks and labels update. */
    private onRunChanged(): void {
        const { unlockAll } = getRunState();
        if (unlockAll === this.unlockAll) return;
        this.unlockAll = unlockAll;
        for (const view of [...this.bound.values()]) this.unbind(view);
        this.dirty = true;
    }

    private subtitle(): string {
        const order = campaignIds(this.list);
        const done = order.filter((id) => getRunState().completed[id] !== undefined).length;
        return done === 0 ? 'SELECT A LEVEL' : `${done} / ${order.length} CLEARED`;
    }

    // ------------------------------------------------------------------ tiles

    private buildTiles(): void {
        const campaign = this.list.filter((e) => !e.dev);
        const dev = this.list.filter((e) => e.dev);
        this.layout = layoutSelect(campaign.length, dev.length);
        this.all = [...this.layout.campaign, ...this.layout.dev];
        this.entries = [...campaign, ...dev];
        this.campaignCount = campaign.length;
        this.subtitleText = ui(this.add.text(LOGICAL_W / 2, 150, this.subtitle(), { ...font(20, COLORS.dim), letterSpacing: 4 }).setOrigin(0.5).setDepth(6));
        if (this.list.length === 0) {
            ui(this.add.text(LOGICAL_W / 2, 640, 'No levels found', font(26, COLORS.warn)).setOrigin(0.5));
            return;
        }
        this.order = campaignIds(this.list);
        this.currentId = currentLevelIn(getRunState().completed, this.order);
        if (dev.length > 0 && this.layout.devTitleY !== null) {
            this.devTitle = ui(this.add.text(LOGICAL_W / 2, 0, 'DEV LEVELS', { ...font(22, COLORS.warn), letterSpacing: 6 }).setOrigin(0.5));
        }
        this.buildScrollbar();
        const cur = this.entries.findIndex((e) => e.id === this.currentId);
        if (cur >= 0) this.scroll = scrollToCenter(this.all[cur]!, this.layout.contentHeight, VIEW_H);
        this.dirty = true;
    }

    private tileState(entry: LevelEntry): TileState {
        if (getRunState().completed[entry.id] !== undefined) return 'done';
        if (entry.dev || isLevelUnlocked(entry.id, this.order)) return 'open';
        return 'locked';
    }

    /** One set of tile display objects (the pool grows to what the viewport + overscan needs, ~12 tiles). */
    private createView(): TileView {
        const w = TILE_W;
        const h = SELECT.tileH;
        const frame = this.add.graphics();
        const halo = this.add.graphics();
        halo.lineStyle(12, COLORS.frame, 0.14);
        halo.strokeRoundedRect(-w / 2 - 3, -h / 2 - 3, w + 6, h + 6, 24);
        halo.lineStyle(3, COLORS.frame, 1);
        halo.strokeRoundedRect(-w / 2, -h / 2, w, h, 20);
        const padlock = this.padlock();
        const art = this.add.image(0, 0, '__DEFAULT');
        const sheen = this.add.image(0, 0, '__DEFAULT').setBlendMode(BlendModes.ADD).setAlpha(0);
        const name = ui(this.add.text(0, 0, '', font(22)).setOrigin(0.5));
        const meta = ui(this.add.text(0, 0, '', font(16)).setOrigin(0.5));
        const lanes = ui(this.add.text(0, 0, '', { ...font(14, COLORS.dim), letterSpacing: 2 }).setOrigin(0, 0.5));
        const pips = ui(this.add.graphics());
        const view: TileView = {
            index: -1,
            entry: null,
            state: 'open',
            current: false,
            kind: 'dim',
            artKey: null,
            shakeX: 0,
            frame,
            halo,
            padlock,
            art,
            sheen,
            name,
            meta,
            lanes,
            pips,
            tweens: [],
        };
        this.views.push(view);
        this.hide(view);
        return view;
    }

    private hide(view: TileView): void {
        for (const o of [view.frame, view.halo, view.padlock, view.art, view.sheen, view.name, view.meta, view.lanes, view.pips]) o.setVisible(false);
    }

    private drawFrame(view: TileView): void {
        const w = TILE_W;
        const h = SELECT.tileH;
        const state = view.state;
        const frame = view.frame;
        frame.clear();
        const edge = state === 'done' ? COLORS.frame : state === 'open' ? 0x4a4f9a : 0x241f45;
        if (state === 'done') {
            frame.lineStyle(10, edge, 0.1);
            frame.strokeRoundedRect(-w / 2 - 2, -h / 2 - 2, w + 4, h + 4, 22);
        }
        frame.fillStyle(state === 'locked' ? 0x07051a : 0x0a0720, 0.92);
        frame.fillRoundedRect(-w / 2, -h / 2, w, h, 20);
        frame.lineStyle(2, edge, state === 'done' ? 0.9 : 0.8);
        frame.strokeRoundedRect(-w / 2, -h / 2, w, h, 20);
    }

    /** Take a pooled view (or make one) and point it at level `index`. */
    private bind(index: number): void {
        const view = this.pool.pop() ?? this.createView();
        const entry = this.entries[index]!;
        const w = TILE_W;
        view.index = index;
        view.entry = entry;
        view.state = this.tileState(entry);
        view.current = entry.id === this.currentId;
        view.kind = view.state === 'done' ? 'color' : 'dim';
        view.artKey = null;
        view.shakeX = 0;
        this.bound.set(index, view);
        this.drawFrame(view);
        const number = index < this.campaignCount ? index + 1 : index - this.campaignCount + 1;
        const state = view.state;
        const name = state === 'locked' ? `LEVEL ${String(number).padStart(2, '0')}` : `${String(number).padStart(2, '0')}  ${entry.name.toUpperCase()}`;
        view.name.setScale(1).setText(name).setColor(state === 'locked' ? COLORS.dim : COLORS.text);
        if (view.name.width > w - 28) view.name.setScale((w - 28) / view.name.width);
        const best = getRunState().completed[entry.id]?.bestMs;
        const meta =
            state === 'done' && best !== undefined
                ? { text: `BEST ${formatTime(best)}`, color: COLORS.good }
                : state === 'open'
                  ? { text: view.current ? 'PLAY' : entry.width > 0 ? `${entry.width} x ${entry.height}` : '', color: view.current ? COLORS.accent : COLORS.dim }
                  : { text: 'LOCKED', color: '#46426e' };
        view.meta.setText(meta.text).setColor(meta.color);
        this.drawStats(view, entry);
        view.art.setTexture('__DEFAULT');
        view.sheen.setTexture('__DEFAULT');
        if (state !== 'locked') this.requestArt(view);
        this.animate(view);
    }

    /** Lane count (left) and difficulty pips (right, filled up to the tier in its color). Locked tiles show them muted. */
    private drawStats(view: TileView, entry: LevelEntry): void {
        const locked = view.state === 'locked';
        view.lanes.setText(entry.lanes > 0 ? `${entry.lanes} LANES` : '').setColor(locked ? '#46426e' : COLORS.dim);
        const tier = difficultyTier(entry.difficulty);
        const color = TIER_COLORS[tier - 1]!;
        const g = view.pips;
        g.clear();
        for (let i = 0; i < DIFFICULTY_TIERS; i++) {
            const x = -(DIFFICULTY_TIERS - 1 - i) * PIP_GAP;
            if (i < tier) {
                g.fillStyle(color, locked ? 0.35 : 1);
                g.fillCircle(x, 0, PIP_R);
                continue;
            }
            g.lineStyle(1.5, 0x4a4f9a, locked ? 0.5 : 0.9);
            g.strokeCircle(x, 0, PIP_R - 0.5);
        }
    }

    /** Return a view to the pool: stop its tweens, drop its texture reference, hide it. */
    private unbind(view: TileView): void {
        this.bound.delete(view.index);
        this.stopTweens(view);
        this.tweens.killTweensOf(view);
        view.index = -1;
        view.entry = null;
        view.artKey = null;
        view.art.setTexture('__DEFAULT').setAlpha(1);
        view.sheen.setTexture('__DEFAULT').setAlpha(0);
        this.hide(view);
        this.pool.push(view);
    }

    private stopTweens(view: TileView): void {
        for (const t of view.tweens) t.remove();
        view.tweens = [];
    }

    private padlock(): GameObjects.Graphics {
        const g = this.add.graphics();
        g.lineStyle(5, 0x4b4f8c, 1);
        g.strokeRoundedRect(-30, -6, 60, 48, 9);
        g.beginPath();
        g.arc(0, -6, 19, Math.PI, Math.PI * 2);
        g.strokePath();
        g.fillStyle(0x4b4f8c, 1);
        g.fillCircle(0, 16, 6);
        g.fillRect(-2.5, 18, 5, 12);
        return g;
    }

    /** Source for a tile's mini art: the index thumbnail, or a level fetched earlier (dev levels have no thumbnail). */
    private sourceOf(entry: LevelEntry): MiniSource | null {
        if (entry.cells && entry.palette) return { id: entry.id, width: entry.width, height: entry.height, palette: entry.palette, cells: entry.cells };
        return this.sources.get(entry.id) ?? null;
    }

    /** Show the tile's art now if its texture is cached, else queue it (a few are generated per frame). */
    private requestArt(view: TileView): void {
        const entry = view.entry;
        if (!entry) return;
        const src = this.sourceOf(entry);
        if (!src) {
            this.fetchSource(entry.id);
            return;
        }
        if (this.minis?.has(entry.id, view.kind)) this.applyArt(view, src);
        else this.artQueue.push(view);
    }

    private fetchSource(id: string): void {
        if (this.fetching.has(id)) return;
        this.fetching.add(id);
        void fetchLevel(id)
            .then((level) => {
                this.fetching.delete(id);
                if (!this.scene.isActive()) return;
                this.sources.set(id, { id, width: level.width, height: level.height, palette: level.palette, cells: level.cells });
                for (const v of this.bound.values()) if (v.entry?.id === id && v.artKey === null) this.requestArt(v);
            })
            .catch(() => this.fetching.delete(id));
    }

    private applyArt(view: TileView, src: MiniSource): void {
        const minis = this.minis;
        if (!minis) return;
        const mini = minis.get(src, view.kind, (key) => this.views.some((v) => v.artKey === key));
        view.artKey = mini.key;
        const scale = Math.min(ART_W / mini.w, ART_H / mini.h);
        view.art.setTexture(mini.key).setScale(scale);
        view.sheen.setTexture(mini.key).setScale(scale);
        this.animate(view);
        this.dirty = true;
    }

    /** Generate queued textures, at most `ARTS_PER_FRAME` per call, skipping tiles that scrolled away meanwhile. */
    private drainArtQueue(): void {
        let made = 0;
        while (made < ARTS_PER_FRAME && this.artQueue.length > 0) {
            const view = this.artQueue.shift()!;
            if (view.index < 0 || view.artKey !== null || !view.entry) continue;
            const src = this.sourceOf(view.entry);
            if (!src) continue;
            this.applyArt(view, src);
            made++;
        }
    }

    /** Pulse the current tile, shimmer the cleared ones (static when effects are reduced). */
    private animate(view: TileView): void {
        this.stopTweens(view);
        const reduced = isReducedFx();
        const i = view.index;
        view.halo.setAlpha(1);
        view.art.setAlpha(1);
        const showSheen = view.state === 'done' && view.artKey !== null;
        view.sheen.setAlpha(reduced && showSheen ? 0.06 : 0);
        if (showSheen && !reduced) {
            view.tweens.push(
                this.tweens.add({ targets: view.sheen, alpha: 0.32, duration: 1900 + (i % 5) * 260, delay: (i * 370) % 2200, ease: 'Sine.easeInOut', yoyo: true, repeat: -1, hold: 300 }),
            );
        }
        if (!view.current) return;
        view.tweens.push(this.tweens.add({ targets: view.halo, alpha: 0.3, duration: 800, ease: 'Sine.easeInOut', yoyo: true, repeat: -1 }));
        if (view.artKey !== null) view.tweens.push(this.tweens.add({ targets: view.art, alpha: 0.55, duration: 800, ease: 'Sine.easeInOut', yoyo: true, repeat: -1 }));
    }

    // ------------------------------------------------------------------ position indicator

    private buildScrollbar(): void {
        this.barGfx = ui(this.add.graphics().setDepth(7));
        this.readout = ui(
            this.add
                .text(BAR_X - 22, BAR_TOP, '', { ...font(20, COLORS.accent), backgroundColor: '#0a0720', padding: { x: 12, y: 6 } })
                .setOrigin(1, 0.5)
                .setDepth(8)
                .setAlpha(0),
        );
        // Long lists get a wide strip along the right edge: touch it and drag to jump.
        if (this.layout.contentHeight <= VIEW_H * 3) return;
        this.barZone = this.add.zone(LOGICAL_W - BAR_HIT_W / 2, LIST_TOP + VIEW_H / 2, BAR_HIT_W, VIEW_H).setDepth(2);
        this.barZone.setInteractive();
        this.barZone.on('pointerdown', (p: Input.Pointer) => this.beginScrub(p));
    }

    private beginScrub(p: Input.Pointer): void {
        if (!this.canScroll() || this.drag) return;
        this.vel = 0;
        this.scrubId = p.id;
        this.scrubTo(p.y);
    }

    private scrubTo(y: number): void {
        this.setScroll(scrollFromTrack(y - BAR_TOP, this.layout.contentHeight, VIEW_H, BAR_H));
    }

    /** Redraw the scrollbar thumb and the "124 / 398" read-out for the current scroll. */
    private drawPosition(): void {
        const g = this.barGfx;
        const readout = this.readout;
        if (!g || !readout || this.layout.contentHeight <= VIEW_H) return;
        const { top, height } = scrollThumb(clampScroll(this.scroll, this.layout.contentHeight, VIEW_H), this.layout.contentHeight, VIEW_H, BAR_H);
        const active = this.scrubId !== null || this.drag?.moved === true;
        g.clear();
        g.fillStyle(0x3a3366, 0.35);
        g.fillRoundedRect(BAR_X - 2, BAR_TOP, 4, BAR_H, 2);
        g.fillStyle(COLORS.frame, active ? 0.95 : 0.6);
        g.fillRoundedRect(BAR_X - (active ? 4 : 3), BAR_TOP + top, active ? 8 : 6, height, 3);
        const row = nearestRect(this.all, this.scroll + VIEW_H / 2);
        const idx = Math.max(0, row) - (Math.max(0, row) % SELECT.cols);
        const text = idx >= this.campaignCount ? 'DEV' : `${idx + 1} / ${this.campaignCount}`;
        if (readout.text !== text) readout.setText(text);
        readout.setY(Math.max(BAR_TOP + 22, Math.min(BAR_TOP + BAR_H - 22, BAR_TOP + top + height / 2)));
    }

// ------------------------------------------------------------------ scrolling

    private onWheel(_p: unknown, _over: unknown, _dx: number, dy: number): void {
        if (!this.canScroll()) return;
        this.vel = 0;
        this.setScroll(clampScroll(this.scroll + dy, this.layout.contentHeight, VIEW_H));
    }

    private canScroll(): boolean {
        return !this.leaving && !this.modal?.isOpen;
    }

    private beginDrag(p: Input.Pointer): void {
        if (!this.canScroll() || this.drag) return;
        this.vel = 0;
        this.drag = { id: p.id, startX: p.x, startY: p.y, startScroll: this.scroll, lastY: p.y, lastT: this.time.now, vel: 0, moved: false };
    }

    private onMove(p: Input.Pointer): void {
        if (this.scrubId === p.id && p.isDown) {
            this.scrubTo(p.y);
            return;
        }
        const d = this.drag;
        if (!d || d.id !== p.id || !p.isDown) return;
        const dy = p.y - d.startY;
        if (!d.moved && !isTap(p.x - d.startX, dy, DRAG_THRESHOLD)) d.moved = true;
        if (!d.moved) return;
        const now = this.time.now;
        const dt = Math.max(1, now - d.lastT);
        d.vel = d.vel * 0.55 + ((d.lastY - p.y) / dt) * 0.45;
        d.lastY = p.y;
        d.lastT = now;
        this.setScroll(this.rubber(d.startScroll - dy));
    }

    private onRelease(p: Input.Pointer): void {
        if (this.scrubId === p.id) {
            this.scrubId = null;
            this.dirty = true;
            return;
        }
        const d = this.drag;
        if (!d || d.id !== p.id) return;
        this.drag = null;
        if (!d.moved) {
            this.tap(p.x, p.y);
            return;
        }
        this.vel = this.time.now - d.lastT < 90 ? d.vel : 0;
    }

    /** Past the ends the content follows the finger at a third of the distance. */
    private rubber(raw: number): number {
        const max = maxScroll(this.layout.contentHeight, VIEW_H);
        if (raw < 0) return raw * 0.35;
        if (raw > max) return max + (raw - max) * 0.35;
        return raw;
    }

    private setScroll(value: number): void {
        if (value === this.scroll) return;
        this.scroll = value;
        this.dirty = true;
        this.readoutUntil = this.time.now + READOUT_MS;
    }

    private tap(x: number, y: number): void {
        if (!this.canScroll() || y < LIST_TOP) return;
        const contentY = y - LIST_TOP + this.scroll;
        const { start, end } = visibleRange(this.all, contentY, contentY);
        const i = hitRect(this.all.slice(start, end), x, contentY);
        const tile = i < 0 ? undefined : this.bound.get(start + i);
        if (!tile) return;
        if (tile.state === 'locked') {
            this.deny(tile);
            return;
        }
        audioDirector.onUiClick();
        const rect = this.all[tile.index]!;
        this.pick(tile.entry!.id, rect.y + rect.h / 2 - this.scroll + LIST_TOP);
    }

    private deny(tile: TileView): void {
        audioDirector.onDenied();
        // The message takes the subtitle's place for a moment.
        this.toast?.show('CLEAR THE PREVIOUS LEVEL FIRST');
        this.subtitleText?.setAlpha(0);
        this.subtitleTimer?.remove();
        this.subtitleTimer = this.time.delayedCall(1400, () => this.subtitleText?.setAlpha(1));
        this.tweens.killTweensOf(tile);
        tile.shakeX = 14;
        this.tweens.add({ targets: tile, shakeX: 0, duration: 380, ease: 'Elastic.easeOut', onUpdate: () => (this.dirty = true) });
    }

    // ------------------------------------------------------------------ frame

    update(_time: number, delta: number): void {
        this.bg?.update(delta);
        this.grid?.update(delta);
        this.rig?.update(delta);
        this.coast(delta);
        if (this.dirty) this.place();
        this.drainArtQueue();
        this.readout?.setAlpha(this.scrubId !== null || this.drag?.moved === true ? 1 : Math.max(0, Math.min(1, (this.readoutUntil - this.time.now) / 300)));
    }

    /** Inertia after a swipe, and the spring back from the rubber band. */
    private coast(delta: number): void {
        if (this.drag?.moved) return;
        const max = maxScroll(this.layout.contentHeight, VIEW_H);
        if (this.scroll < 0 || this.scroll > max) {
            const target = this.scroll < 0 ? 0 : max;
            this.vel = 0;
            const next = this.scroll + (target - this.scroll) * Math.min(1, delta * 0.014);
            this.setScroll(Math.abs(next - target) < 0.4 ? target : next);
            return;
        }
        if (Math.abs(this.vel) < MIN_COAST) {
            this.vel = 0;
            return;
        }
        this.setScroll(this.scroll + this.vel * delta);
        this.vel *= Math.exp(-FRICTION * delta);
    }

    /**
     * Bind tiles that entered the window (viewport plus overscan), recycle the ones that left, then move every
     * bound tile to its place for the current scroll and fade labels at the header.
     */
    private place(): void {
        this.dirty = false;
        const { start, end } = visibleRange(this.all, this.scroll - OVERSCAN, this.scroll + VIEW_H + OVERSCAN);
        for (const view of [...this.bound.values()]) if (view.index < start || view.index >= end) this.unbind(view);
        for (let i = start; i < end; i++) if (!this.bound.has(i)) this.bind(i);
        const w = TILE_W;
        const h = SELECT.tileH;
        for (const view of this.bound.values()) {
            const rect = this.all[view.index]!;
            const cy = LIST_TOP + rect.y - this.scroll;
            const onScreen = cy + h > LIST_TOP - 10 && cy < LOGICAL_H + 10;
            const x = rect.x + w / 2 + view.shakeX;
            const cyMid = cy + h / 2;
            const artY = cyMid + ART_DY;
            const artOn = onScreen && view.artKey !== null;
            view.frame.setVisible(onScreen).setPosition(x, cyMid);
            view.halo.setVisible(onScreen && view.current).setPosition(x, cyMid);
            view.padlock.setVisible(onScreen && view.state === 'locked').setPosition(x, artY);
            view.art.setVisible(artOn).setPosition(x, artY);
            view.sheen.setVisible(artOn && view.state === 'done').setPosition(x, artY);
            const statsY = cyMid + STATS_DY;
            const nameY = cyMid + NAME_DY;
            const metaY = cyMid + META_DY;
            view.lanes.setVisible(onScreen).setPosition(x - w / 2 + STATS_INSET, statsY).setAlpha(fadeAt(statsY));
            view.pips.setVisible(onScreen).setPosition(x + w / 2 - STATS_INSET - PIP_R, statsY).setAlpha(fadeAt(statsY));
            view.name.setVisible(onScreen).setPosition(x, nameY).setAlpha(fadeAt(nameY));
            view.meta.setVisible(onScreen).setPosition(x, metaY).setAlpha(fadeAt(metaY));
        }
        if (this.devTitle && this.layout.devTitleY !== null) {
            const y = LIST_TOP + this.layout.devTitleY + SELECT.sectionH / 2 - this.scroll;
            this.devTitle.setPosition(LOGICAL_W / 2, y).setAlpha(fadeAt(y));
            this.devTitle.setVisible(y > LIST_TOP - 20 && y < LOGICAL_H + 20);
        }
        this.drawPosition();
    }

    // ------------------------------------------------------------------ leaving

    /** Zoom toward the picked tile with a grid shockwave, fade out, then start Play. */
    private pick(levelId: string, y: number): void {
        if (this.leaving) return;
        this.leaving = true;
        this.grid?.applyImpulse(LOGICAL_W / 2, y, 900, 520);
        for (const cam of [this.cameras.main, this.rig?.uiCam]) {
            if (!cam) continue;
            cam.pan(LOGICAL_W / 2, y, 320, 'Cubic.easeIn');
            cam.zoomTo(1.6, 320, 'Cubic.easeIn');
        }
        this.cameras.main.fadeOut(320, 5, 3, 12);
        this.rig?.uiCam.fadeOut(320, 5, 3, 12);
        this.time.delayedCall(330, () => this.scene.start('Play', { levelId }));
    }

    private teardown(): void {
        // The scene's display list is already destroyed at shutdown, so nothing references the mini textures any more.
        for (const view of this.views) this.stopTweens(view);
        this.minis?.clear();
        this.minis = null;
        this.input.off('pointermove', this.onMove, this);
        this.input.off('pointerup', this.onRelease, this);
        this.input.off('pointerupoutside', this.onRelease, this);
        this.input.off('wheel', this.onWheel, this);
        this.offFx?.();
        this.offFx = null;
        this.offRun?.();
        this.offRun = null;
        this.toast?.destroy();
        this.toast = null;
        this.modal?.destroy();
        this.modal = null;
    }
}

/** Labels live on the UI camera (drawn over the header bar), so they fade out as they near it. */
function fadeAt(y: number): number {
    return Math.max(0, Math.min(1, (y - (LIST_TOP + 14)) / 40));
}
