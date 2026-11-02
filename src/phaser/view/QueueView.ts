/**
 * QueueView (neon): per column the front pod plus the next 3 as glass capsules (deep body, colored rim light,
 * color-blind glyph, crisp capacity number on the UI camera), a "+n" badge for deeper pods, glitching "?" for
 * hidden pods, a hex-lock with chains of light for locked pods, crackling lightning tethers for linked pairs,
 * and a slide-up tween when a pod leaves. Tapping anywhere in a column strip taps its front pod (a Zone per column),
 * except pressing a locked pod: that holds it (`onLockHold(podId)` until release, `onLockHold(null)`) so the scene can
 * point at its key. A locked front pod is also tapped (the denial feedback still plays).
 *
 * Positions are derived from the snapshot (`sync`), so the view cannot drift; events only add flourishes.
 * Unlocks wait for the key flight: `holdLock(podId)` keeps the lock drawn until `releaseLock(podId)` shatters it.
 *
 * Public interface (kept from the gray box):
 *   constructor(scene, layout, palette, { onColumnTap, onLockHold?, fx? })
 *   sync(columns)                 full refresh from `ViewState.columns`
 *   onTapped(podIds, laneCenters) the pods launch on an arc to their lane slots
 *   onUnlocked(podId)             lock shatters + reveal (deferred while a key is flying to it)
 *   shake(column)                 denied tap: red-shifted wobble
 *   podCenter(podId)              logical center of a pod (key flights aim here), or null
 *   setHint(column | null)        highlight a column (debug hint)
 *   setInputEnabled(on)
 *   flyingCount                   > 0 while tapped pods are still flying
 *   update(timeMs)                per frame (tethers, glitch, hint pulse)
 *   destroy()
 * Added: holdLock(podId), releaseLock(podId), onRevealed(podId), crackAll().
 */
import { BlendModes } from 'phaser';
import type { GameObjects, Scene } from 'phaser';
import type { Layout, Point2 } from '@game/layout';
import { VISIBLE_PODS, podSlot } from '@game/layout';
import type { PodState } from '@game/types';
import { COLORS, DEPTH, font, keyLetter, paletteArtFromNums } from '../theme';
import type { PaletteArt } from '../theme';
import { both, ui } from '../fx/CameraRig';
import type { Fx } from '../fx/Fx';
import { TEX } from '../fx/textures';
import { capsuleRadius, drawColorPod, drawHiddenPod, drawLightning, drawLinkRings, drawLockedPod } from './podArt';

export interface QueueViewOptions {
    onColumnTap: (column: number) => void;
    /** A locked pod is pressed (its id) or released (null). */
    onLockHold?: (podId: number | null) => void;
    fx?: Fx;
}

interface PodView {
    id: number;
    /** Positioned and scaled by slot tweens. */
    root: GameObjects.Container;
    /** Child that shakes / pops. */
    face: GameObjects.Container;
    glow: GameObjects.Image;
    gfx: GameObjects.Graphics;
    /** Animated overlay (glitch bars, lock chains, deny tint). */
    overlay: GameObjects.Graphics;
    /** Crisp UI-camera texts (count, caption). UI text always draws above game art, so it is hidden while the pod moves. */
    texts: GameObjects.Container;
    label: GameObjects.Text;
    sub: GameObjects.Text;
    column: number;
    index: number;
    /** Cache key of the drawn state. */
    key: string;
    hidden: boolean;
    locked: boolean;
    /** Drawn as locked until the key lands. */
    lockHeld: boolean;
    link: number | null;
    color: number | null;
    deny: number;
    overlayDirty: boolean;
    /** Last key id seen for this pod's lock (the sim clears it on unlock, before the key lands). */
    lockId: number | null;
}

const TWEEN_MS = 220;
const FLY_MS = 300;
const GLITCH_MS = 70;
/** Tween progress after which a sliding pod's texts start to fade in. */
const SLIDE_TEXT_FROM = 0.6;

