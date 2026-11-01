/**
 * GooStream (neon plasma): pooled glowing blobs that flow along a route, leaving an additive particle trail.
 * With `rideFrame`, the route is: claimed cell -> board edge (the given points) -> along the neon frame to the
 * bottom edge above the lane -> a short arc into the lane pod. Every blob bound for the same lane shares the frame
 * channel, so a busy lane reads as one continuous river of plasma (heads + overlapping trails + bloom).
 *
 * Everything is pooled (blob records, sprites, route buffers, one shared particle emitter); `update` allocates
 * nothing. Caps: MAX_SPRITES visible blobs (beyond that blobs still travel and arrive, just invisibly) and a
 * global trail particle budget, with the emission spacing widened automatically under load.
 *
 * Public interface (kept from the gray box):
 *   constructor(scene)
 *   launch({ points, color, radius?, speed?, onArrive? })   points are logical pixels, first = start, last = target
 *   update(dtMs)
 *   activeCount                                             > 0 while anything is still travelling
 *   clear(), destroy()
 * Added: setFrame(rect) for frame riding, `rideFrame` / `glow` launch options.
 */
import { BlendModes } from 'phaser';
import type { GameObjects, Scene } from 'phaser';
import type { Point2, Rect } from '@game/layout';
import { mixColor } from '@data/themeColors';
import { DEPTH } from '../theme';
import { TEX } from '../fx/textures';
import { particleScale } from '../fx/fxSettings';

export interface GooLaunch {
    points: Point2[];
    color: number;
    radius?: number;
    /** Max pixels per second along the path (default 1500). */
    speed?: number;
    onArrive?: () => void;
    /** Route along the neon frame (set with `setFrame`) before arcing into the target. */
    rideFrame?: boolean;
    /** Head color (default: the color lightened). */
    glow?: number;
}

interface Blob {
    /** Route as x,y pairs. */
    pts: Float32Array;
    /** Cumulative length at each point. */
    cum: Float32Array;
    n: number;
    total: number;
    dist: number;
    v: number;
    vmax: number;
    seg: number;
    color: number;
    head: number;
    radius: number;
    age: number;
    emitAcc: number;
    sprite: GameObjects.Image | null;
    onArrive: (() => void) | null;
}

const DEFAULT_SPEED = 1500;
const START_SPEED_FRAC = 0.25;
const ACCEL = 9000;
const MAX_SPRITES = 300;
const TRAIL_BUDGET = 1300;
const TRAIL_LIFE = 300;
const MIN_SPACING = 7;
const MAX_POINTS = 96;
const CORNER = 12;
const ARC_STEPS = 7;
const GROW_MS = 90;
/** Tail length in px at full speed. */
const TAIL_LEN = 85;

export class GooStream {
    private readonly active: Blob[] = [];
    private readonly free: Blob[] = [];
    private readonly sprites: GameObjects.Image[] = [];
    private spriteCount = 0;
    private readonly trail: GameObjects.Particles.ParticleEmitter;
    /** Continuous glowing tails (one polyline per blob, redrawn each frame) so a busy channel fuses into a river. */
    private readonly tails: GameObjects.Graphics;
    private tailsDrawn = false;
    private frame: Rect | null = null;
    private emitColor = 0xffffff;
    private emitScale = 1;
    private spacing = MIN_SPACING;
    /** Scratch route builder (reused). */
    private readonly scratch = new Float32Array(MAX_POINTS * 2);

    constructor(private readonly scene: Scene) {
        this.trail = scene.add.particles(0, 0, TEX.dot, {
            emitting: false,
            blendMode: 'ADD',
            maxAliveParticles: Math.round(TRAIL_BUDGET * particleScale()),
            lifespan: { min: TRAIL_LIFE * 0.7, max: TRAIL_LIFE * 1.2 },
            speed: { min: 4, max: 26 },
            angle: { min: 0, max: 360 },
            scale: { onEmit: () => this.emitScale * (0.75 + Math.random() * 0.5), onUpdate: (p, _k, t) => (p as Trail).base * (1 - t * t) },
            alpha: { start: 0.85, end: 0 },
            tint: { onEmit: () => this.emitColor, onUpdate: (_p, _k, _t, v) => v },
            emitCallback: (p: GameObjects.Particles.Particle) => {
                (p as Trail).base = p.scaleX;
            },
        });
        this.trail.setDepth(DEPTH.goo);
        this.tails = scene.add.graphics().setDepth(DEPTH.goo + 0.05).setBlendMode(BlendModes.ADD);
    }

