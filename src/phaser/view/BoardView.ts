/**
 * BoardView (neon): the board is one DynamicTexture of rounded glowing tiles (tinted white tile + additive hot core),
 * composited by a small shader that adds a slow shimmer wave and a pulse on cells reachable by active lane colors
 * (a second DynamicTexture is the reachable mask). Tiles are stamped only on change: a claim clears just that cell.
 * Around it: a translucent panel and a thin neon frame (the goo rides it). Keys are crystal icons in the color of the
 * cell they sit on (drain that color to collect them), with a sparkle.
 * Claimed tiles "melt" (pooled squash + additive flash). `showHologram` ghosts the original image back in (win).
 *
 * Public interface (kept from the gray box):
 *   constructor(scene, layout, palette, width, height)
 *   sync(snapshot)            full refresh from the sim (never drifts)
 *   onClaimed(event)          remove the claimed cell instantly (the GooStream carries the visual)
 *   update(dtMs?)             per-frame housekeeping (redraw if dirty, melts, sparkles)
 *   cellCenter(x, y)          logical pixel center of a cell
 *   keyCenterFor(podId)       center of the cell holding the key that unlocks `podId`, or null
 *   setDistProvider(fn)/setShowDist(on)   dev overlay
 *   destroy()
 * Added: frameRect(), flare(ms), showHologram(ms), setOverlayGlyphs(on).
 */
import { BlendModes } from 'phaser';
import type { GameObjects, Scene, Textures } from 'phaser';
import type { Layout, Point2, Rect } from '@game/layout';
import { cellCenter } from '@game/layout';
import type { KeyView, LaneState, SimEvent, ViewState } from '@game/types';
import { EMPTY } from '@game/types';
import { mixColor } from '@data/themeColors';
import { COLORS, DEPTH, font, keyLetter, paletteArtFromNums } from '../theme';
import type { PaletteArt } from '../theme';
import { ui } from '../fx/CameraRig';
import { TEX, ensureTileCoreTexture, ensureTileTexture } from '../fx/textures';
import { drawGlyph } from './podArt';

type ClaimedEvent = Extract<SimEvent, { t: 'claimed' }>;

/** Below this cell size the key letter and dist numbers are not drawn. */
const MIN_LABEL_CELL = 24;
/** The neon frame sits this far outside the board edge (the goo exits onto it). */
export const FRAME_PAD = 10;
const MELT_POOL = 96;
const MELT_MS = 170;
/** Reachable mask refresh throttle. */
const REACH_MS = 180;
const TILE_TINT_SCALE = 0.86;

const BOARD_FRAG = `
precision mediump float;
uniform sampler2D uBoard;
uniform sampler2D uReach;
uniform float uTime;
uniform float uPulse;
varying vec2 outTexCoord;
void main(){
    vec2 uv = outTexCoord;
    vec4 b = texture2D(uBoard, uv);
    float reach = texture2D(uReach, uv).a;
    float band = uv.x * 0.75 + (1.0 - uv.y) * 0.55 - mod(uTime * 0.11, 2.4) + 0.35;
    float shimmer = exp(-band * band * 26.0) * 0.32;
    float sparkle = 0.04 * sin(uTime * 1.7 + uv.x * 23.0 + uv.y * 17.0);
    vec3 col = b.rgb * (1.0 + shimmer + sparkle + reach * uPulse * 0.55);
    gl_FragColor = vec4(col, b.a);
}
`;

interface Melt {
    tile: GameObjects.Image;
    flash: GameObjects.Image;
    life: number;
}

interface KeySprite {
    id: number;
    glow: GameObjects.Image;
    icon: GameObjects.Graphics;
    sparkle: GameObjects.Image;
    label: GameObjects.Text | null;
    phase: number;
}

let uid = 0;

export class BoardView {
    private readonly width: number;
    private readonly height: number;
    private readonly art: PaletteArt[];
    private readonly cell: number;
    private readonly rect: Rect;
    private readonly frame: Rect;
    private readonly tileKey: string;
    private readonly coreKey: string;
    private readonly boardKey: string;
    private readonly reachKey: string;
    private readonly ghostKey: string;
    private readonly boardTex: Textures.DynamicTexture;
    private readonly reachTex: Textures.DynamicTexture;
    private ghostTex: Textures.DynamicTexture | null = null;
    private readonly composite: GameObjects.Shader | GameObjects.Image;
    private readonly reachImage: GameObjects.Image | null = null;
    private readonly panelGfx: GameObjects.Graphics;
    private readonly frameGfx: GameObjects.Graphics;
    private readonly glyphGfx: GameObjects.Graphics;
    private ghost: GameObjects.Image | null = null;
    private scan: GameObjects.TileSprite | null = null;