export class QueueView {
    private readonly pods = new Map<number, PodView>();
    private readonly loc = new Map<number, { column: number; index: number }>();
    private readonly badges: GameObjects.Text[] = [];
    private readonly zones: GameObjects.Zone[] = [];
    private readonly slotGfx: GameObjects.Graphics;
    private readonly linkGfx: GameObjects.Graphics;
    private readonly hintGfx: GameObjects.Graphics;
    private readonly art: PaletteArt[];
    private readonly fx: Fx | null;
    private readonly held = new Set<number>();
    /** Pods revealed since the last frame (burst plays once the snapshot has their color). */
    private readonly pending = new Set<number>();
    /** Last applied state per pod (for redraws that do not come from a sync). */
    private readonly lastState = new Map<number, PodState>();
    private hint: number | null = null;
    private flying = 0;
    private hasLinks = false;
    private synced = false;
    private linkMs = 0;
    private glitchMs = 0;
    private lastTime = 0;
    private holding: number | null = null;
    private readonly onRelease = () => this.release();

    constructor(
        private readonly scene: Scene,
        private readonly layout: Layout,
        palette: number[],
        private readonly opts: QueueViewOptions,
    ) {
        this.art = paletteArtFromNums(palette);
        this.fx = opts.fx ?? null;
        const q = layout.queue;
        this.slotGfx = scene.add.graphics().setDepth(DEPTH.queue - 1);
        this.linkGfx = scene.add.graphics().setDepth(DEPTH.queue + 1).setBlendMode(BlendModes.ADD);
        this.hintGfx = scene.add.graphics().setDepth(DEPTH.queue + 2);
        q.centers.forEach((cx, col) => {
            this.drawEmptySlot(col);
            const r = q.hitRects[col]!;
            const zone = scene.add.zone(r.x + r.w / 2, r.y + r.h / 2, r.w, r.h).setDepth(DEPTH.queue + 3);
            zone.setInteractive({ useHandCursor: true });
            zone.on('pointerdown', (_p: unknown, _lx: number, localY: number) => this.press(col, r.y + localY));
            this.zones.push(zone);
            this.badges.push(ui(scene.add.text(cx, q.badgeY, '', font(22, COLORS.dim)).setOrigin(0.5).setDepth(DEPTH.queue)));
        });
        scene.input.on('pointerup', this.onRelease);
        scene.input.on('pointerupoutside', this.onRelease);
    }

    get flyingCount(): number {
        return this.flying;
    }

    /** Enable or disable the column tap zones (overlays do this too, by blocking input above). */
    setInputEnabled(enabled: boolean): void {
        if (!enabled) this.release();
        for (const z of this.zones) {
            if (enabled) z.setInteractive({ useHandCursor: true });
            else z.disableInteractive();
        }
    }

    sync(columns: PodState[][]): void {
        const seen = new Set<number>();
        this.loc.clear();
        let links = false;
        columns.forEach((pods, column) => {
            pods.forEach((p, index) => {
                this.loc.set(p.id, { column, index });
                if (p.link !== null) links = true;
                if (index >= VISIBLE_PODS) return;
                seen.add(p.id);
                this.place(p, column, index);
            });
        });
        // A badge turns cyan when it hides the partner of a visible linked pod (its off-screen tether ends there).
        const tethered = new Set<number>();
        for (const pv of this.pods.values()) {
            if (!seen.has(pv.id) || pv.link === null) continue;
            const partner = this.loc.get(pv.link);
            if (partner && partner.index >= VISIBLE_PODS) tethered.add(partner.column);
        }
        columns.forEach((pods, column) => {
            const extra = pods.length - VISIBLE_PODS;
            this.badges[column]?.setText(extra > 0 ? `+${extra}` : '').setColor(tethered.has(column) ? '#9ff3ff' : COLORS.dim);
        });
        this.hasLinks = links;
        this.synced = true;
        for (const [id, pv] of this.pods) {
            if (seen.has(id)) continue;
            this.destroyPod(pv);
            this.pods.delete(id);
        }
    }