    get activeCount(): number {
        return this.active.length;
    }

    /** The neon frame the goo rides (BoardView.frameRect()). */
    setFrame(frame: Rect): void {
        this.frame = frame;
    }

    launch(opts: GooLaunch): void {
        const { points } = opts;
        if (points.length === 0) return;
        const blob = this.free.pop() ?? newBlob();
        const n = opts.rideFrame && this.frame !== null && points.length >= 2 ? this.buildFrameRoute(points, this.frame) : this.copyRoute(points);
        ensureCapacity(blob, n);
        blob.pts.set(this.scratch.subarray(0, n * 2));
        blob.n = n;
        let total = 0;
        blob.cum[0] = 0;
        for (let i = 1; i < n; i++) {
            total += Math.hypot(blob.pts[i * 2]! - blob.pts[i * 2 - 2]!, blob.pts[i * 2 + 1]! - blob.pts[i * 2 - 1]!);
            blob.cum[i] = total;
        }
        blob.total = total;
        blob.dist = 0;
        blob.vmax = opts.speed ?? DEFAULT_SPEED;
        blob.v = blob.vmax * START_SPEED_FRAC;
        blob.seg = 0;
        blob.color = opts.color;
        blob.head = opts.glow ?? mixColor(opts.color, 0xffffff, 0.4);
        blob.radius = opts.radius ?? 6;
        blob.age = 0;
        blob.emitAcc = 0;
        blob.onArrive = opts.onArrive ?? null;
        blob.sprite = this.takeSprite();
        if (blob.sprite) blob.sprite.setTint(blob.head).setPosition(points[0]!.x, points[0]!.y).setScale(0.1).setVisible(true);
        this.active.push(blob);
    }

    update(dtMs: number): void {
        const count = this.active.length;
        if (this.tailsDrawn) {
            this.tails.clear();
            this.tailsDrawn = false;
        }
        if (count === 0) return;
        const budget = TRAIL_BUDGET * particleScale();
        // Widen trail spacing under load so the live particle count stays inside the budget.
        this.spacing = Math.max(MIN_SPACING, (count * DEFAULT_SPEED * (TRAIL_LIFE / 1000)) / budget);
        const dt = dtMs / 1000;
        for (let i = count - 1; i >= 0; i--) {
            const b = this.active[i]!;
            b.age += dtMs;
            b.v = Math.min(b.vmax, b.v + ACCEL * dt);
            const moved = b.v * dt;
            b.dist += moved;
            if (b.dist >= b.total) {
                this.arrive(b, i);
                continue;
            }
            this.place(b, moved);
            this.drawTail(b);
        }
    }

    /** Glowing tail from the head back along the route (length grows with speed). */
    private drawTail(b: Blob): void {
        const len = Math.min(b.dist, TAIL_LEN * (b.v / DEFAULT_SPEED) * Math.min(1, b.age / GROW_MS));
        if (len < 4) return;
        const g = this.tails;
        const stop = b.dist - len;
        const s = b.seg;
        const segLen = b.cum[s + 1]! - b.cum[s]!;
        const f = segLen <= 0 ? 1 : (b.dist - b.cum[s]!) / segLen;
        const hx = b.pts[s * 2]! + (b.pts[s * 2 + 2]! - b.pts[s * 2]!) * f;
        const hy = b.pts[s * 2 + 1]! + (b.pts[s * 2 + 3]! - b.pts[s * 2 + 1]!) * f;
        for (let pass = 0; pass < 2; pass++) {
            if (pass === 0) g.lineStyle(b.radius * 1.8, b.color, 0.36);
            else g.lineStyle(Math.max(1.5, b.radius * 0.5), b.head, 0.7);
            g.beginPath();
            g.moveTo(hx, hy);
            let i = s;
            while (i > 0 && b.cum[i]! > stop) {
                g.lineTo(b.pts[i * 2]!, b.pts[i * 2 + 1]!);
                i--;
            }
            const a = b.cum[i]!;
            const bl = b.cum[i + 1]! - a;
            const t = bl <= 0 ? 0 : Math.max(0, (stop - a) / bl);
            g.lineTo(b.pts[i * 2]! + (b.pts[i * 2 + 2]! - b.pts[i * 2]!) * t, b.pts[i * 2 + 1]! + (b.pts[i * 2 + 3]! - b.pts[i * 2 + 1]!) * t);
            g.strokePath();
        }
        this.tailsDrawn = true;
    }

