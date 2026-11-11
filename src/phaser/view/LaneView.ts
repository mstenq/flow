/**
 * LaneView (neon): L lane slots. An active pod is a glass capsule whose liquid level rises as goo lands, with a
 * wobbling sine surface that sloshes on every arrival, a crisp count (UI camera) that ticks down with a pop, a
 * color-blind glyph, and status glows (stalled flicker in the pod's own color, linked "charged, waiting" aura). Empty slots are dim
 * dashed outlines that breathe. Linked pods in two lanes are joined by a crackling lightning tether. When every
 * lane is occupied, the tray border heats from cyan toward red.
 *
 * The count shown is `remaining + goo still in flight` for that pod, so it decrements as blobs land. A pod that
 * completed in the sim stays on screen until its last blob lands, then brightens, compresses and shoots up
 * (with a shockwave via `onPodLaunched`). `busyCount` covers that animation.
 *
 * Public interface (kept from the gray box):
 *   constructor(scene, layout, palette)
 *   sync(lanes)                 full refresh from `ViewState.lanes`
 *   slotCenter(lane)            logical pixel center (goo and tapped pods fly here)
 *   pulse(lane, podId?)         a goo blob arrived
 *   flash(lane)                 pod entered or completed (brief highlight)
 *   destroy()
 * Added: update(dtMs), expectGoo(lane, podId), busyCount, overload(), setHooks().
 */
import { BlendModes } from 'phaser';
import type { GameObjects, Scene } from 'phaser';
import type { Layout, Point2 } from '@game/layout';
import type { LaneState } from '@game/types';
import { mixColor } from '@data/themeColors';
import { COLORS, DEPTH, font, paletteArtFromNums } from '../theme';
import type { PaletteArt } from '../theme';
import { both, ui } from '../fx/CameraRig';
import type { Fx } from '../fx/Fx';
import { TEX } from '../fx/textures';
import { drawGlyph, drawLightning, drawLinkRings, drawCapsule, drawGlassSheen, strokeDashedRoundedRect, capsuleRadius } from './podArt';

export interface LaneHooks {
    fx?: Fx;
    /** A completed pod launched out of its lane (grid shockwave, audio). */
    onPodLaunched?: (lane: number, x: number, y: number, color: number) => void;
}

interface Shown {
    podId: number;
    color: number;
    capacity: number;
    remaining: number;
    state: LaneState['state'];
    link: number | null;
}

interface Slot {
    index: number;
    root: GameObjects.Container;
    aura: GameObjects.Image;
    shell: GameObjects.Graphics;
    liquid: GameObjects.Graphics;
    /** Color-blind glyph on a dark badge, above the liquid (which would otherwise cover it). */
    mark: GameObjects.Graphics;
    count: GameObjects.Text;
    cap: GameObjects.Text;
    status: GameObjects.Text;
    ghost: GameObjects.Graphics;
    /** Dashed empty-slot outline; visible while the slot is empty or a pod is still flying in. */
    outline: GameObjects.Graphics;
    shown: Shown | null;
    /** Snapshot state waiting to be shown once the current pod has finished. */
    pending: LaneState | null;
    hasPending: boolean;
    /** Sim says the shown pod is done (or replaced); play the launch once its goo has landed. */
    finishing: boolean;
    /**
     * The launched pod's ghost is still flying (gates `busyCount`). A flag, not a counter: a second launch kills the
     * running ghost tween, and a killed tween never calls `onComplete`, so a counter would leak and block the win.
     */
    launching: boolean;
    level: number;
    wave: number;
    phase: number;
    pop: number;
    flash: number;
    deny: number;
    shellKey: string;
    lastCount: number;
    /** Pods tapped toward this slot that have not landed yet. */
    inbound: number;
    /** ms the current inbound pods have been in flight (a safety net: a pod that never reports landing cannot hide the slot forever). */
    inboundMs: number;
    /** ms left during which the texts stay hidden (the launched pod's ghost is still over the slot). */
    hold: number;
    /** 0..1 fade of the slot's texts. */
    textAlpha: number;
}