    private cells: Uint8Array;
    private initialCells: Uint8Array | null = null;
    private keys: KeyView[] = [];
    private keySprites: KeySprite[] = [];
    /** Cells to clear in the texture on the next update. */
    private readonly cleared: number[] = [];
    private fullRedraw = true;
    private keysDirty = true;
    private reachDirty = true;
    private reachMs = REACH_MS;
    private activeColors = 0;
    private lastActiveColors = -1;
    private distProvider: ((color: number, x: number, y: number) => number) | null = null;
    private showDist = false;
    private distDirty = false;
    private showGlyphs = false;
    private readonly distTexts: GameObjects.Text[] = [];
    private readonly melts: Melt[] = [];
    private timeS = 0;
    private flareMs = 0;
    private flareTotal = 1;
    private frameHeat = 0;
    private holoMs = 0;
    private holoTotal = 1;

    constructor(
        private readonly scene: Scene,
        private readonly layout: Layout,
        palette: number[],
        width: number,
        height: number,
    ) {
        this.width = width;
        this.height = height;
        this.art = paletteArtFromNums(palette);
        this.cell = layout.board.cell;
        this.rect = layout.board.rect;
        this.frame = { x: this.rect.x - FRAME_PAD, y: this.rect.y - FRAME_PAD, w: this.rect.w + FRAME_PAD * 2, h: this.rect.h + FRAME_PAD * 2 };
        this.cells = new Uint8Array(width * height).fill(EMPTY);
        this.tileKey = ensureTileTexture(scene, this.cell);
        this.coreKey = ensureTileCoreTexture(scene, this.cell);
        const id = uid++;
        this.boardKey = `board-tex-${id}`;
        this.reachKey = `board-reach-${id}`;
        this.ghostKey = `board-ghost-${id}`;

        this.panelGfx = scene.add.graphics().setDepth(DEPTH.board - 0.5);
        this.drawPanel();
        this.boardTex = scene.textures.addDynamicTexture(this.boardKey, this.rect.w, this.rect.h)!;
        this.reachTex = scene.textures.addDynamicTexture(this.reachKey, this.rect.w, this.rect.h)!;
        const cx = this.rect.x + this.rect.w / 2;
        const cy = this.rect.y + this.rect.h / 2;
        if (scene.sys.renderer.type === 2) {
            this.composite = scene.add.shader(
                {
                    name: `flow-board-${id}`,
                    fragmentSource: BOARD_FRAG,
                    initialUniforms: { uTime: 0, uPulse: 0 },
                    setupUniforms: (setUniform: (name: string, value: unknown) => void) => {
                        setUniform('uBoard', 0);
                        setUniform('uReach', 1);
                        setUniform('uTime', this.timeS);
                        setUniform('uPulse', 0.5 + 0.5 * Math.sin(this.timeS * 4.2));
                    },
                },
                cx,
                cy,
                this.rect.w,
                this.rect.h,
                [this.boardKey, this.reachKey],
            );
        } else {
            this.composite = scene.add.image(cx, cy, this.boardKey);
            this.reachImage = scene.add.image(cx, cy, this.reachKey).setBlendMode(BlendModes.ADD).setAlpha(0.3);
        }
        this.composite.setDepth(DEPTH.board);
        this.glyphGfx = scene.add.graphics().setDepth(DEPTH.board + 0.15).setVisible(false);
        this.frameGfx = scene.add.graphics().setDepth(DEPTH.board + 0.05);
        this.drawFrame();
        for (let i = 0; i < MELT_POOL; i++) {
            const tile = scene.add.image(0, 0, this.tileKey).setDepth(DEPTH.board + 0.2).setVisible(false);
            const flash = scene.add.image(0, 0, TEX.glow).setDepth(DEPTH.board + 0.25).setBlendMode(BlendModes.ADD).setVisible(false);
            this.melts.push({ tile, flash, life: 0 });
        }
    }

    cellCenter(x: number, y: number): Point2 {
        return cellCenter(this.layout, x, y);
    }

    /** Center of the cell holding the (uncollected) key that unlocks `podId`, or null. */
    keyCenterFor(podId: number): Point2 | null {
        const k = this.keys.find((key) => key.podId === podId);
        return k ? this.cellCenter(k.x, k.y) : null;
    }