    clear(): void {
        for (const b of this.active) this.release(b);
        this.active.length = 0;
        this.tails.clear();
        this.tailsDrawn = false;
    }

    destroy(): void {
        this.clear();
        this.trail.destroy();
        this.tails.destroy();
        for (const s of this.sprites) s.destroy();
        this.sprites.length = 0;
    }

    // ------------------------------------------------------------------ motion

    private place(b: Blob, moved: number): void {
        while (b.seg < b.n - 2 && b.cum[b.seg + 1]! < b.dist) b.seg++;
        const s = b.seg;
        const segLen = b.cum[s + 1]! - b.cum[s]!;
        const f = segLen <= 0 ? 1 : (b.dist - b.cum[s]!) / segLen;
        const x0 = b.pts[s * 2]!;
        const y0 = b.pts[s * 2 + 1]!;
        const ux = segLen <= 0 ? 0 : (b.pts[s * 2 + 2]! - x0) / segLen;
        const uy = segLen <= 0 ? 0 : (b.pts[s * 2 + 3]! - y0) / segLen;
        const x = x0 + ux * segLen * f;
        const y = y0 + uy * segLen * f;
        const grow = Math.min(1, b.age / GROW_MS);
        const base = (b.radius / 7) * grow;
        if (b.sprite) {
            const stretch = 1 + (b.v / DEFAULT_SPEED) * 1.3;
            b.sprite.setPosition(x, y).setRotation(Math.atan2(uy, ux)).setScale(base * stretch, base * 0.8);
        }
        // Trail: evenly spaced along the distance travelled this frame.
        b.emitAcc += moved;
        if (b.emitAcc < this.spacing) return;
        this.emitColor = b.color;
        this.emitScale = (b.radius / 7) * 0.95;
        while (b.emitAcc >= this.spacing) {
            b.emitAcc -= this.spacing;
            const back = b.emitAcc;
            this.trail.emitParticleAt(x - ux * back, y - uy * back, 1);
        }
    }

    private arrive(b: Blob, index: number): void {
        const last = this.active.length - 1;
        this.active[index] = this.active[last]!;
        this.active.length = last;
        const cb = b.onArrive;
        this.release(b);
        cb?.();
    }

    private release(b: Blob): void {
        if (b.sprite) {
            b.sprite.setVisible(false);
            this.sprites[this.spriteCount++] = b.sprite;
            b.sprite = null;
        }
        b.onArrive = null;
        this.free.push(b);
    }

    private takeSprite(): GameObjects.Image | null {
        if (this.spriteCount > 0) return this.sprites[--this.spriteCount]!;
        if (this.active.length >= MAX_SPRITES) return null;
        return this.scene.add.image(0, 0, TEX.blob).setBlendMode(BlendModes.ADD).setDepth(DEPTH.goo + 0.1).setVisible(false);
    }

    // ------------------------------------------------------------------ routes

    private copyRoute(points: Point2[], count = points.length): number {
        const n = Math.min(count, MAX_POINTS);
        for (let i = 0; i < n; i++) {
            this.scratch[i * 2] = points[i]!.x;
            this.scratch[i * 2 + 1] = points[i]!.y;
        }
        return n;
    }

