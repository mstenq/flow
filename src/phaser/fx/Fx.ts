/**
 * Shared one-shot effects for the play scene, all pooled:
 *   sparks (ADD dots), shards (spinning triangles with gravity), shockwave rings, glow flashes,
 *   key flights (curved, with a sparkle trail), fireworks, and short-lived UI-camera text pops.
 * `busyCount` > 0 while a gameplay-relevant animation (key flight) is running, so PlaybackRunner can gate on it.
 */
import { BlendModes } from 'phaser';
import type { GameObjects, Scene } from 'phaser';
import type { Point2 } from '@game/layout';
import { DEPTH } from '../theme';
import { drawKeyGlyph } from '../ui/glyphs';
import { TEX } from './textures';
import { particleScale } from './fxSettings';

const KEY_TEX = 'fx-key';
const KEY_GOLD = 0xffe600;
const MAX_SPARKS = 900;
const MAX_SHARDS = 260;
const RING_POOL = 24;
const FLASH_POOL = 40;
const KEY_POOL = 6;

type Spark = GameObjects.Particles.Particle & { baseScale: number };

interface Ring {
    img: GameObjects.Image;
    life: number;
    total: number;
    from: number;
    to: number;
    alpha: number;
}

interface Flight {
    img: GameObjects.Image;
    glow: GameObjects.Image;
    t: number;
    duration: number;
    ax: number;
    ay: number;
    cx: number;
    cy: number;
    bx: number;
    by: number;
    emitAcc: number;
    onArrive: (() => void) | null;
}

export interface BurstOptions {
    count: number;
    speedMin?: number;
    speedMax?: number;
    /** Angle range in degrees (default full circle). */
    angleMin?: number;
    angleMax?: number;
    scale?: number;
    life?: number;
    gravity?: number;
}

export class Fx {
    private readonly sparks: GameObjects.Particles.ParticleEmitter;
    private readonly shards: GameObjects.Particles.ParticleEmitter;
    private readonly rings: Ring[] = [];
    private readonly flashes: Ring[] = [];
    private readonly flights: Flight[] = [];
    private readonly freeFlights: Flight[] = [];
    private emitColor = 0xffffff;
    private emitScale = 1;
    private emitLife = 600;
    private emitSpeedMin = 60;
    private emitSpeedMax = 260;
    private emitAngleMin = 0;
    private emitAngleMax = 360;
    private emitGravity = 0;

    constructor(private readonly scene: Scene) {
        ensureKeyTexture(scene);
        const scale = particleScale();
        this.sparks = scene.add.particles(0, 0, TEX.dot, {
            emitting: false,
            blendMode: 'ADD',
            maxAliveParticles: Math.round(MAX_SPARKS * scale),
            lifespan: { onEmit: () => this.emitLife * (0.6 + Math.random() * 0.6) },
            speed: { onEmit: () => this.emitSpeedMin + Math.random() * (this.emitSpeedMax - this.emitSpeedMin) },
            angle: { onEmit: () => this.emitAngleMin + Math.random() * (this.emitAngleMax - this.emitAngleMin) },
            scale: { onEmit: () => this.emitScale * (0.6 + Math.random() * 0.6), onUpdate: (p, _k, t) => (p as Spark).baseScale * (1 - t) },
            alpha: { start: 1, end: 0 },
            tint: { onEmit: () => this.emitColor, onUpdate: (_p, _k, _t, v) => v },
            accelerationY: { onEmit: () => this.emitGravity },
            emitCallback: (p: GameObjects.Particles.Particle) => {
                (p as Spark).baseScale = p.scaleX;
            },
        });
        this.sparks.setDepth(DEPTH.fx);
        this.shards = scene.add.particles(0, 0, TEX.shard, {
            emitting: false,
            blendMode: 'ADD',
            maxAliveParticles: Math.round(MAX_SHARDS * scale),
            lifespan: { min: 600, max: 1100 },
            speed: { onEmit: () => this.emitSpeedMin + Math.random() * (this.emitSpeedMax - this.emitSpeedMin) },
            angle: { onEmit: () => this.emitAngleMin + Math.random() * (this.emitAngleMax - this.emitAngleMin) },
            rotate: { onEmit: () => Math.random() * 360, onUpdate: (_p, _k, _t, v) => v + 7 },
            scale: { onEmit: () => this.emitScale * (0.5 + Math.random() * 0.9), onUpdate: (_p, _k, _t, v) => v },
            alpha: { start: 1, end: 0, ease: 'Quad.easeIn' },
            tint: { onEmit: () => this.emitColor, onUpdate: (_p, _k, _t, v) => v },
            gravityY: 900,
        });
        this.shards.setDepth(DEPTH.fx);
        for (let i = 0; i < RING_POOL; i++) this.rings.push(this.makeRing(TEX.ring));
        for (let i = 0; i < FLASH_POOL; i++) this.flashes.push(this.makeRing(TEX.glow));
        for (let i = 0; i < KEY_POOL; i++) this.freeFlights.push(this.makeFlight());
    }

