/**
 * Shared vector art for pods (queue + lanes): glass capsule, color-blind glyphs, hex lock, dashed outlines,
 * lightning polylines. Pure Graphics drawing, no allocation beyond what Graphics itself does.
 */
import type { GameObjects } from 'phaser';
import type { ColorGlyph } from '@data/themeColors';
import { COLORS } from '../theme';
import type { PaletteArt } from '../theme';
import { drawPushyGlyph } from '../ui/glyphs';

export interface CapsuleStyle {
    /** Body fill (deep tint). */
    body: number;
    bodyAlpha: number;
    /** Rim light color. */
    rim: number;
    rimAlpha: number;
    rimWidth: number;
    /** Soft outer glow around the rim (0 = none). */
    glowAlpha: number;
}

export function capsuleRadius(w: number, h: number): number {
    return Math.min(w, h) * 0.26;
}

/** Glass capsule centered on (0,0) of the Graphics' own space, offset by (cx, cy). */
export function drawCapsule(g: GameObjects.Graphics, cx: number, cy: number, w: number, h: number, s: CapsuleStyle): void {
    const r = capsuleRadius(w, h);
    const x = cx - w / 2;
    const y = cy - h / 2;
    if (s.glowAlpha > 0) {
        g.lineStyle(s.rimWidth + 7, s.rim, s.glowAlpha * 0.35);
        g.strokeRoundedRect(x - 1, y - 1, w + 2, h + 2, r + 1);
        g.lineStyle(s.rimWidth + 3, s.rim, s.glowAlpha * 0.6);
        g.strokeRoundedRect(x, y, w, h, r);
    }
    g.fillStyle(s.body, s.bodyAlpha);
    g.fillRoundedRect(x, y, w, h, r);
    g.lineStyle(s.rimWidth, s.rim, s.rimAlpha);
    g.strokeRoundedRect(x, y, w, h, r);
}

/** Glass reflections: a vertical sheen on the left and a short highlight at the top. */
export function drawGlassSheen(g: GameObjects.Graphics, cx: number, cy: number, w: number, h: number, alpha = 1): void {
    const r = capsuleRadius(w, h);
    g.fillStyle(0xffffff, 0.09 * alpha);
    g.fillRoundedRect(cx - w / 2 + w * 0.1, cy - h / 2 + r * 0.55, w * 0.1, h - r * 1.1, w * 0.05);
    g.fillStyle(0xffffff, 0.22 * alpha);
    g.fillRoundedRect(cx - w * 0.22, cy - h / 2 + 3, w * 0.44, Math.max(2, h * 0.035), 2);
}

type Pt = readonly [number, number];

function fillPoly(g: GameObjects.Graphics, pts: readonly Pt[]): void {
    g.beginPath();
    pts.forEach(([x, y], i) => (i === 0 ? g.moveTo(x, y) : g.lineTo(x, y)));
    g.closePath();
    g.fillPath();
}

function starPts(cx: number, cy: number, ro: number, ri: number): Pt[] {
    const pts: Pt[] = [];
    for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const rr = i % 2 === 0 ? ro : ri;
        pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
    }
    return pts;
}

function hexPts(cx: number, cy: number, r: number): Pt[] {
    return Array.from({ length: 6 }, (_, i): Pt => [cx + Math.cos((i * Math.PI) / 3) * r, cy + Math.sin((i * Math.PI) / 3) * r]);
}

/** `n + 1` points along a circular arc from angle `a0` to `a1` (radians, either direction). */
function arcPts(cx: number, cy: number, r: number, a0: number, a1: number, n: number): Pt[] {
    return Array.from({ length: n + 1 }, (_, i): Pt => {
        const a = a0 + ((a1 - a0) * i) / n;
        return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
    });
}

/** Points along a quadratic curve from `p0` (excluded) through control `c` to `p1` (included). */
function quadPts(p0: Pt, c: Pt, p1: Pt, n: number): Pt[] {
    return Array.from({ length: n }, (_, i): Pt => {
        const t = (i + 1) / n;
        const u = 1 - t;
        return [u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1]];
    });
}