    /**
     * points = [cell, ..., exit (on the frame), target]. Keeps the cell path, then walks the frame perimeter the
     * short way to the bottom edge above the target, then arcs into the target.
     */
    private buildFrameRoute(points: Point2[], f: Rect): number {
        const target = points[points.length - 1]!;
        let n = this.copyRoute(points, Math.min(points.length - 1, MAX_POINTS - 24));
        const exit = points[points.length - 2]!;
        const L = f.x;
        const T = f.y;
        const R = f.x + f.w;
        const B = f.y + f.h;
        const W = f.w;
        const H = f.h;
        const P = 2 * (W + H);
        const sExit = perimeterParam(exit.x, exit.y, L, T, R, B);
        const bx = Math.min(R - CORNER - 6, Math.max(L + CORNER + 6, target.x));
        const sTarget = W + H + (R - bx);
        const cw = (((sTarget - sExit) % P) + P) % P;
        const dir = cw <= P - cw ? 1 : -1;
        const span = dir === 1 ? cw : P - cw;
        // Snap the exit onto the frame line.
        const [ex, ey] = perimeterPoint(sExit, L, T, R, B);
        n = this.push(n, ex, ey);
        // Corners crossed (with a small chamfer so the turn reads as a curve).
        const ordered = cornerOrder(sExit, span, dir, [0, W, W + H, 2 * W + H], P);
        for (const s of ordered) {
            const [ax, ay] = perimeterPoint(s - dir * CORNER, L, T, R, B);
            const [bx2, by2] = perimeterPoint(s + dir * CORNER, L, T, R, B);
            n = this.push(n, ax, ay);
            n = this.push(n, bx2, by2);
        }
        n = this.push(n, bx, B);
        // Arc from the frame down into the target (quadratic bezier, slight outward swing).
        const cx = bx + (target.x - bx) * 0.15;
        const cy = B + (target.y - B) * 0.15 + 26;
        for (let i = 1; i <= ARC_STEPS; i++) {
            const t = i / ARC_STEPS;
            const u = 1 - t;
            n = this.push(n, u * u * bx + 2 * u * t * cx + t * t * target.x, u * u * B + 2 * u * t * cy + t * t * target.y);
        }
        return n;
    }

    private push(n: number, x: number, y: number): number {
        if (n >= MAX_POINTS) return n;
        const px = this.scratch[n * 2 - 2];
        const py = this.scratch[n * 2 - 1];
        if (n > 0 && px !== undefined && py !== undefined && Math.abs(px - x) < 0.5 && Math.abs(py - y) < 0.5) return n;
        this.scratch[n * 2] = x;
        this.scratch[n * 2 + 1] = y;
        return n + 1;
    }
}

type Trail = GameObjects.Particles.Particle & { base: number };

function newBlob(): Blob {
    return {
        pts: new Float32Array(64),
        cum: new Float32Array(32),
        n: 0,
        total: 0,
        dist: 0,
        v: 0,
        vmax: DEFAULT_SPEED,
        seg: 0,
        color: 0xffffff,
        head: 0xffffff,
        radius: 6,
        age: 0,
        emitAcc: 0,
        sprite: null,
        onArrive: null,
    };
}

function ensureCapacity(b: Blob, n: number): void {
    if (b.cum.length >= n) return;
    const size = Math.max(n, b.cum.length * 2);
    b.pts = new Float32Array(size * 2);
    b.cum = new Float32Array(size);
}

/** Clockwise perimeter coordinate from the top-left corner of the nearest edge to (x, y). */
function perimeterParam(x: number, y: number, L: number, T: number, R: number, B: number): number {
    const W = R - L;
    const H = B - T;
    const dTop = Math.abs(y - T);
    const dRight = Math.abs(x - R);
    const dBottom = Math.abs(y - B);
    const dLeft = Math.abs(x - L);
    const m = Math.min(dTop, dRight, dBottom, dLeft);
    const cx = Math.min(R, Math.max(L, x));
    const cy = Math.min(B, Math.max(T, y));
    if (m === dTop) return cx - L;
    if (m === dRight) return W + (cy - T);
    if (m === dBottom) return W + H + (R - cx);
    return 2 * W + H + (B - cy);
}

const PT: [number, number] = [0, 0];

function perimeterPoint(s: number, L: number, T: number, R: number, B: number): [number, number] {
    const W = R - L;
    const H = B - T;
    const P = 2 * (W + H);
    let p = ((s % P) + P) % P;
    if (p <= W) {
        PT[0] = L + p;
        PT[1] = T;
        return PT;
    }
    p -= W;
    if (p <= H) {
        PT[0] = R;
        PT[1] = T + p;
        return PT;
    }
    p -= H;
    if (p <= W) {
        PT[0] = R - p;
        PT[1] = B;
        return PT;
    }
    p -= W;
    PT[0] = L;
    PT[1] = B - p;
    return PT;
}

/** Corner parameters strictly inside the walk from `s0` over `span` in direction `dir`, in travel order. */
function cornerOrder(s0: number, span: number, dir: number, corners: number[], P: number): number[] {
    const out: { s: number; d: number }[] = [];
    for (const c of corners) {
        const d = dir === 1 ? (((c - s0) % P) + P) % P : (((s0 - c) % P) + P) % P;
        if (d > CORNER && d < span - CORNER) out.push({ s: c, d });
    }
    out.sort((a, b) => a.d - b.d);
    return out.map((o) => o.s);
}
