/**
 * NeonGrid: a Geometry Wars style spring-mass grid behind everything, drawn as thin additive lines.
 * Each node is pulled back to its rest position and toward its neighbours; `applyImpulse` pushes nodes radially
 * (positive = outward shockwave, negative = implosion). The sim sleeps when the grid is at rest, and then the
 * grid is drawn as straight lines (cheap). Reduced effects: static grid, impulses ignored.
 */
import { BlendModes } from 'phaser';
import type { GameObjects, Scene } from 'phaser';
import { LOGICAL_H, LOGICAL_W } from '@game/layout';
import { DEPTH } from '../theme';
import { isReducedFx, onReducedFxChange } from '../fx/fxSettings';

const SPACING = 40;
const K_ANCHOR = 22;
const K_NEIGHBOR = 60;
const DAMPING = 5.5;
const MAX_OFFSET = 70;
const SLEEP_EPS = 0.04;
const LINE_COLOR = 0x5a3cff;
const MAJOR_COLOR = 0x2fd4ff;

export class NeonGrid {
    private readonly gfx: GameObjects.Graphics;
    private readonly cols: number;
    private readonly rows: number;
    private readonly ox: number;
    private readonly oy: number;
    private readonly dx: Float32Array;
    private readonly dy: Float32Array;
    private readonly vx: Float32Array;
    private readonly vy: Float32Array;
    private awake = true;
    private energy = 0;
    private enabled: boolean;
    private readonly offFx: () => void;

    constructor(scene: Scene) {
        this.cols = Math.ceil(LOGICAL_W / SPACING) + 1;
        this.rows = Math.ceil(LOGICAL_H / SPACING) + 1;
        this.ox = (LOGICAL_W - (this.cols - 1) * SPACING) / 2;
        this.oy = (LOGICAL_H - (this.rows - 1) * SPACING) / 2;
        const n = this.cols * this.rows;
        this.dx = new Float32Array(n);
        this.dy = new Float32Array(n);
        this.vx = new Float32Array(n);
        this.vy = new Float32Array(n);
        this.gfx = scene.add.graphics().setDepth(DEPTH.grid).setBlendMode(BlendModes.ADD);
        this.enabled = !isReducedFx();
        this.offFx = onReducedFxChange((reduced) => {
            this.enabled = !reduced;
            if (reduced) this.reset();
        });
        this.draw();
    }

    /** Radial push at (x, y). `force` is px/s of velocity at the center; negative pulls inward. */
    applyImpulse(x: number, y: number, force: number, radius: number): void {
        if (!this.enabled) return;
        const r2 = radius * radius;
        const c0 = Math.max(1, Math.floor((x - radius - this.ox) / SPACING));
        const c1 = Math.min(this.cols - 2, Math.ceil((x + radius - this.ox) / SPACING));
        const r0 = Math.max(1, Math.floor((y - radius - this.oy) / SPACING));
        const r1 = Math.min(this.rows - 2, Math.ceil((y + radius - this.oy) / SPACING));
        for (let r = r0; r <= r1; r++) {
            for (let c = c0; c <= c1; c++) {
                const i = r * this.cols + c;
                const px = this.ox + c * SPACING + this.dx[i]! - x;
                const py = this.oy + r * SPACING + this.dy[i]! - y;
                const d2 = px * px + py * py;
                if (d2 >= r2) continue;
                const d = Math.sqrt(d2) || 1;
                const fall = 1 - d / radius;
                const f = force * fall * fall;
                this.vx[i] = this.vx[i]! + (px / d) * f;
                this.vy[i] = this.vy[i]! + (py / d) * f;
            }
        }
        this.awake = true;
    }

    update(dtMs: number): void {
        if (!this.awake) return;
        const dt = Math.min(0.033, dtMs / 1000);
        const steps = dt > 0.017 ? 2 : 1;
        const h = dt / steps;
        for (let s = 0; s < steps; s++) this.step(h);
        if (this.energy < SLEEP_EPS) {
            this.reset();
            return;
        }
        this.draw();
    }