/** Crescent moon (horns to the right): the outer circle minus an offset circle, centered on its bounding box. */
function moonPts(cx: number, cy: number, r: number): Pt[] {
    const R = r * 0.92;
    const d = R * 0.7;
    const h = Math.sqrt(R * R - (d / 2) * (d / 2));
    const ox = cx + (R - d / 2) / 2;
    const t1 = Math.atan2(-h, d / 2);
    const t2 = Math.atan2(h, d / 2);
    const p2 = Math.atan2(h, -d / 2);
    return [...arcPts(ox, cy, R, t1, t2 - Math.PI * 2, 16), ...arcPts(ox + d, cy, R, p2, Math.PI * 2 - p2, 12)];
}

/**
 * Color-blind glyph (see `ColorGlyph`: 20 solid shapes), radius `r`. Coordinates below are in units of `r` around
 * the center; every shape stays within about ±r.
 */
export function drawGlyph(g: GameObjects.Graphics, shape: ColorGlyph, cx: number, cy: number, r: number, color: number, alpha = 1): void {
    g.fillStyle(color, alpha);
    const p = (x: number, y: number): Pt => [cx + x * r, cy + y * r];
    switch (shape) {
        case 'circle':
            g.fillCircle(cx, cy, r * 0.85);
            return;
        case 'triangle':
            g.fillTriangle(cx, cy - r, cx + r * 0.95, cy + r * 0.75, cx - r * 0.95, cy + r * 0.75);
            return;
        case 'square':
            g.fillRect(cx - r * 0.75, cy - r * 0.75, r * 1.5, r * 1.5);
            return;
        case 'diamond':
            fillPoly(g, [p(0, -1), p(0.85, 0), p(0, 1), p(-0.85, 0)]);
            return;
        case 'hex':
            fillPoly(g, hexPts(cx, cy, r * 0.95));
            return;
        case 'star':
            fillPoly(g, starPts(cx, cy, r * 1.05, r * 0.46));
            return;
        case 'plus': {
            const t = r * 0.38;
            g.fillRect(cx - t, cy - r, t * 2, r * 2);
            g.fillRect(cx - r, cy - t, r * 2, t * 2);
            return;
        }
        case 'x': {
            const t = r * 0.3;
            const e = r * 0.92;
            fillPoly(g, [[cx - e, cy - e + t * 1.4], [cx - e + t * 1.4, cy - e], [cx + e, cy + e - t * 1.4], [cx + e - t * 1.4, cy + e]]);
            fillPoly(g, [[cx + e, cy - e + t * 1.4], [cx + e - t * 1.4, cy - e], [cx - e, cy + e - t * 1.4], [cx - e + t * 1.4, cy + e]]);
            return;
        }
        case 'half':
            fillPoly(g, arcPts(cx, cy + r * 0.48, r * 0.98, Math.PI, Math.PI * 2, 16));
            return;
        case 'heart':
            g.fillCircle(cx - r * 0.45, cy - r * 0.35, r * 0.5);
            g.fillCircle(cx + r * 0.45, cy - r * 0.35, r * 0.5);
            fillPoly(g, [p(-0.93, -0.19), p(0.93, -0.19), p(0, 0.86)]);
            return;
        case 'spade':
            g.fillCircle(cx - r * 0.45, cy + r * 0.12, r * 0.47);
            g.fillCircle(cx + r * 0.45, cy + r * 0.12, r * 0.47);
            fillPoly(g, [p(0, -0.98), p(0.9, 0), p(-0.9, 0)]);
            fillPoly(g, [p(0, 0.2), p(0.34, 0.98), p(-0.34, 0.98)]);
            return;
        case 'club':
            g.fillCircle(cx, cy - r * 0.5, r * 0.4);
            g.fillCircle(cx - r * 0.48, cy + r * 0.1, r * 0.4);
            g.fillCircle(cx + r * 0.48, cy + r * 0.1, r * 0.4);
            g.fillCircle(cx, cy, r * 0.3);
            fillPoly(g, [p(0, 0.1), p(0.36, 0.98), p(-0.36, 0.98)]);
            return;
        case 'blossom':
            // Five round petals that just touch (so the rim stays scalloped), over a solid center.
            for (let k = 0; k < 5; k++) {
                const a = -Math.PI / 2 + (k * Math.PI * 2) / 5;
                g.fillCircle(cx + Math.cos(a) * r * 0.58, cy + Math.sin(a) * r * 0.58, r * 0.37);
            }
            g.fillCircle(cx, cy, r * 0.42);
            return;
        case 'moon':
            fillPoly(g, moonPts(cx, cy, r));
            return;
        case 'gem':
            fillPoly(g, [p(-0.55, -0.72), p(0.55, -0.72), p(0.98, -0.22), p(0, 0.92), p(-0.98, -0.22)]);
            return;
        case 'note': {
            // Two beamed eighth notes (♫): heads at the bottom left of each stem, beam slanting up to the right.
            const t = Math.max(1.2, r * 0.2);
            const bh = Math.max(1.4, r * 0.34);
            g.fillEllipse(cx - r * 0.5, cy + r * 0.62, r * 0.76, r * 0.56);
            g.fillEllipse(cx + r * 0.5, cy + r * 0.46, r * 0.76, r * 0.56);
            const lx = cx - r * 0.12;
            const rx = cx + r * 0.88;
            g.fillRect(lx - t, cy - r * 0.62, t, r * 1.24);
            g.fillRect(rx - t, cy - r * 0.84, t, r * 1.3);
            fillPoly(g, [[lx - t, cy - r * 0.62], [rx, cy - r * 0.84], [rx, cy - r * 0.84 + bh], [lx - t, cy - r * 0.62 + bh]]);
            return;
        }
        case 'radioactive':
            // Trefoil: three 60° blades (up-left, up-right, down) around a center dot.
            for (const deg of [-150, -30, 90]) {
                const a = (deg * Math.PI) / 180;
                const w = Math.PI / 6;
                fillPoly(g, [...arcPts(cx, cy, r, a - w, a + w, 8), ...arcPts(cx, cy, r * 0.36, a + w, a - w, 4)]);
            }
            g.fillCircle(cx, cy, r * 0.2);
            return;
        case 'crown':
            fillPoly(g, [p(-0.9, 0.72), p(0.9, 0.72), p(0.92, -0.5), p(0.45, -0.02), p(0, -0.68), p(-0.45, -0.02), p(-0.92, -0.5)]);
            g.fillCircle(cx - r * 0.92, cy - r * 0.56, r * 0.17);
            g.fillCircle(cx, cy - r * 0.74, r * 0.17);
            g.fillCircle(cx + r * 0.92, cy - r * 0.56, r * 0.17);
            return;
        case 'flame': {
            // Round base, tip leaning right, one small tongue on the left (so it never reads as a drop).
            const tip = p(0.12, -1);
            const notch = p(-0.22, -0.28);
            const tongue = p(-0.5, -0.62);
            const right = p(0.6, 0.35);
            g.fillCircle(cx, cy + r * 0.35, r * 0.6);
            fillPoly(g, [
                right,
                ...quadPts(right, p(0.78, -0.3), tip, 8),
                ...quadPts(tip, p(-0.02, -0.5), notch, 5),
                tongue,
                ...quadPts(tongue, p(-0.78, -0.05), p(-0.6, 0.35), 6),
            ]);
            return;
        }
        case 'shield': {
            // Flat top, straight sides, curving in to a point at the bottom.
            const rightHip = p(0.82, -0.1);
            const bottom = p(0, 0.98);
            fillPoly(g, [p(-0.82, -0.88), p(0.82, -0.88), rightHip, ...quadPts(rightHip, p(0.82, 0.55), bottom, 6), ...quadPts(bottom, p(-0.82, 0.55), p(-0.82, -0.1), 6)]);
            return;
        }
    }
}