    get busyCount(): number {
        return this.flights.length;
    }

    burst(x: number, y: number, color: number, opts: BurstOptions): void {
        const count = Math.max(1, Math.round(opts.count * particleScale()));
        this.emitColor = color;
        this.emitScale = opts.scale ?? 0.6;
        this.emitLife = opts.life ?? 600;
        this.emitSpeedMin = opts.speedMin ?? 60;
        this.emitSpeedMax = opts.speedMax ?? 260;
        this.emitAngleMin = opts.angleMin ?? 0;
        this.emitAngleMax = opts.angleMax ?? 360;
        this.emitGravity = opts.gravity ?? 0;
        this.sparks.emitParticleAt(x, y, count);
    }

    shatter(x: number, y: number, color: number, count: number, speed = 320, scale = 0.9): void {
        this.emitColor = color;
        this.emitScale = scale;
        this.emitSpeedMin = speed * 0.35;
        this.emitSpeedMax = speed;
        this.emitAngleMin = 0;
        this.emitAngleMax = 360;
        this.shards.emitParticleAt(x, y, Math.max(1, Math.round(count * particleScale())));
    }

    /** Expanding shockwave ring. `radius` is the final radius in px. */
    ring(x: number, y: number, color: number, radius: number, ms = 450, alpha = 0.9, startRadius = 8): void {
        this.spawn(this.rings, x, y, color, startRadius / 52, radius / 52, ms, alpha);
    }

    /** Soft additive glow flash. `size` is the final diameter in px. */
    flash(x: number, y: number, color: number, size: number, ms = 220, alpha = 0.9): void {
        this.spawn(this.flashes, x, y, color, (size * 0.45) / 64, size / 64, ms, alpha);
    }

    /** Fireworks: several bursts in the given colors around the area. */
    fireworks(cx: number, cy: number, w: number, h: number, colors: readonly number[], shells: number): void {
        for (let i = 0; i < shells; i++) {
            const color = colors[i % colors.length]!;
            const x = cx + (Math.random() - 0.5) * w;
            const y = cy + (Math.random() - 0.5) * h;
            // All shells go up within ~1.5s so the show ends before the Result overlay.
            const delay = (i * 1500) / shells + Math.random() * 60;
            this.scene.time.delayedCall(delay, () => {
                this.flash(x, y, color, 260, 320, 0.9);
                this.ring(x, y, color, 120, 420, 0.7, 6);
                this.burst(x, y, color, { count: 56, speedMin: 160, speedMax: 520, scale: 1.0, life: 1100, gravity: 300 });
                this.burst(x, y, 0xffffff, { count: 14, speedMin: 40, speedMax: 220, scale: 0.7, life: 600 });
            });
        }
    }

    /** A crystal key flies from `from` to `to` on a curve, trailing gold sparkles. */
    keyFlight(from: Point2, to: Point2, onArrive: () => void, scale = 1): void {
        const f = this.freeFlights.pop() ?? this.makeFlight();
        const mx = (from.x + to.x) / 2;
        const my = (from.y + to.y) / 2;
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const len = Math.hypot(dx, dy) || 1;
        const bend = Math.min(220, len * 0.35) * (from.x < to.x ? -1 : 1);
        f.ax = from.x;
        f.ay = from.y;
        f.bx = to.x;
        f.by = to.y;
        f.cx = mx + (-dy / len) * bend;
        f.cy = my + (dx / len) * bend - 60;
        f.t = 0;
        f.duration = 520 + Math.min(300, len * 0.35);
        f.emitAcc = 0;
        f.onArrive = onArrive;
        f.img.setScale(scale).setVisible(true).setPosition(from.x, from.y);
        f.glow.setVisible(true).setPosition(from.x, from.y);
        this.flights.push(f);
        this.flash(from.x, from.y, KEY_GOLD, 90, 260);
        this.burst(from.x, from.y, KEY_GOLD, { count: 14, speedMin: 40, speedMax: 180, scale: 0.45, life: 450 });
    }