    /** The neon frame rectangle (goo rides along it). */
    frameRect(): Rect {
        return this.frame;
    }

    /** Refresh from the sim. Safe to call every frame; only redraws on change. */
    sync(s: ViewState): void {
        if (this.initialCells === null) this.initialCells = s.cells.slice();
        this.syncCells(s.cells);
        if (!sameKeys(this.keys, s.keys)) {
            this.keys = s.keys.map((k) => ({ ...k }));
            this.keysDirty = true;
        }
        this.syncLanes(s.lanes);
    }

    onClaimed(e: ClaimedEvent): void {
        const i = e.y * this.width + e.x;
        const color = this.cells[i]!;
        if (color === EMPTY) return;
        this.cells[i] = EMPTY;
        this.cleared.push(i);
        this.reachDirty = true;
        this.distDirty = true;
        this.startMelt(e.x, e.y, color);
    }

    /** `fn(color, x, y)` returns dist_c or -1 (unreachable). */
    setDistProvider(fn: ((color: number, x: number, y: number) => number) | null): void {
        this.distProvider = fn;
        this.distDirty = true;
        this.reachDirty = true;
    }

    setShowDist(on: boolean): void {
        this.showDist = on;
        this.distDirty = true;
    }

    /** Color-blind overlay: draw each color's glyph on its tiles (only where cells are big enough). */
    setOverlayGlyphs(on: boolean): void {
        this.showGlyphs = on;
        this.glyphGfx.setVisible(on);
        this.fullRedraw = true;
    }

    /** Whole frame flares white-hot, then cools (win). */
    flare(ms: number): void {
        this.flareMs = ms;
        this.flareTotal = ms;
    }

    /** Frame heats toward red (0..1), e.g. overload warning. */
    setFrameHeat(heat: number): void {
        if (Math.abs(heat - this.frameHeat) < 0.01) return;
        this.frameHeat = heat;
        this.drawFrame();
    }

    /** Ghost the original image back in as a flickering hologram for `ms`. */
    showHologram(ms: number): void {
        if (this.initialCells === null) return;
        if (!this.ghostTex) {
            this.ghostTex = this.scene.textures.addDynamicTexture(this.ghostKey, this.rect.w, this.rect.h);
            if (!this.ghostTex) return;
            this.stampAll(this.ghostTex, this.initialCells, 1);
            this.ghostTex.render();
            const cx = this.rect.x + this.rect.w / 2;
            const cy = this.rect.y + this.rect.h / 2;
            this.ghost = this.scene.add.image(cx, cy, this.ghostKey).setDepth(DEPTH.board + 0.4).setBlendMode(BlendModes.ADD).setAlpha(0);
            this.scan = this.scene.add
                .tileSprite(cx, cy, this.rect.w, this.rect.h, TEX.scan)
                .setDepth(DEPTH.board + 0.45)
                .setTint(0x0a0414)
                .setAlpha(0);
        }
        this.holoMs = ms;
        this.holoTotal = ms;
    }

    update(dtMs?: number): void {
        const dt = dtMs ?? this.scene.game.loop.delta;
        this.timeS += dt / 1000;
        this.renderTiles();
        if (this.keysDirty) {
            this.keysDirty = false;
            this.rebuildKeys();
        }
        this.animateKeys(dt);
        this.reachMs += dt;
        if (this.reachDirty && this.reachMs >= REACH_MS) this.renderReach();
        if (this.distDirty) {
            this.distDirty = false;
            this.drawDist();
        }
        this.tickMelts(dt);
        this.tickFlare(dt);
        this.tickHologram(dt);
    }

    destroy(): void {
        this.panelGfx.destroy();
        this.frameGfx.destroy();
        this.glyphGfx.destroy();
        this.composite.destroy();
        this.reachImage?.destroy();
        this.ghost?.destroy();
        this.scan?.destroy();
        for (const k of this.keySprites) destroyKey(k);
        this.keySprites = [];
        for (const m of this.melts) {
            m.tile.destroy();
            m.flash.destroy();
        }
        for (const t of this.distTexts) t.destroy();
        this.distTexts.length = 0;
        for (const key of [this.boardKey, this.reachKey, this.ghostKey]) {
            if (this.scene.textures.exists(key)) this.scene.textures.remove(key);
        }
    }

    // ------------------------------------------------------------------ cells