    /** The pods in `podIds` leave their columns and launch on an arc to `laneCenters[i]` (parallel arrays). */
    onTapped(podIds: number[], laneCenters: Point2[], onLanded?: (index: number) => void): void {
        podIds.forEach((id, i) => {
            const pv = this.pods.get(id);
            const to = laneCenters[i];
            if (!to) return;
            if (!pv) {
                onLanded?.(i);
                return;
            }
            this.pods.delete(id);
            this.held.delete(id);
            this.scene.tweens.killTweensOf(pv.root);
            pv.root.setDepth(DEPTH.goo + 1);
            this.flying++;
            pv.texts.setVisible(false);
            const fromX = pv.root.x;
            const fromY = pv.root.y;
            const ctrlX = (fromX + to.x) / 2;
            const ctrlY = Math.min(fromY, to.y) - 70;
            const color = pv.color !== null ? (this.art[pv.color]?.glow ?? 0xffffff) : 0xffffff;
            const fx = this.fx;
            fx?.flash(fromX, fromY, color, 120, 200, 0.7);
            const state = { t: 0 };
            this.scene.tweens.add({
                targets: state,
                t: 1,
                duration: FLY_MS,
                ease: 'Cubic.easeIn',
                onUpdate: () => {
                    const t = state.t;
                    const u = 1 - t;
                    const x = u * u * fromX + 2 * u * t * ctrlX + t * t * to.x;
                    const y = u * u * fromY + 2 * u * t * ctrlY + t * t * to.y;
                    pv.root.setPosition(x, y).setScale(1 - 0.45 * t).setAlpha(1 - 0.6 * t);
                    if (fx && Math.random() < 0.7) fx.burst(x, y, color, { count: 1, speedMin: 10, speedMax: 60, scale: 0.6, life: 260 });
                },
                onComplete: () => {
                    this.flying--;
                    onLanded?.(i);
                    fx?.flash(to.x, to.y, color, 170, 240, 0.9);
                    this.destroyPod(pv);
                },
            });
        });
    }

    /** A key is flying to this pod: keep drawing its lock until `releaseLock`. */
    holdLock(podId: number): void {
        this.held.add(podId);
        const pv = this.pods.get(podId);
        if (pv) pv.lockHeld = true;
    }

    /** The key landed: shatter the lock and reveal the pod. */
    releaseLock(podId: number): void {
        this.held.delete(podId);
        const pv = this.pods.get(podId);
        if (!pv) return;
        pv.lockHeld = false;
        pv.key = '';
        const p = { x: pv.root.x, y: pv.root.y };
        this.fx?.shatter(p.x, p.y, COLORS.key, 22, 340, 0.9);
        this.fx?.flash(p.x, p.y, COLORS.key, 200, 300);
        this.fx?.ring(p.x, p.y, COLORS.key, 110, 380);
        this.redraw(pv);
        this.pop(pv);
    }

    onUnlocked(podId: number): void {
        const pv = this.pods.get(podId);
        if (!pv || this.held.has(podId)) return;
        this.pop(pv);
    }

    /** Hidden pod revealed: glitch burst into its color. */
    onRevealed(podId: number): void {
        const pv = this.pods.get(podId);
        if (!pv) return;
        this.pending.add(podId);
    }

    shake(column: number): void {
        const front = this.frontPod(column);
        if (!front) return;
        const face = front.face;
        this.scene.tweens.killTweensOf(face);
        face.setX(0).setAngle(0);
        front.deny = 1;
        this.scene.tweens.add({
            targets: face,
            x: { from: -9, to: 9 },
            angle: { from: -3, to: 3 },
            duration: 45,
            yoyo: true,
            repeat: 3,
            ease: 'Sine.easeInOut',
            onComplete: () => face.setX(0).setAngle(0),
        });
    }

    /** Overload: the front pods crack. */
    crackAll(): void {
        if (!this.fx) return;
        for (const pv of this.pods.values()) {
            if (pv.index !== 0) continue;
            const color = pv.color !== null ? (this.art[pv.color]?.core ?? 0xff3b5c) : 0x8890c0;
            this.fx.shatter(pv.root.x, pv.root.y, color, 12, 300, 0.8);
            pv.deny = 1.5;
        }
    }

    podCenter(podId: number): Point2 | null {
        const pv = this.pods.get(podId);
        if (pv) return { x: pv.root.x, y: pv.root.y };
        const l = this.loc.get(podId);
        if (!l) return null;
        const s = podSlot(this.layout, l.column, l.index);
        return { x: s.x, y: s.y };
    }

    setHint(column: number | null): void {
        this.hint = column;
        if (column === null) this.hintGfx.clear();
    }