    update(dtMs: number): void {
        this.tickRings(this.rings, dtMs);
        this.tickRings(this.flashes, dtMs);
        this.tickFlights(dtMs);
    }

    clear(): void {
        for (const f of this.flights) this.releaseFlight(f);
        this.flights.length = 0;
    }

    destroy(): void {
        this.clear();
        this.sparks.destroy();
        this.shards.destroy();
        for (const r of this.rings) r.img.destroy();
        for (const r of this.flashes) r.img.destroy();
        for (const f of this.freeFlights) {
            f.img.destroy();
            f.glow.destroy();
        }
    }

    // ------------------------------------------------------------------ internals

    private makeRing(tex: string): Ring {
        const img = this.scene.add.image(0, 0, tex).setBlendMode(BlendModes.ADD).setDepth(DEPTH.fx).setVisible(false);
        return { img, life: 0, total: 1, from: 1, to: 1, alpha: 1 };
    }

    private spawn(pool: Ring[], x: number, y: number, color: number, from: number, to: number, ms: number, alpha: number): void {
        let r: Ring | undefined;
        for (const candidate of pool) {
            if (candidate.life <= 0) {
                r = candidate;
                break;
            }
        }
        if (!r) return;
        r.life = ms;
        r.total = ms;
        r.from = from;
        r.to = to;
        r.alpha = alpha;
        r.img.setPosition(x, y).setTint(color).setScale(from).setAlpha(alpha).setVisible(true);
    }

    private tickRings(pool: Ring[], dtMs: number): void {
        for (const r of pool) {
            if (r.life <= 0) continue;
            r.life -= dtMs;
            if (r.life <= 0) {
                r.img.setVisible(false);
                continue;
            }
            const t = 1 - r.life / r.total;
            const e = 1 - (1 - t) * (1 - t);
            r.img.setScale(r.from + (r.to - r.from) * e).setAlpha(r.alpha * (1 - t));
        }
    }

    private makeFlight(): Flight {
        const glow = this.scene.add.image(0, 0, TEX.glow).setBlendMode(BlendModes.ADD).setTint(KEY_GOLD).setScale(0.9).setAlpha(0.8).setDepth(DEPTH.fx).setVisible(false);
        const img = this.scene.add.image(0, 0, KEY_TEX).setDepth(DEPTH.fx + 0.1).setVisible(false);
        return { img, glow, t: 0, duration: 1, ax: 0, ay: 0, cx: 0, cy: 0, bx: 0, by: 0, emitAcc: 0, onArrive: null };
    }

    private releaseFlight(f: Flight): void {
        f.img.setVisible(false);
        f.glow.setVisible(false);
        f.onArrive = null;
        this.freeFlights.push(f);
    }

    private tickFlights(dtMs: number): void {
        for (let i = this.flights.length - 1; i >= 0; i--) {
            const f = this.flights[i]!;
            f.t += dtMs / f.duration;
            const t = Math.min(1, f.t);
            const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
            const u = 1 - e;
            const x = u * u * f.ax + 2 * u * e * f.cx + e * e * f.bx;
            const y = u * u * f.ay + 2 * u * e * f.cy + e * e * f.by;
            f.img.setPosition(x, y).setRotation(Math.sin(t * Math.PI * 3) * 0.5);
            f.glow.setPosition(x, y).setScale(0.8 + 0.3 * Math.sin(t * 30));
            f.emitAcc += dtMs;
            if (f.emitAcc > 22) {
                f.emitAcc = 0;
                this.burst(x, y, KEY_GOLD, { count: 2, speedMin: 10, speedMax: 50, scale: 0.4, life: 380 });
            }
            if (t < 1) continue;
            const done = f.onArrive;
            this.flights.splice(i, 1);
            this.releaseFlight(f);
            this.flash(x, y, KEY_GOLD, 160, 300);
            done?.();
        }
    }
}

function ensureKeyTexture(scene: Scene): void {
    if (scene.textures.exists(KEY_TEX)) return;
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(0x6a4a00, 1);
    g.fillCircle(14, 16, 9);
    drawKeyGlyph(g, 22, 16, 34, KEY_GOLD, 0x2a1a00);
    g.generateTexture(KEY_TEX, 44, 32);
    g.destroy();
}