/** Hexagon outline (pointy top). */
export function strokeHex(g: GameObjects.Graphics, cx: number, cy: number, r: number, width: number, color: number, alpha: number): void {
    g.lineStyle(width, color, alpha);
    g.beginPath();
    for (let i = 0; i < 6; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 3;
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
    }
    g.closePath();
    g.strokePath();
}

/** Dashed rounded-rect outline, centered at (cx, cy). */
export function strokeDashedRoundedRect(
    g: GameObjects.Graphics,
    cx: number,
    cy: number,
    w: number,
    h: number,
    r: number,
    dash: number,
    gap: number,
    width: number,
    color: number,
    alpha: number,
): void {
    g.lineStyle(width, color, alpha);
    const x0 = cx - w / 2;
    const y0 = cy - h / 2;
    const x1 = cx + w / 2;
    const y1 = cy + h / 2;
    // Straight edges only (corners left open reads as a "dashed" slot and stays cheap).
    dashLine(g, x0 + r, y0, x1 - r, y0, dash, gap);
    dashLine(g, x1, y0 + r, x1, y1 - r, dash, gap);
    dashLine(g, x1 - r, y1, x0 + r, y1, dash, gap);
    dashLine(g, x0, y1 - r, x0, y0 + r, dash, gap);
    // Corner arcs as single short dashes.
    g.beginPath();
    g.arc(x0 + r, y0 + r, r, Math.PI, Math.PI * 1.5);
    g.strokePath();
    g.beginPath();
    g.arc(x1 - r, y0 + r, r, Math.PI * 1.5, Math.PI * 2);
    g.strokePath();
    g.beginPath();
    g.arc(x1 - r, y1 - r, r, 0, Math.PI * 0.5);
    g.strokePath();
    g.beginPath();
    g.arc(x0 + r, y1 - r, r, Math.PI * 0.5, Math.PI);
    g.strokePath();
}