    private syncCells(next: Uint8Array): void {
        if (next.length !== this.cells.length) {
            this.cells = next.slice();
            this.fullRedraw = true;
            return;
        }
        let changed = false;
        for (let i = 0; i < next.length; i++) {
            const v = next[i]!;
            const was = this.cells[i]!;
            if (v === was) continue;
            changed = true;
            this.cells[i] = v;
            if (v === EMPTY) this.cleared.push(i);
            else this.fullRedraw = true;
        }
        if (changed) {
            this.reachDirty = true;
            this.distDirty = true;
        }
    }

    private syncLanes(lanes: (LaneState | null)[]): void {
        let mask = 0;
        for (const l of lanes) {
            if (l === null || l.state !== 'draining') continue;
            mask |= 1 << l.color;
        }
        this.activeColors = mask;
        if (mask !== this.lastActiveColors) this.reachDirty = true;
    }

    private renderTiles(): void {
        const tex = this.boardTex;
        if (this.fullRedraw) {
            this.fullRedraw = false;
            this.cleared.length = 0;
            tex.clear();
            this.stampAll(tex, this.cells, TILE_TINT_SCALE);
            tex.render();
            this.drawGlyphOverlay();
            return;
        }
        if (this.cleared.length === 0) return;
        const c = this.cell;
        for (const i of this.cleared) {
            const x = i % this.width;
            const y = (i - x) / this.width;
            tex.clear(x * c, y * c, c, c);
        }
        this.cleared.length = 0;
        tex.render();
        if (this.showGlyphs) this.drawGlyphOverlay();
    }

    private stampAll(tex: Textures.DynamicTexture, cells: Uint8Array, tintScale: number): void {
        const c = this.cell;
        const coreAlpha = c >= 12 ? 0.42 : 0.3;
        for (let y = 0; y < this.height; y++) {
            const row = y * this.width;
            for (let x = 0; x < this.width; x++) {
                const v = cells[row + x]!;
                if (v === EMPTY) continue;
                const art = this.art[v];
                if (!art) continue;
                const tint = tintScale === 1 ? art.core : mixColor(0x000000, art.core, tintScale);
                tex.stamp(this.tileKey, undefined, x * c, y * c, { tint, originX: 0, originY: 0 });
                tex.stamp(this.coreKey, undefined, x * c, y * c, { tint: art.glow, originX: 0, originY: 0, alpha: coreAlpha, blendMode: BlendModes.ADD });
            }
        }
    }

    private renderReach(): void {
        this.reachDirty = false;
        this.reachMs = 0;
        const tex = this.reachTex;
        tex.clear();
        this.lastActiveColors = this.activeColors;
        const provider = this.distProvider;
        if (this.activeColors !== 0 && provider !== null) {
            const c = this.cell;
            for (let y = 0; y < this.height; y++) {
                const row = y * this.width;
                for (let x = 0; x < this.width; x++) {
                    const v = this.cells[row + x]!;
                    if (v === EMPTY || (this.activeColors & (1 << v)) === 0) continue;
                    if (provider(v, x, y) < 0) continue;
                    tex.stamp(this.tileKey, undefined, x * c, y * c, { originX: 0, originY: 0 });
                }
            }
        }
        tex.render();
        if (this.reachImage) this.reachImage.setAlpha(0.25);
    }