const LIQUID_POINTS = 18;
/** After a pod launches, its slot texts stay hidden this long (the ghost capsule is still rising off the slot). */
const LAUNCH_TEXT_HOLD_MS = 330;
const INBOUND_MAX_MS = 900;
const SURFACE_X = new Float32Array(LIQUID_POINTS);

export class LaneView {
    private readonly slots: Slot[] = [];
    private readonly art: PaletteArt[];
    private readonly tray: GameObjects.Graphics;
    private readonly linkGfx: GameObjects.Graphics;
    private readonly inflight = new Map<number, number>();
    private hooks: LaneHooks = {};
    private heat = 0;
    private heatTarget = 0;
    private timeS = 0;
    private linkMs = 0;
    private readonly w: number;
    private readonly h: number;

    constructor(
        private readonly scene: Scene,
        private readonly layout: Layout,
        palette: number[],
    ) {
        this.art = paletteArtFromNums(palette);
        const { rects, slotW, slotH } = layout.lanes;
        this.w = slotW - 10;
        this.h = slotH - 8;
        const small = slotW < 110;
        this.tray = scene.add.graphics().setDepth(DEPTH.lanes - 0.5);
        rects.forEach((r, i) => {
            const root = both(scene.add.container(r.x + r.w / 2, r.y + r.h / 2).setDepth(DEPTH.lanes));
            const outline = scene.add.graphics();
            const aura = scene.add.image(0, 0, TEX.glow).setBlendMode(BlendModes.ADD).setDisplaySize(this.w * 1.6, this.h * 1.5).setAlpha(0);
            const shell = scene.add.graphics();
            const liquid = scene.add.graphics();
            const mark = scene.add.graphics();
            const count = ui(scene.add.text(0, -2, '', { ...font(small ? 30 : 42), stroke: '#05030c', strokeThickness: 8 }).setOrigin(0.5));
            const cap = ui(scene.add.text(0, this.h / 2 - 17, '', { ...font(small ? 15 : 18, COLORS.text, false), stroke: '#05030c', strokeThickness: 5 }).setOrigin(0.5));
            const status = ui(scene.add.text(0, -this.h / 2 + 13, '', { ...font(Math.min(17, slotW / 7.5)), stroke: '#05030c', strokeThickness: 7 }).setOrigin(0.5));
            root.add([outline, aura, shell, liquid, mark, count, cap, status]);
            const ghost = scene.add.graphics().setDepth(DEPTH.fx - 0.5).setBlendMode(BlendModes.ADD).setVisible(false);
            this.slots.push({
                index: i,
                root,
                aura,
                shell,
                liquid,
                mark,
                count,
                cap,
                status,
                ghost,
                outline,
                shown: null,
                pending: null,
                hasPending: false,
                finishing: false,
                launching: false,
                level: 0,
                wave: 0,
                phase: Math.random() * 6,
                pop: 0,
                flash: 0,
                deny: 0,
                shellKey: '',
                lastCount: -1,
                inbound: 0,
                inboundMs: 0,
                hold: 0,
                textAlpha: 1,
            });
        });
        this.linkGfx = scene.add.graphics().setDepth(DEPTH.lanes + 0.2).setBlendMode(BlendModes.ADD);
        for (let i = 0; i < LIQUID_POINTS; i++) SURFACE_X[i] = -this.w / 2 + (this.w * i) / (LIQUID_POINTS - 1);
        for (const s of this.slots) {
            this.drawOutline(s);
            this.drawShell(s);
        }
    }

    setHooks(hooks: LaneHooks): void {
        this.hooks = hooks;
    }

    /** > 0 while a completed pod is still being launched out of its lane. */
    get busyCount(): number {
        let n = 0;
        for (const s of this.slots) if (s.launching) n++;
        return n;
    }

    slotCenter(lane: number): Point2 {
        return { x: this.layout.lanes.centers[lane]!, y: this.layout.lanes.y + this.layout.lanes.slotH / 2 };
    }

    /** A blob was launched toward `lane` for `podId` (it counts toward the shown number until it lands). */
    expectGoo(_lane: number, podId: number): void {
        this.inflight.set(podId, (this.inflight.get(podId) ?? 0) + 1);
    }