    /** Per frame: tethers crackle, hidden pods glitch, denied pods cool down, the hint pulses. */
    update(timeMs: number): void {
        const dt = this.lastTime === 0 ? 16 : Math.min(50, timeMs - this.lastTime);
        this.lastTime = timeMs;
        this.linkMs += dt;
        if (this.linkMs >= 55) {
            this.linkMs = 0;
            this.drawLinks();
        }
        this.glitchMs += dt;
        const glitch = this.glitchMs >= GLITCH_MS;
        if (glitch) this.glitchMs = 0;
        for (const pv of this.pods.values()) this.tickPod(pv, dt, timeMs, glitch);
        this.flushReveals();
        this.drawHint(timeMs);
    }

    destroy(): void {
        this.scene.input.off('pointerup', this.onRelease);
        this.scene.input.off('pointerupoutside', this.onRelease);
        for (const pv of this.pods.values()) this.destroyPod(pv);
        this.pods.clear();
        for (const z of this.zones) z.destroy();
        for (const b of this.badges) b.destroy();
        this.slotGfx.destroy();
        this.linkGfx.destroy();
        this.hintGfx.destroy();
    }

    // ------------------------------------------------------------------ internals

    /** Press at layout-space `y` in `column`: hold a locked pod, else tap the column. */
    private press(column: number, y: number): void {
        const pv = this.podAt(column, y);
        if (!pv || !pv.locked || pv.hidden) {
            this.opts.onColumnTap(column);
            return;
        }
        this.holding = pv.id;
        this.opts.onLockHold?.(pv.id);
        if (pv.index === 0) this.opts.onColumnTap(column);
    }

    private release(): void {
        if (this.holding === null) return;
        this.holding = null;
        this.opts.onLockHold?.(null);
    }

    /** The visible pod in `column` whose slot contains layout-space `y`, or null. */
    private podAt(column: number, y: number): PodView | null {
        const half = this.layout.queue.podH / 2;
        for (const pv of this.pods.values()) {
            if (pv.column !== column) continue;
            const s = podSlot(this.layout, column, pv.index);
            if (Math.abs(y - s.y) <= half * s.scale) return pv;
        }
        return null;
    }

    private flushReveals(): void {
        if (this.pending.size === 0) return;
        for (const id of this.pending) {
            const pv = this.pods.get(id);
            if (!pv || pv.hidden || pv.color === null) continue;
            const art = this.art[pv.color];
            const color = art?.core ?? 0xffffff;
            this.fx?.flash(pv.root.x, pv.root.y, art?.glow ?? 0xffffff, 190, 260);
            this.fx?.burst(pv.root.x, pv.root.y, color, { count: 26, speedMin: 80, speedMax: 300, scale: 0.55, life: 520 });
            this.fx?.burst(pv.root.x, pv.root.y, 0x22e6ff, { count: 8, speedMin: 200, speedMax: 420, angleMin: -10, angleMax: 10, scale: 0.4, life: 260 });
            this.fx?.burst(pv.root.x, pv.root.y, 0xff2bd6, { count: 8, speedMin: 200, speedMax: 420, angleMin: 170, angleMax: 190, scale: 0.4, life: 260 });
            this.pop(pv);
        }
        this.pending.clear();
    }

    private frontPod(column: number): PodView | null {
        for (const pv of this.pods.values()) if (pv.column === column && pv.index === 0) return pv;
        return null;
    }

    private place(p: PodState, column: number, index: number): void {
        let pv = this.pods.get(p.id);
        const slot = podSlot(this.layout, column, index);
        if (!pv) {
            pv = this.createPod(p);
            if (this.held.has(p.id)) pv.lockHeld = true;
            // New pods appear from below the last slot (slide up into view). The very first sync places them directly.
            const from = podSlot(this.layout, column, VISIBLE_PODS);
            const direct = !this.synced;
            if (direct) {
                pv.root.setPosition(slot.x, slot.y).setScale(slot.scale);
            } else {
                pv.root.setPosition(from.x, from.y).setScale(from.scale).setAlpha(0);
            }
            pv.column = column;
            pv.index = index;
            this.pods.set(p.id, pv);
            this.applyState(pv, p, false);
            if (!direct) this.slideTo(pv, slot);
            return;
        }
        const wasFront = pv.index === 0;
        this.applyState(pv, p, true);
        const moved = pv.column !== column || pv.index !== index;
        pv.column = column;
        pv.index = index;
        if (moved) this.slideTo(pv, slot);
        if (wasFront !== (index === 0)) this.redraw(pv);
    }