    destroy(): void {
        this.offFx();
        this.gfx.destroy();
    }

    private reset(): void {
        this.dx.fill(0);
        this.dy.fill(0);
        this.vx.fill(0);
        this.vy.fill(0);
        this.awake = false;
        this.energy = 0;
        this.draw();
    }

    private step(h: number): void {
        const { cols, rows, dx, dy, vx, vy } = this;
        let energy = 0;
        for (let r = 1; r < rows - 1; r++) {
            for (let c = 1; c < cols - 1; c++) {
                const i = r * cols + c;
                const x = dx[i]!;
                const y = dy[i]!;
                const lx = dx[i - 1]! + dx[i + 1]! + dx[i - cols]! + dx[i + cols]! - 4 * x;
                const ly = dy[i - 1]! + dy[i + 1]! + dy[i - cols]! + dy[i + cols]! - 4 * y;
                let ax = -K_ANCHOR * x + K_NEIGHBOR * lx - DAMPING * vx[i]!;
                let ay = -K_ANCHOR * y + K_NEIGHBOR * ly - DAMPING * vy[i]!;
                ax = vx[i]! + ax * h;
                ay = vy[i]! + ay * h;
                vx[i] = ax;
                vy[i] = ay;
                energy += Math.abs(ax) + Math.abs(ay) + Math.abs(x) + Math.abs(y);
            }
        }
        for (let i = 0; i < dx.length; i++) {
            let x = dx[i]! + vx[i]! * h;
            let y = dy[i]! + vy[i]! * h;
            if (x > MAX_OFFSET) x = MAX_OFFSET;
            else if (x < -MAX_OFFSET) x = -MAX_OFFSET;
            if (y > MAX_OFFSET) y = MAX_OFFSET;
            else if (y < -MAX_OFFSET) y = -MAX_OFFSET;
            dx[i] = x;
            dy[i] = y;
        }
        this.energy = energy / dx.length;
    }

    private draw(): void {
        const g = this.gfx;
        const { cols, rows, ox, oy, dx, dy } = this;
        g.clear();
        const hot = Math.min(1, this.energy / 6);
        if (!this.awake) {
            for (let r = 0; r < rows; r++) {
                const major = r % 4 === 0;
                g.lineStyle(1, major ? MAJOR_COLOR : LINE_COLOR, major ? 0.12 : 0.09);
                g.lineBetween(0, oy + r * SPACING, LOGICAL_W, oy + r * SPACING);
            }
            for (let c = 0; c < cols; c++) {
                const major = c % 4 === 0;
                g.lineStyle(1, major ? MAJOR_COLOR : LINE_COLOR, major ? 0.12 : 0.09);
                g.lineBetween(ox + c * SPACING, 0, ox + c * SPACING, LOGICAL_H);
            }
            return;
        }
        for (let r = 0; r < rows; r++) {
            const major = r % 4 === 0;
            g.lineStyle(1, major ? MAJOR_COLOR : LINE_COLOR, (major ? 0.12 : 0.09) + hot * 0.12);
            g.beginPath();
            for (let c = 0; c < cols; c++) {
                const i = r * cols + c;
                const x = ox + c * SPACING + dx[i]!;
                const y = oy + r * SPACING + dy[i]!;
                if (c === 0) g.moveTo(x, y);
                else g.lineTo(x, y);
            }
            g.strokePath();
        }
        for (let c = 0; c < cols; c++) {
            const major = c % 4 === 0;
            g.lineStyle(1, major ? MAJOR_COLOR : LINE_COLOR, (major ? 0.12 : 0.09) + hot * 0.12);
            g.beginPath();
            for (let r = 0; r < rows; r++) {
                const i = r * cols + c;
                const x = ox + c * SPACING + dx[i]!;
                const y = oy + r * SPACING + dy[i]!;
                if (r === 0) g.moveTo(x, y);
                else g.lineTo(x, y);
            }
            g.strokePath();
        }
    }
}