    /**
     * A pod was tapped toward `lane` and is flying there. Until `podLanded`, the slot shows only its empty outline:
     * the crisp slot number / pod count (UI camera, always above game art) would otherwise sit on top of the flying pod.
     */
    expectPod(lane: number): void {
        const s = this.slots[lane];
        if (s) s.inbound++;
    }

    /** The flying pod reached the slot: the lane pod appears with a flash. */
    podLanded(lane: number): void {
        const s = this.slots[lane];
        if (!s || s.inbound === 0) return;
        s.inbound--;
        if (s.inbound > 0) return;
        s.flash = 1;
        s.wave = 3;
    }

    sync(lanes: (LaneState | null)[]): void {
        let full = lanes.length > 0;
        lanes.forEach((state, i) => {
            if (state === null) full = false;
            this.syncSlot(i, state);
        });
        this.heatTarget = full ? 1 : 0;
    }

    pulse(lane: number, podId?: number): void {
        const s = this.slots[lane];
        if (!s) return;
        if (podId !== undefined) {
            const left = (this.inflight.get(podId) ?? 0) - 1;
            if (left > 0) this.inflight.set(podId, left);
            else this.inflight.delete(podId);
        }
        s.wave = Math.min(7, s.wave + 2.2);
        s.pop = 1;
        const shown = s.shown;
        if (!shown) return;
        const fx = this.hooks.fx;
        if (fx) {
            const art = this.art[shown.color];
            const p = this.slotCenter(lane);
            const surface = p.y + this.h / 2 - 6 - (this.h - 12) * s.level;
            fx.burst(p.x + (Math.random() - 0.5) * this.w * 0.4, surface, art?.glow ?? 0xffffff, {
                count: 3,
                speedMin: 60,
                speedMax: 170,
                angleMin: 220,
                angleMax: 320,
                scale: 0.38,
                life: 380,
                gravity: 520,
            });
        }
    }

    flash(lane: number): void {
        const s = this.slots[lane];
        if (!s) return;
        s.flash = 1;
    }

    /** Overload: every lane flashes red and its pod cracks into shards. */
    overload(): void {
        const fx = this.hooks.fx;
        for (const s of this.slots) {
            s.deny = 1;
            if (!fx) continue;
            const p = this.slotCenter(s.index);
            const color = s.shown ? (this.art[s.shown.color]?.core ?? 0xff3b5c) : 0xff3b5c;
            fx.shatter(p.x, p.y, color, 18, 360, 1);
            fx.shatter(p.x, p.y, 0xff3b5c, 10, 260, 0.8);
        }
    }

    update(dtMs: number): void {
        const dt = dtMs / 1000;
        this.timeS += dt;
        this.heat += (this.heatTarget - this.heat) * Math.min(1, dt * (this.heatTarget > this.heat ? 1.2 : 3));
        for (const s of this.slots) this.tickSlot(s, dt);
        this.drawTray();
        this.linkMs += dtMs;
        if (this.linkMs >= 55) {
            this.linkMs = 0;
            this.drawLinks();
        }
    }

    destroy(): void {
        for (const s of this.slots) {
            this.scene.tweens.killTweensOf(s.ghost);
            s.root.destroy();
            s.ghost.destroy();
        }
        this.slots.length = 0;
        this.tray.destroy();
        this.linkGfx.destroy();
    }

    // ------------------------------------------------------------------ state

    private syncSlot(i: number, state: LaneState | null): void {
        const s = this.slots[i]!;
        const shown = s.shown;
        if (shown !== null && state !== null && state.podId === shown.podId) {
            shown.remaining = state.remaining;
            shown.state = state.state;
            return;
        }
        if (shown === null) {
            if (state !== null) this.show(s, state);
            return;
        }
        // The shown pod left the sim lane (completed). Finish it once its goo has landed.
        s.finishing = true;
        s.pending = state;
        s.hasPending = true;
        shown.remaining = 0;
        if (state !== null) {
            // A new pod is already here: do not keep it waiting on stragglers.
            this.launchPod(s);
        }
    }