    /**
     * Slide a pod into its slot. Its texts are UI-camera objects (they draw above every game-camera object), so while
     * the pod travels they stay hidden and only fade in over the last part of the slide, once the pod has cleared the
     * neighbors and any pod that is flying away.
     */
    private slideTo(pv: PodView, slot: Point2 & { scale: number }): void {
        this.scene.tweens.killTweensOf(pv.root);
        pv.texts.setAlpha(0);
        this.scene.tweens.add({
            targets: pv.root,
            x: slot.x,
            y: slot.y,
            scale: slot.scale,
            alpha: 1,
            duration: TWEEN_MS,
            ease: 'Cubic.easeOut',
            onUpdate: (tween) => pv.texts.setAlpha(Math.max(0, Math.min(1, (tween.progress - SLIDE_TEXT_FROM) / (1 - SLIDE_TEXT_FROM)))),
            onComplete: () => pv.texts.setAlpha(1),
        });
    }

    private createPod(p: PodState): PodView {
        const { podW: w, podH: h } = this.layout.queue;
        const root = both(this.scene.add.container(0, 0).setDepth(DEPTH.queue));
        const face = both(this.scene.add.container(0, 0));
        const glow = this.scene.add.image(0, 0, TEX.glow).setBlendMode(BlendModes.ADD).setDisplaySize(w * 1.5, h * 1.4).setAlpha(0);
        const gfx = this.scene.add.graphics();
        const overlay = this.scene.add.graphics();
        const label = ui(this.scene.add.text(0, 2, '', { ...font(40), stroke: '#05030c', strokeThickness: 6 }).setOrigin(0.5));
        const sub = ui(this.scene.add.text(0, h / 2 - 16, '', { ...font(14, COLORS.text), stroke: '#05030c', strokeThickness: 4 }).setOrigin(0.5));
        const texts = both(this.scene.add.container(0, 0));
        texts.add([label, sub]);
        face.add([glow, gfx, overlay, texts]);
        root.add(face);
        return {
            id: p.id,
            root,
            face,
            glow,
            gfx,
            overlay,
            texts,
            label,
            sub,
            column: 0,
            index: 0,
            key: '',
            hidden: p.hidden,
            locked: p.locked,
            lockHeld: false,
            link: p.link,
            color: p.color,
            deny: 0,
            overlayDirty: false,
            lockId: p.lock,
        };
    }

    private destroyPod(pv: PodView): void {
        this.scene.tweens.killTweensOf(pv.root);
        this.scene.tweens.killTweensOf(pv.face);
        pv.root.destroy();
    }

    private applyState(pv: PodView, p: PodState, animate: boolean): void {
        const key = `${p.hidden}|${p.locked}|${p.color}|${p.capacity}|${p.lock}|${p.link}|${pv.lockHeld}`;
        if (pv.key === key) return;
        const wasHidden = pv.hidden;
        const wasLocked = pv.locked;
        pv.key = key;
        pv.hidden = p.hidden;
        pv.locked = p.locked;
        pv.link = p.link;
        pv.color = p.color;
        this.lastState.set(pv.id, p);
        this.drawPod(pv, p);
        if (!animate) return;
        if (wasHidden && !p.hidden) this.pending.add(pv.id);
        else if (wasLocked && !p.locked && !pv.lockHeld) this.pop(pv);
    }

    private redraw(pv: PodView): void {
        const p = this.lastState.get(pv.id);
        if (!p) return;
        pv.key = `${p.hidden}|${p.locked}|${p.color}|${p.capacity}|${p.lock}|${p.link}|${pv.lockHeld}`;
        this.drawPod(pv, p);
    }