    private drawGlyphOverlay(): void {
        const g = this.glyphGfx;
        g.clear();
        if (!this.showGlyphs || this.cell < 14) return;
        const r = this.cell * 0.26;
        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                const v = this.cells[y * this.width + x]!;
                if (v === EMPTY) continue;
                const art = this.art[v];
                if (!art) continue;
                const p = this.cellCenter(x, y);
                drawGlyph(g, art.glyph, p.x, p.y, r, art.deep, 0.85);
            }
        }
    }

    // ------------------------------------------------------------------ melt

    private startMelt(x: number, y: number, color: number): void {
        const art = this.art[color];
        if (!art) return;
        const m = this.melts.find((candidate) => candidate.life <= 0);
        if (!m) return;
        const p = this.cellCenter(x, y);
        m.life = MELT_MS;
        m.tile.setPosition(p.x, p.y).setTint(art.core).setScale(1).setAlpha(1).setVisible(true);
        m.flash.setPosition(p.x, p.y).setTint(art.glow).setScale((this.cell * 1.2) / 64).setAlpha(0.65).setVisible(true);
    }

    private tickMelts(dt: number): void {
        for (const m of this.melts) {
            if (m.life <= 0) continue;
            m.life -= dt;
            if (m.life <= 0) {
                m.tile.setVisible(false);
                m.flash.setVisible(false);
                continue;
            }
            const t = 1 - m.life / MELT_MS;
            m.tile.setScale(1 + 0.35 * t, 1 - 0.8 * t).setAlpha(1 - t);
            m.flash.setScale((this.cell * (1.2 + 1.6 * t)) / 64).setAlpha(0.65 * (1 - t));
        }
    }

    // ------------------------------------------------------------------ keys

    private rebuildKeys(): void {
        const keep = new Set(this.keys.map((k) => k.id));
        this.keySprites = this.keySprites.filter((k) => {
            if (keep.has(k.id)) return true;
            destroyKey(k);
            return false;
        });
        for (const k of this.keys) {
            if (this.keySprites.some((s) => s.id === k.id)) continue;
            this.keySprites.push(this.makeKey(k));
        }
    }

    private makeKey(k: KeyView): KeySprite {
        const c = this.cellCenter(k.x, k.y);
        const size = Math.max(12, this.cell);
        const labels = this.cell >= MIN_LABEL_CELL;
        const color = this.cells[k.y * this.width + k.x]!;
        const art = color === EMPTY ? undefined : this.art[color];
        const core = art?.core ?? COLORS.key;
        const glowColor = art?.glow ?? COLORS.key;
        const glow = this.scene.add.image(c.x, c.y, TEX.glow).setBlendMode(BlendModes.ADD).setTint(glowColor).setScale((size * 1.6) / 64).setAlpha(0.6).setDepth(DEPTH.board + 0.3);
        const icon = this.scene.add.graphics().setDepth(DEPTH.board + 0.32);
        icon.fillStyle(0x07041a, 0.8);
        icon.fillCircle(c.x, c.y, size * 0.46);
        icon.lineStyle(Math.max(1.5, size * 0.06), core, 0.95);
        icon.strokeCircle(c.x, c.y, size * 0.46);
        drawCrystalKey(icon, c.x, c.y - (labels ? size * 0.08 : 0), size * 0.62, glowColor);
        const sparkle = this.scene.add.image(c.x + size * 0.3, c.y - size * 0.3, TEX.star4).setBlendMode(BlendModes.ADD).setTint(0xffffff).setScale((size * 0.7) / 48).setDepth(DEPTH.board + 0.34);
        let label: GameObjects.Text | null = null;
        if (labels) {
            label = ui(this.scene.add.text(c.x, c.y + size * 0.27, keyLetter(k.id), { ...font(Math.max(10, size * 0.26), '#ffffff'), stroke: '#05030c', strokeThickness: 3 }).setOrigin(0.5).setDepth(DEPTH.board + 0.36));
        }
        return { id: k.id, glow, icon, sparkle, label, phase: Math.random() * Math.PI * 2 };
    }

    private animateKeys(dt: number): void {
        if (this.keySprites.length === 0) return;
        const size = Math.max(12, this.cell);
        for (const k of this.keySprites) {
            k.phase += dt / 1000;
            k.sparkle.setRotation(k.phase * 1.6);
            const tw = 0.5 + 0.5 * Math.sin(k.phase * 3.1);
            k.sparkle.setScale(((size * (0.45 + 0.45 * tw)) / 48)).setAlpha(0.5 + 0.5 * tw);
            k.glow.setAlpha(0.45 + 0.25 * Math.sin(k.phase * 2.3));
        }
    }

    // ------------------------------------------------------------------ panel, frame, flare, hologram

    private drawPanel(): void {
        const g = this.panelGfx;
        const f = this.frame;
        g.clear();
        g.fillStyle(0x07041a, 0.72);
        g.fillRoundedRect(f.x, f.y, f.w, f.h, 10);
    }

    private drawFrame(boost = 0): void {
        const g = this.frameGfx;
        const f = this.frame;
        const base = mixColor(COLORS.frame, COLORS.frameHot, this.frameHeat);
        const color = mixColor(base, 0xffffff, boost * 0.7);
        g.clear();
        g.lineStyle(6 + boost * 10, color, 0.1 + boost * 0.25);
        g.strokeRoundedRect(f.x, f.y, f.w, f.h, 10);
        g.lineStyle(3 + boost * 3, color, 0.28 + boost * 0.4);
        g.strokeRoundedRect(f.x, f.y, f.w, f.h, 10);
        g.lineStyle(1.25 + boost, mixColor(color, 0xffffff, 0.5), 0.85);
        g.strokeRoundedRect(f.x, f.y, f.w, f.h, 10);
        // Corner brackets.
        const L = 18;
        g.lineStyle(2.5, mixColor(color, 0xffffff, 0.35), 0.95);
        for (const [x, y, sx, sy] of [
            [f.x, f.y, 1, 1],
            [f.x + f.w, f.y, -1, 1],
            [f.x, f.y + f.h, 1, -1],
            [f.x + f.w, f.y + f.h, -1, -1],
        ] as const) {
            g.lineBetween(x - sx * 4, y + sy * L, x - sx * 4, y - sy * 4);
            g.lineBetween(x - sx * 4, y - sy * 4, x + sx * L, y - sy * 4);
        }
    }

    private tickFlare(dt: number): void {
        if (this.flareMs <= 0) return;
        this.flareMs -= dt;
        const t = Math.max(0, this.flareMs / this.flareTotal);
        this.drawFrame(t);
    }

    private tickHologram(dt: number): void {
        if (this.holoMs <= 0 || !this.ghost || !this.scan) return;
        this.holoMs -= dt;
        if (this.holoMs <= 0) {
            this.ghost.setAlpha(0);
            this.scan.setAlpha(0);
            return;
        }
        const t = 1 - this.holoMs / this.holoTotal;
        const env = t < 0.2 ? t / 0.2 : t > 0.75 ? (1 - t) / 0.25 : 1;
        const flicker = Math.random() < 0.08 ? 0.35 : 1;
        this.ghost.setAlpha(0.6 * env * flicker).setX(this.rect.x + this.rect.w / 2 + (Math.random() < 0.05 ? (Math.random() - 0.5) * 8 : 0));
        this.scan.setAlpha(0.55 * env);
        this.scan.tilePositionY -= dt * 0.03;
    }

    // ------------------------------------------------------------------ dev overlay

    private drawDist(): void {
        const { cell } = this.layout.board;
        let used = 0;
        const provider = this.distProvider;
        if (this.showDist && provider !== null && cell >= MIN_LABEL_CELL * 0.6) {
            for (let y = 0; y < this.height; y++) {
                for (let x = 0; x < this.width; x++) {
                    const color = this.cells[y * this.width + x]!;
                    if (color === EMPTY) continue;
                    const d = provider(color, x, y);
                    const c = this.cellCenter(x, y);
                    const t = this.distTexts[used] ?? this.makeDistText(used, Math.max(9, Math.floor(cell * 0.38)));
                    t.setText(d < 0 ? 'x' : String(d)).setPosition(c.x, c.y - cell * 0.12).setVisible(true);
                    used++;
                }
            }
        }
        for (let i = used; i < this.distTexts.length; i++) this.distTexts[i]!.setVisible(false);
    }

    private makeDistText(index: number, size: number): GameObjects.Text {
        const t = ui(this.scene.add.text(0, 0, '', font(size, COLORS.darkText)).setOrigin(0.5).setDepth(DEPTH.board + 0.3));
        this.distTexts[index] = t;
        return t;
    }
}

/** A faceted crystal key in `color`, width `size`. */
function drawCrystalKey(g: GameObjects.Graphics, cx: number, cy: number, size: number, color: number): void {
    const r = size * 0.24;
    const bx = cx - size * 0.24;
    const shaft = Math.max(2, size * 0.13);
    g.fillStyle(color, 1);
    // Diamond bow.
    g.fillTriangle(bx - r, cy, bx, cy - r, bx + r, cy);
    g.fillTriangle(bx - r, cy, bx, cy + r, bx + r, cy);
    g.fillRect(bx + r * 0.6, cy - shaft / 2, size * 0.62, shaft);
    g.fillRect(cx + size * 0.26, cy, shaft, size * 0.2);
    g.fillRect(cx + size * 0.1, cy, shaft, size * 0.14);
    g.fillStyle(0xffffff, 0.85);
    g.fillTriangle(bx - r * 0.45, cy, bx, cy - r * 0.45, bx, cy);
}

function destroyKey(k: KeySprite): void {
    k.glow.destroy();
    k.icon.destroy();
    k.sparkle.destroy();
    k.label?.destroy();
}

function sameKeys(a: KeyView[], b: KeyView[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i]!.id !== b[i]!.id) return false;
    return true;
}