    private show(s: Slot, state: LaneState | null): void {
        s.finishing = false;
        s.hasPending = false;
        s.pending = null;
        s.lastCount = -1;
        if (state === null) {
            s.shown = null;
            s.level = 0;
            this.drawShell(s);
            return;
        }
        s.shown = { podId: state.podId, color: state.color, capacity: state.capacity, remaining: state.remaining, state: state.state, link: state.link };
        s.level = 0;
        s.wave = 3;
        s.flash = 1;
        this.drawShell(s);
    }

    private launchPod(s: Slot): void {
        const shown = s.shown;
        const next = s.pending;
        if (shown) this.playLaunch(s, shown);
        this.show(s, next);
    }

    private playLaunch(s: Slot, shown: Shown): void {
        const art = this.art[shown.color];
        const color = art?.glow ?? 0xffffff;
        const p = this.slotCenter(s.index);
        const g = s.ghost;
        this.scene.tweens.killTweensOf(g);
        g.clear();
        drawCapsule(g, 0, 0, this.w, this.h, { body: art?.core ?? 0xffffff, bodyAlpha: 0.32, rim: color, rimAlpha: 1, rimWidth: 3, glowAlpha: 1 });
        g.setPosition(p.x, p.y).setScale(1).setAlpha(1).setVisible(true);
        s.hold = LAUNCH_TEXT_HOLD_MS;
        s.launching = true;
        this.inflight.delete(shown.podId);
        const fx = this.hooks.fx;
        fx?.flash(p.x, p.y, color, this.w * 2.2, 320, 1);
        fx?.ring(p.x, p.y, color, this.w * 1.6, 420, 0.9, this.w * 0.4);
        this.scene.tweens.chain({
            targets: g,
            tweens: [
                { scaleX: 1.12, scaleY: 0.72, duration: 90, ease: 'Quad.easeOut' },
                {
                    y: p.y - 460,
                    scaleX: 0.22,
                    scaleY: 1.7,
                    alpha: 0,
                    duration: 300,
                    ease: 'Cubic.easeIn',
                    onStart: () => {
                        this.hooks.onPodLaunched?.(s.index, p.x, p.y, shown.color);
                        fx?.burst(p.x, p.y - this.h * 0.3, color, { count: 22, speedMin: 120, speedMax: 380, angleMin: 240, angleMax: 300, scale: 0.6, life: 520 });
                    },
                    onUpdate: () => {
                        if (Math.random() < 0.5) fx?.burst(g.x, g.y + this.h * 0.4, color, { count: 1, speedMin: 10, speedMax: 40, scale: 0.55, life: 300 });
                    },
                },
            ],
            onComplete: () => {
                g.setVisible(false);
                s.launching = false;
            },
        });
    }

    // ------------------------------------------------------------------ per frame

    private tickSlot(s: Slot, dt: number): void {
        const shown = s.shown;
        s.flash = Math.max(0, s.flash - dt * 3.5);
        s.deny = Math.max(0, s.deny - dt * 1.4);
        s.pop = Math.max(0, s.pop - dt * 7);
        s.hold = Math.max(0, s.hold - dt * 1000);
        this.updateSlotVisibility(s, dt);
        if (!shown) {
            const breathe = 0.55 + 0.35 * Math.sin(this.timeS * 1.8 + s.index * 0.9);
            s.outline.setAlpha(breathe);
            s.aura.setAlpha(s.flash * 0.6 + s.deny * 0.8).setTint(s.deny > 0 ? 0xff2950 : COLORS.frame);
            s.liquid.clear();
            return;
        }
        const inbound = s.inbound > 0;
        s.outline.setAlpha(inbound ? 0.55 + 0.35 * Math.sin(this.timeS * 1.8 + s.index * 0.9) : 1);
        s.shell.setAlpha(inbound ? 0 : 1);
        s.mark.setAlpha(inbound ? 0 : 1);
        const pending = this.inflight.get(shown.podId) ?? 0;
        const displayed = shown.remaining + pending;
        const target = shown.capacity > 0 ? 1 - displayed / shown.capacity : 1;
        s.level += (target - s.level) * Math.min(1, dt * 10);
        s.wave = Math.max(0.6, s.wave * Math.exp(-dt * 2.2));
        s.phase += dt * (5 + s.wave * 0.6);
        if (inbound) s.liquid.clear();
        else this.drawLiquid(s, shown);
        if (displayed !== s.lastCount) {
            s.lastCount = displayed;
            s.count.setText(String(displayed));
        }
        s.count.setScale(1 + s.pop * 0.22);
        const art = this.art[shown.color];
        let aura = s.flash * 0.7 + s.deny * 0.9;
        let auraTint = art?.glow ?? 0xffffff;
        if (shown.state === 'waiting') {
            aura += 0.45 + 0.35 * Math.sin(this.timeS * 7);
            auraTint = mixColor(auraTint, 0xffffff, 0.3);
        } else if (shown.state === 'stalled') {
            // Pod-colored flicker: an amber aura/rim reads as the orange pod and hides the yellow one.
            aura += 0.12 + 0.1 * Math.sin(this.timeS * 5);
        }
        if (s.deny > 0) auraTint = 0xff2950;
        s.aura.setAlpha(inbound ? 0 : Math.min(1, aura)).setTint(auraTint);
        this.updateShellState(s, shown);
        if (s.finishing && pending === 0) this.launchPod(s);
    }