function dashLine(g: GameObjects.Graphics, ax: number, ay: number, bx: number, by: number, dash: number, gap: number): void {
    const len = Math.hypot(bx - ax, by - ay);
    if (len <= 0) return;
    const ux = (bx - ax) / len;
    const uy = (by - ay) / len;
    const step = dash + gap;
    const start = ((len % step) + gap) / 2;
    for (let d = start; d < len; d += step) {
        const e = Math.min(len, d + dash);
        g.lineBetween(ax + ux * d, ay + uy * d, ax + ux * e, ay + uy * e);
    }
}

const BOLT = new Float32Array(32);

/**
 * Jittering lightning polyline from A to B (`segments` kinks, max offset `amp`). Uses Math.random, so call it
 * on a timer (every ~50ms), not every frame, for a crackle rather than a blur.
 */
export function drawLightning(
    g: GameObjects.Graphics,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    segments: number,
    amp: number,
    color: number,
    width: number,
    alpha: number,
): void {
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const n = Math.min(segments, BOLT.length);
    for (let i = 1; i < n; i++) BOLT[i] = (Math.random() * 2 - 1) * amp * Math.sin((Math.PI * i) / n);
    for (let pass = 0; pass < 2; pass++) {
        g.lineStyle(pass === 0 ? width * 3.2 : width, pass === 0 ? color : 0xffffff, pass === 0 ? alpha * 0.3 : alpha);
        g.beginPath();
        g.moveTo(ax, ay);
        for (let i = 1; i < n; i++) {
            const t = i / n;
            g.lineTo(ax + dx * t + nx * BOLT[i]!, ay + dy * t + ny * BOLT[i]!);
        }
        g.lineTo(bx, by);
        g.strokePath();
    }
}

/** Hidden pod body: dark glass with a violet rim (the "?" label is a separate crisp text). */
export function drawHiddenPod(g: GameObjects.Graphics, w: number, h: number): void {
    drawCapsule(g, 0, 0, w, h, { body: 0x0d0a22, bodyAlpha: 0.92, rim: 0x6a5cff, rimAlpha: 0.8, rimWidth: 2.5, glowAlpha: 0.35 });
}

