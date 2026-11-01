/**
 * Procedural FX textures, drawn once with Canvas2D into the (game-global) texture manager.
 * All are white/grey so they can be tinted per color.
 */
import type { Scene } from 'phaser';

export const TEX = {
    glow: 'fx-glow',
    blob: 'fx-blob',
    dot: 'fx-dot',
    spark: 'fx-spark',
    ring: 'fx-ring',
    shard: 'fx-shard',
    star4: 'fx-star4',
    starsA: 'fx-stars-a',
    starsB: 'fx-stars-b',
    scan: 'fx-scan',
} as const;

type Draw = (ctx: CanvasRenderingContext2D, w: number, h: number) => void;

function make(scene: Scene, key: string, w: number, h: number, draw: Draw): void {
    if (scene.textures.exists(key)) return;
    const tex = scene.textures.createCanvas(key, w, h);
    if (!tex) return;
    draw(tex.context, w, h);
    tex.refresh();
}

function radial(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, stops: [number, string][]): void {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    for (const [at, color] of stops) g.addColorStop(at, color);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
}

/** Deterministic tiny PRNG so star textures look the same every run. */
function prng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

function stars(ctx: CanvasRenderingContext2D, w: number, h: number, count: number, seed: number, maxR: number): void {
    const rnd = prng(seed);
    for (let i = 0; i < count; i++) {
        const x = rnd() * w;
        const y = rnd() * h;
        const r = 0.4 + rnd() * maxR;
        const a = 0.25 + rnd() * 0.75;
        const tint = rnd();
        const color = tint < 0.15 ? '180,220,255' : tint < 0.25 ? '255,190,250' : '255,255,255';
        radial(ctx, x, y, r * 2.4, [
            [0, `rgba(${color},${a})`],
            [0.35, `rgba(${color},${a * 0.5})`],
            [1, `rgba(${color},0)`],
        ]);
    }
}

export function ensureFxTextures(scene: Scene): void {
    make(scene, TEX.glow, 64, 64, (ctx) =>
        radial(ctx, 32, 32, 32, [
            [0, 'rgba(255,255,255,1)'],
            [0.25, 'rgba(255,255,255,0.55)'],
            [0.6, 'rgba(255,255,255,0.15)'],
            [1, 'rgba(255,255,255,0)'],
        ]),
    );
    // Goo blob: hot core with a soft skirt (reads as a liquid bead under bloom).
    make(scene, TEX.blob, 32, 32, (ctx) =>
        radial(ctx, 16, 16, 16, [
            [0, 'rgba(255,255,255,1)'],
            [0.3, 'rgba(255,255,255,0.95)'],
            [0.5, 'rgba(255,255,255,0.45)'],
            [0.75, 'rgba(255,255,255,0.12)'],
            [1, 'rgba(255,255,255,0)'],
        ]),
    );
    make(scene, TEX.dot, 16, 16, (ctx) =>
        radial(ctx, 8, 8, 8, [
            [0, 'rgba(255,255,255,1)'],
            [0.4, 'rgba(255,255,255,0.6)'],
            [1, 'rgba(255,255,255,0)'],
        ]),
    );
    make(scene, TEX.spark, 32, 8, (ctx, w, h) => {
        const g = ctx.createLinearGradient(0, 0, w, 0);
        g.addColorStop(0, 'rgba(255,255,255,0)');
        g.addColorStop(0.7, 'rgba(255,255,255,0.8)');
        g.addColorStop(1, 'rgba(255,255,255,1)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(w / 2, h / 2, w / 2, h / 2 - 1, 0, 0, Math.PI * 2);
        ctx.fill();
    });
    make(scene, TEX.ring, 128, 128, (ctx) => {
        const g = ctx.createRadialGradient(64, 64, 40, 64, 64, 64);
        g.addColorStop(0, 'rgba(255,255,255,0)');
        g.addColorStop(0.7, 'rgba(255,255,255,0.25)');
        g.addColorStop(0.88, 'rgba(255,255,255,1)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, 128, 128);
    });
    make(scene, TEX.shard, 16, 16, (ctx) => {
        ctx.fillStyle = 'rgba(255,255,255,1)';
        ctx.beginPath();
        ctx.moveTo(8, 0);
        ctx.lineTo(15, 13);
        ctx.lineTo(3, 16);
        ctx.closePath();
        ctx.fill();
    });
    make(scene, TEX.star4, 48, 48, (ctx) => {
        radial(ctx, 24, 24, 10, [
            [0, 'rgba(255,255,255,1)'],
            [1, 'rgba(255,255,255,0)'],
        ]);
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        for (const [dx, dy] of [
            [1, 0],
            [0, 1],
        ]) {
            ctx.beginPath();
            ctx.moveTo(24 - dx * 24, 24 - dy * 24);
            ctx.lineTo(24 + dy * 2.2, 24 + dx * 2.2);
            ctx.lineTo(24 + dx * 24, 24 + dy * 24);
            ctx.lineTo(24 - dy * 2.2, 24 - dx * 2.2);
            ctx.closePath();
            ctx.fill();
        }
    });
    make(scene, TEX.starsA, 256, 256, (ctx, w, h) => stars(ctx, w, h, 70, 7, 0.9));
    make(scene, TEX.starsB, 256, 256, (ctx, w, h) => stars(ctx, w, h, 22, 31, 1.6));
    make(scene, TEX.scan, 4, 4, (ctx) => {
        ctx.fillStyle = 'rgba(255,255,255,1)';
        ctx.fillRect(0, 0, 4, 2);
    });
}

/**
 * Board tile for a given cell size: rounded, 1px gap, soft inner gradient with a bright core.
 * Returns the texture key.
 */
export function ensureTileTexture(scene: Scene, cell: number): string {
    const key = `fx-tile-${cell}`;
    make(scene, key, cell, cell, (ctx, w) => {
        const gap = 1;
        const s = w - gap;
        const r = Math.max(1.5, s * 0.24);
        const o = gap / 2;
        ctx.save();
        roundRect(ctx, o, o, s, s, r);
        ctx.clip();
        const g = ctx.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, s * 0.72);
        g.addColorStop(0, 'rgb(255,255,255)');
        g.addColorStop(0.3, 'rgb(225,225,225)');
        g.addColorStop(0.75, 'rgb(150,150,150)');
        g.addColorStop(1, 'rgb(110,110,110)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, w);
        ctx.restore();
        if (s >= 10) {
            // Top rim highlight (glass edge).
            ctx.strokeStyle = 'rgba(255,255,255,0.55)';
            ctx.lineWidth = 1;
            roundRect(ctx, o + 0.5, o + 0.5, s - 1, s - 1, r);
            ctx.stroke();
        }
    });
    return key;
}

/** Small white "hot core" stamped additively over tiles. */
export function ensureTileCoreTexture(scene: Scene, cell: number): string {
    const key = `fx-tilecore-${cell}`;
    make(scene, key, cell, cell, (ctx, w) =>
        radial(ctx, w / 2, w / 2, w * 0.36, [
            [0, 'rgba(255,255,255,0.9)'],
            [0.5, 'rgba(255,255,255,0.35)'],
            [1, 'rgba(255,255,255,0)'],
        ]),
    );
    return key;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}