    /** Slot texts are hidden while a pod flies in or the launched pod's ghost is still over the slot, then fade in. */
    private updateSlotVisibility(s: Slot, dt: number): void {
        s.inboundMs = s.inbound > 0 ? s.inboundMs + dt * 1000 : 0;
        if (s.inboundMs > INBOUND_MAX_MS) s.inbound = 0;
        const hidden = s.inbound > 0 || s.hold > 0;
        s.textAlpha = hidden ? 0 : Math.min(1, s.textAlpha + dt * 8);
        s.count.setAlpha(s.textAlpha);
        s.cap.setAlpha(s.textAlpha);
        s.status.setAlpha(s.textAlpha);
        s.outline.setVisible(s.shown === null || s.inbound > 0);
    }

    private drawOutline(s: Slot): void {
        const g = s.outline;
        g.clear();
        g.fillStyle(0x0b0720, 0.55);
        g.fillRoundedRect(-this.w / 2, -this.h / 2, this.w, this.h, capsuleRadius(this.w, this.h));
        strokeDashedRoundedRect(g, 0, 0, this.w, this.h, capsuleRadius(this.w, this.h), 9, 7, 2, COLORS.frame, 0.6);
    }

    private updateShellState(s: Slot, shown: Shown): void {
        const key = `${shown.podId}:${shown.state}`;
        if (s.shellKey === key) return;
        this.drawShell(s);
    }

    private drawShell(s: Slot): void {
        const g = s.shell;
        const shown = s.shown;
        g.clear();
        s.mark.clear();
        const w = this.w;
        const h = this.h;
        if (!shown) {
            s.shellKey = 'free';
            s.count.setText(String(s.index + 1)).setColor('#3a5a8a').setScale(1);
            s.cap.setText('');
            s.status.setText('');
            return;
        }
        s.shellKey = `${shown.podId}:${shown.state}`;
        const art = this.art[shown.color]!;
        const rim = shown.state === 'waiting' ? mixColor(art.glow, 0xffffff, 0.4) : art.core;
        drawCapsule(g, 0, 0, w, h, { body: art.deep, bodyAlpha: 0.9, rim, rimAlpha: 1, rimWidth: 2.5, glowAlpha: 0.9 });
        // Bottom-left: the top edge carries the STALLED / CHARGED label and the link rings.
        const gx = -w / 2 + 20;
        const gy = h / 2 - 20;
        s.mark.fillStyle(0x05030c, 0.75);
        s.mark.fillCircle(gx, gy, 14);
        drawGlyph(s.mark, art.glyph, gx, gy, 9, 0xffffff, 1);
        if (shown.link !== null) drawLinkRings(g, w / 2 - 15, -h / 2 + 13, 14, 0xe8f6ff);
        s.count.setColor('#ffffff');
        s.cap.setText(`/${shown.capacity}`);
        s.status.setText(shown.state === 'stalled' ? 'STALLED' : shown.state === 'waiting' ? 'CHARGED' : '');
        s.status.setColor(shown.state === 'waiting' ? '#bff8ff' : COLORS.warn);
    }