/** Locked pod body: amber glass, double hex and padlock (the "KEY A" caption is a separate text). */
export function drawLockedPod(g: GameObjects.Graphics, w: number, h: number): void {
    drawCapsule(g, 0, 0, w, h, { body: 0x140f06, bodyAlpha: 0.92, rim: COLORS.key, rimAlpha: 0.85, rimWidth: 2.5, glowAlpha: 0.45 });
    strokeHex(g, 0, -6, h * 0.3, 2.5, COLORS.key, 0.95);
    strokeHex(g, 0, -6, h * 0.3 + 5, 1, COLORS.key, 0.4);
    drawPadlock(g, 0, -6, h * 0.22, COLORS.key);
}

/** Revealed pod body: colored glass with a charge band and glyph (the capacity number is a separate text). */
export function drawColorPod(g: GameObjects.Graphics, w: number, h: number, art: PaletteArt | undefined, front: boolean): void {
    const core = art?.core ?? 0xffffff;
    drawCapsule(g, 0, 0, w, h, { body: art?.deep ?? 0x14102a, bodyAlpha: 0.94, rim: core, rimAlpha: 1, rimWidth: front ? 3 : 2.5, glowAlpha: front ? 1 : 0.6 });
    // Pilot charge: a thin band of liquid at the bottom so the color reads at a glance.
    g.fillStyle(core, 0.55);
    g.fillRoundedRect(-w / 2 + 6, h / 2 - 15, w - 12, 9, 4);
    drawGlassSheen(g, 0, 0, w, h);
    // Deeper pods are drawn smaller (scaled down), so their glyph is bigger to stay readable.
    const r = front ? 12 : 18;
    const m = front ? 11 : 8;
    if (art) drawGlyph(g, art.glyph, -w / 2 + r + m, -h / 2 + r + m, r, art.glow, 1);
}

export function drawPadlock(g: GameObjects.Graphics, cx: number, cy: number, size: number, color: number): void {
    const bodyW = size * 1.1;
    const bodyH = size * 0.8;
    g.fillStyle(color, 1);
    g.fillRoundedRect(cx - bodyW / 2, cy - bodyH / 2 + size * 0.2, bodyW, bodyH, 3);
    g.lineStyle(Math.max(2, size * 0.18), color, 1);
    g.beginPath();
    g.arc(cx, cy - bodyH / 2 + size * 0.2, size * 0.34, Math.PI, 0, false);
    g.strokePath();
    g.fillStyle(0x140f06, 1);
    g.fillCircle(cx, cy + size * 0.22, size * 0.12);
}

/** The two small rings that mark a linked pod. */
export function drawLinkRings(g: GameObjects.Graphics, cx: number, cy: number, size: number, color: number): void {
    const r = size * 0.28;
    g.lineStyle(Math.max(1.5, size * 0.13), color, 0.9);
    g.strokeCircle(cx - r * 0.7, cy, r);
    g.strokeCircle(cx + r * 0.7, cy, r);
}

/** Hot orange used for everything "pushy" (queue badge, drop flourish, intro card). */
export const PUSHY_COLOR = 0xff7a1f;

/** Where the pushy badge sits on a pod: top-right corner. */
export function pushyBadgeCenter(w: number, h: number): { x: number; y: number } {
    return { x: w / 2 - 24, y: -h / 2 + 24 };
}

/** Pushy badge: dark disc, orange ring, double chevron. `nudge` bobs the chevrons down (eager pulse). */
export function drawPushyBadge(g: GameObjects.Graphics, cx: number, cy: number, radius: number, nudge = 0, glow = 0): void {
    if (glow > 0) {
        g.fillStyle(PUSHY_COLOR, 0.25 * glow);
        g.fillCircle(cx, cy, radius * 1.35);
    }
    g.fillStyle(0x1a0a02, 0.92);
    g.fillCircle(cx, cy, radius);
    g.lineStyle(2.5, PUSHY_COLOR, 1);
    g.strokeCircle(cx, cy, radius);
    drawPushyGlyph(g, cx, cy, radius * 1.3, 0xffc890, 1, nudge);
}