    private drawPod(pv: PodView, p: PodState): void {
        const { podW: w, podH: h } = this.layout.queue;
        const g = pv.gfx;
        g.clear();
        pv.overlay.clear();
        pv.sub.setText('');
        const showLocked = p.locked || pv.lockHeld;
        const front = pv.index === 0;
        if (p.lock !== null) pv.lockId = p.lock;
        if (p.hidden) {
            drawHiddenPod(g, w, h);
            pv.label.setText('?').setColor('#b9a8ff');
            pv.glow.setTint(0x6a5cff);
        } else if (showLocked) {
            drawLockedPod(g, w, h);
            pv.label.setText('');
            pv.sub.setText(pv.lockId !== null ? `KEY ${keyLetter(pv.lockId)}` : 'LOCKED').setColor('#ffe600');
            pv.glow.setTint(COLORS.key);
        } else {
            const art = p.color !== null ? this.art[p.color] : undefined;
            drawColorPod(g, w, h, art, front);
            pv.label.setText(String(p.capacity ?? '')).setColor('#ffffff');
            pv.glow.setTint(art?.glow ?? 0xffffff);
        }
        pv.glow.setAlpha(front && !p.hidden ? 0.28 : 0);
        if (p.link !== null) drawLinkRings(g, w / 2 - 18, -h / 2 + 16, 20, 0xe8f6ff);
    }

    private tickPod(pv: PodView, dt: number, timeMs: number, glitch: boolean): void {
        const { podW: w, podH: h } = this.layout.queue;
        const o = pv.overlay;
        const showLocked = (pv.locked || pv.lockHeld) && !pv.hidden;
        const denying = pv.deny > 0;
        if (denying) pv.deny = Math.max(0, pv.deny - dt / 450);
        if (!pv.hidden && !showLocked && !denying) {
            if (pv.overlayDirty) o.clear();
            pv.overlayDirty = false;
            return;
        }
        if (pv.hidden && !glitch && !denying) return;
        o.clear();
        pv.overlayDirty = true;
        if (pv.hidden) this.drawGlitch(pv, w, h, timeMs);
        if (showLocked) this.drawChains(o, w, h, timeMs);
        if (pv.deny > 0) {
            o.fillStyle(0xff1840, 0.35 * pv.deny);
            o.fillRoundedRect(-w / 2, -h / 2, w, h, capsuleRadius(w, h));
            o.lineStyle(3, 0xff2950, pv.deny);
            o.strokeRoundedRect(-w / 2 - 3, -h / 2 + 2, w, h, capsuleRadius(w, h));
            o.lineStyle(3, 0x22e6ff, pv.deny * 0.6);
            o.strokeRoundedRect(-w / 2 + 3, -h / 2 - 2, w, h, capsuleRadius(w, h));
        }
    }

    private drawGlitch(pv: PodView, w: number, h: number, timeMs: number): void {
        const o = pv.overlay;
        const bars = 3 + Math.floor(Math.random() * 4);
        for (let i = 0; i < bars; i++) {
            const y = -h / 2 + 8 + Math.random() * (h - 16);
            const bw = w * (0.2 + Math.random() * 0.6);
            const x = -w / 2 + 6 + Math.random() * (w - 12 - bw);
            const c = Math.random() < 0.5 ? 0x6a5cff : Math.random() < 0.5 ? 0x22e6ff : 0xff2bd6;
            o.fillStyle(c, 0.15 + Math.random() * 0.35);
            o.fillRect(x, y, bw, 1 + Math.random() * 3);
        }
        const jitter = Math.random() < 0.25;
        pv.label.setX(jitter ? (Math.random() - 0.5) * 6 : 0).setAlpha(Math.random() < 0.12 ? 0.25 : 0.75 + 0.25 * Math.sin(timeMs / 90));
    }

    private drawChains(o: GameObjects.Graphics, w: number, h: number, timeMs: number): void {
        const pulse = 0.35 + 0.3 * Math.sin(timeMs / 220);
        o.lineStyle(1.5, COLORS.key, pulse);
        const inset = 8;
        o.lineBetween(-w / 2 + inset, -h / 2 + inset, w / 2 - inset, h / 2 - inset);
        o.lineBetween(w / 2 - inset, -h / 2 + inset, -w / 2 + inset, h / 2 - inset);
        // A bead of light running along each chain.
        const t = (timeMs / 900) % 1;
        o.fillStyle(0xfff7b0, 0.9);
        o.fillCircle(-w / 2 + inset + (w - inset * 2) * t, -h / 2 + inset + (h - inset * 2) * t, 2.2);
        o.fillCircle(w / 2 - inset - (w - inset * 2) * t, -h / 2 + inset + (h - inset * 2) * t, 2.2);
    }