    private drawLiquid(s: Slot, shown: Shown): void {
        const g = s.liquid;
        const art = this.art[shown.color];
        g.clear();
        if (!art) return;
        const w = this.w - 6;
        const h = this.h - 6;
        const bottom = h / 2;
        const top = -h / 2;
        const level = Math.max(0, Math.min(1, s.level));
        const surface = bottom - h * level;
        if (level <= 0.003) return;
        const r = capsuleRadius(w, h);
        const k = (Math.PI * 2) / w;
        const amp = s.wave * Math.min(1, level * 6) * Math.min(1, (1 - level) * 8 + 0.15);
        // Body: clip-free approximation, inset rounded rect below the surface.
        const fillTop = Math.max(top + 2, surface);
        g.fillStyle(art.core, 0.78);
        g.beginPath();
        const half = w / 2 - 1;
        g.moveTo(-half, fillTop);
        for (let i = 0; i < LIQUID_POINTS; i++) {
            const x = (SURFACE_X[i]! * (w - 2)) / this.w;
            const y = Math.max(top + 2, surface + amp * Math.sin(k * x * 1.3 + s.phase) + amp * 0.45 * Math.sin(k * x * 2.7 - s.phase * 1.4));
            g.lineTo(x, y);
        }
        g.lineTo(half, bottom - r * 0.6);
        g.lineTo(half - r * 0.4, bottom - 1);
        g.lineTo(-half + r * 0.4, bottom - 1);
        g.lineTo(-half, bottom - r * 0.6);
        g.closePath();
        g.fillPath();
        // Hot surface line.
        g.lineStyle(2, art.glow, 0.95);
        g.beginPath();
        for (let i = 0; i < LIQUID_POINTS; i++) {
            const x = (SURFACE_X[i]! * (w - 2)) / this.w;
            const y = Math.max(top + 2, surface + amp * Math.sin(k * x * 1.3 + s.phase) + amp * 0.45 * Math.sin(k * x * 2.7 - s.phase * 1.4));
            if (i === 0) g.moveTo(x, y);
            else g.lineTo(x, y);
        }
        g.strokePath();
        drawGlassSheen(g, 0, 0, this.w, this.h, 0.8);
    }

    private drawTray(): void {
        const g = this.tray;
        const { rects } = this.layout.lanes;
        const first = rects[0];
        const last = rects[rects.length - 1];
        if (!first || !last) return;
        g.clear();
        const x = first.x - 8;
        const y = first.y - 4;
        const w = last.x + last.w - first.x + 16;
        const h = first.h + 8;
        const heat = this.heat;
        const color = mixColor(COLORS.frame, COLORS.frameHot, heat);
        const flicker = heat > 0.6 ? 0.75 + 0.25 * Math.sin(this.timeS * 18) : 1;
        g.fillStyle(0x07041a, 0.55);
        g.fillRoundedRect(x, y, w, h, 16);
        g.lineStyle(5, color, (0.08 + heat * 0.25) * flicker);
        g.strokeRoundedRect(x, y, w, h, 16);
        g.lineStyle(1.5, color, (0.4 + heat * 0.5) * flicker);
        g.strokeRoundedRect(x, y, w, h, 16);
    }

    private drawLinks(): void {
        const g = this.linkGfx;
        g.clear();
        const { centers, y } = this.layout.lanes;
        for (let i = 0; i < this.slots.length; i++) {
            const a = this.slots[i]!.shown;
            if (!a || a.link === null || a.podId > a.link) continue;
            const j = this.slots.findIndex((s) => s.shown !== null && s.shown.podId === a.link);
            if (j < 0) continue;
            const yy = y + 12;
            const ax = centers[i]! + (j > i ? this.w / 2 - 4 : -this.w / 2 + 4);
            const bx = centers[j]! + (j > i ? -this.w / 2 + 4 : this.w / 2 - 4);
            drawLightning(g, ax, yy, bx, yy, 12, 9, 0x9ff3ff, 2.2, 1);
        }
    }
}
