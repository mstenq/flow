/** Tiny vector glyphs drawn with Graphics (no emoji, so they never depend on font coverage). */
import type { GameObjects } from 'phaser';

/** A key: ring bow at the left, shaft and two teeth to the right. `size` is the glyph width. */
export function drawKeyGlyph(g: GameObjects.Graphics, cx: number, cy: number, size: number, color: number, hole: number): void {
    const r = size * 0.22;
    const bx = cx - size * 0.28;
    const shaftH = Math.max(2, size * 0.12);
    g.fillStyle(color, 1);
    g.fillCircle(bx, cy, r);
    g.fillRect(bx, cy - shaftH / 2, size * 0.7, shaftH);
    g.fillRect(cx + size * 0.28, cy, shaftH, size * 0.2);
    g.fillRect(cx + size * 0.14, cy, shaftH, size * 0.14);
    g.fillStyle(hole, 1);
    g.fillCircle(bx, cy, r * 0.45);
}

/** A padlock: body and shackle. `size` is the body width. */
export function drawLockGlyph(g: GameObjects.Graphics, cx: number, cy: number, size: number, color: number): void {
    const bodyH = size * 0.62;
    const top = cy - bodyH / 2 + size * 0.12;
    g.fillStyle(color, 1);
    g.fillRoundedRect(cx - size / 2, top, size, bodyH, Math.max(2, size * 0.1));
    const sw = Math.max(2, size * 0.14);
    g.lineStyle(sw, color, 1);
    g.beginPath();
    g.arc(cx, top, size * 0.28, Math.PI, 0, false);
    g.strokePath();
}

/** Two interlocked rings. `size` is the total width. */
export function drawLinkGlyph(g: GameObjects.Graphics, cx: number, cy: number, size: number, color: number, alpha = 1): void {
    const r = size * 0.28;
    g.lineStyle(Math.max(2, size * 0.14), color, alpha);
    g.strokeCircle(cx - r * 0.7, cy, r);
    g.strokeCircle(cx + r * 0.7, cy, r);
}