    private pop(pv: PodView): void {
        this.scene.tweens.killTweensOf(pv.face);
        pv.face.setScale(1);
        this.scene.tweens.add({ targets: pv.face, scale: 1.18, duration: 110, yoyo: true, ease: 'Sine.easeOut' });
    }

    private drawEmptySlot(column: number): void {
        const q = this.layout.queue;
        const s = podSlot(this.layout, column, 0);
        this.slotGfx.lineStyle(1.5, COLORS.frame, 0.18);
        this.slotGfx.strokeRoundedRect(s.x - q.podW / 2, s.y - q.podH / 2, q.podW, q.podH, capsuleRadius(q.podW, q.podH));
    }

    private drawLinks(): void {
        const g = this.linkGfx;
        g.clear();
        if (!this.hasLinks) return;
        const w = this.layout.queue.podW;
        const hh = this.layout.queue.podH;
        for (const a of this.pods.values()) {
            if (a.link === null) continue;
            const b = this.pods.get(a.link);
            if (!b) {
                const partner = this.loc.get(a.link);
                if (partner) this.drawOffscreenLink(g, a, partner.column);
                continue;
            }
            if (a.id > a.link) continue;
            if (a.column === b.column) {
                const x = a.root.x - (w / 2) * a.root.scaleX - 6;
                drawLightning(g, x, a.root.y, x, b.root.y, 8, 6, 0x9ff3ff, 2, 1);
                continue;
            }
            const ya = a.root.y - (hh / 2) * a.root.scaleY + 6;
            const yb = b.root.y - (hh / 2) * b.root.scaleY + 6;
            const ax = a.root.x + (b.root.x > a.root.x ? 1 : -1) * (w / 2) * a.root.scaleX;
            const bx = b.root.x + (a.root.x > b.root.x ? 1 : -1) * (w / 2) * b.root.scaleX;
            drawLightning(g, ax, ya, bx, yb, 12, 10, 0x9ff3ff, 2.2, 1);
        }
    }

    /**
     * The partner is below the visible window: the tether runs down the gap beside the partner's column and ends in
     * an arrowhead at that column's "+n" badge.
     */
    private drawOffscreenLink(g: GameObjects.Graphics, a: PodView, column: number): void {
        const q = this.layout.queue;
        const cx = q.centers[column];
        if (cx === undefined) return;
        const side = a.column === column ? -1 : a.column > column ? 1 : -1;
        const gapX = a.column === column ? a.root.x - (q.podW / 2) * a.root.scaleX - 6 : cx + (side * q.colW) / 2;
        const ya = a.root.y - (q.podH / 2) * a.root.scaleY + 6;
        const ax = a.root.x + (a.column === column ? -1 : -side) * (q.podW / 2) * a.root.scaleX;
        const tipX = cx + side * 20;
        const by = q.badgeY;
        if (Math.abs(gapX - ax) > 2) drawLightning(g, ax, ya, gapX, ya, 6, 6, 0x9ff3ff, 2.2, 1);
        drawLightning(g, gapX, ya, gapX, by, 10, 5, 0x9ff3ff, 2.2, 1);
        drawLightning(g, gapX, by, tipX, by, 3, 3, 0x9ff3ff, 2.2, 1);
        const head = 7;
        for (let pass = 0; pass < 2; pass++) {
            g.lineStyle(pass === 0 ? 7 : 2.2, pass === 0 ? 0x9ff3ff : 0xffffff, pass === 0 ? 0.3 : 1);
            g.beginPath();
            g.moveTo(tipX + side * head, by - head);
            g.lineTo(tipX, by);
            g.lineTo(tipX + side * head, by + head);
            g.strokePath();
        }
    }

    private drawHint(timeMs: number): void {
        const g = this.hintGfx;
        g.clear();
        if (this.hint === null) return;
        const q = this.layout.queue;
        const s = podSlot(this.layout, this.hint, 0);
        const pulse = 0.55 + 0.45 * Math.sin(timeMs / 140);
        g.lineStyle(4, COLORS.hint, pulse);
        g.strokeRoundedRect(s.x - q.podW / 2 - 7, s.y - q.podH / 2 - 7, q.podW + 14, q.podH + 14, capsuleRadius(q.podW, q.podH) + 6);
    }
}
