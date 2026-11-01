import { describe, expect, test } from 'bun:test';
import {
    BOARD_AREA,
    LANES_Y,
    LOGICAL_H,
    LOGICAL_W,
    QUEUE_AREA,
    VISIBLE_PODS,
    cellAt,
    cellCenter,
    columnAt,
    computeLayout,
    podSlot,
} from '@game/layout';

const make = (width: number, height: number, columns = 4, lanes = 3) => computeLayout({ width, height, columns, lanes });

describe('layout', () => {
    test('cell size is floor(680 / max(W, H))', () => {
        expect(make(10, 10).board.cell).toBe(68);
        expect(make(40, 40).board.cell).toBe(17);
        expect(make(48, 48).board.cell).toBe(14);
        expect(make(30, 12).board.cell).toBe(22);
        expect(make(7, 9).board.cell).toBe(75);
    });

    test('board is centered in its area and never leaves it', () => {
        for (const [w, h] of [[10, 10], [40, 40], [48, 20], [3, 48], [1, 1], [13, 7]] as const) {
            const { board } = make(w, h);
            expect(board.rect.w).toBe(board.cell * w);
            expect(board.rect.h).toBe(board.cell * h);
            expect(board.rect.x).toBeGreaterThanOrEqual(BOARD_AREA.x);
            expect(board.rect.y).toBeGreaterThanOrEqual(BOARD_AREA.y);
            expect(board.rect.x + board.rect.w).toBeLessThanOrEqual(BOARD_AREA.x + BOARD_AREA.w);
            expect(board.rect.y + board.rect.h).toBeLessThanOrEqual(BOARD_AREA.y + BOARD_AREA.h);
            const left = board.rect.x - BOARD_AREA.x;
            const right = BOARD_AREA.x + BOARD_AREA.w - (board.rect.x + board.rect.w);
            expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
        }
    });

    test('cellCenter / cellAt round trip, including out-of-grid exit points', () => {
        const l = make(10, 6);
        for (const [cx, cy] of [[0, 0], [9, 5], [4, 3]] as const) {
            const c = cellCenter(l, cx, cy);
            expect(cellAt(l, c.x, c.y)).toEqual({ x: cx, y: cy });
        }
        const outside = cellCenter(l, -1, 2);
        expect(outside.x).toBeLessThan(l.board.rect.x);
        expect(cellAt(l, outside.x, outside.y)).toBe(null);
    });

    test('lane slots are evenly spaced, centered, inside the screen, and inside the lanes row', () => {
        for (const lanes of [1, 2, 3, 5, 8]) {
            const { lanes: ln } = make(10, 10, 4, lanes);
            expect(ln.centers).toHaveLength(lanes);
            expect(ln.y).toBe(LANES_Y);
            ln.rects.forEach((r, i) => {
                expect(r.x).toBeGreaterThanOrEqual(0);
                expect(r.x + r.w).toBeLessThanOrEqual(LOGICAL_W);
                expect(ln.centers[i]).toBeCloseTo(r.x + r.w / 2);
                if (i > 0) expect(r.x).toBeGreaterThan(ln.rects[i - 1]!.x + ln.rects[i - 1]!.w - 1);
            });
            const first = ln.rects[0]!;
            const last = ln.rects[lanes - 1]!;
            expect(Math.abs(first.x - (LOGICAL_W - (last.x + last.w)))).toBeLessThanOrEqual(1);
        }
    });

    test('queue columns tile the width, and hit rects do not overlap', () => {
        for (const cols of [1, 3, 4, 8, 10]) {
            const { queue } = make(10, 10, cols);
            expect(queue.centers).toHaveLength(cols);
            expect(queue.podW).toBeLessThanOrEqual(queue.colW);
            queue.hitRects.forEach((r, i) => {
                expect(r.y).toBe(QUEUE_AREA.y);
                expect(r.x).toBeGreaterThanOrEqual(0);
                expect(r.x + r.w).toBeLessThanOrEqual(LOGICAL_W);
                if (i > 0) expect(r.x).toBeCloseTo(queue.hitRects[i - 1]!.x + queue.hitRects[i - 1]!.w);
            });
        }
    });

    test('pod slots go down the screen, shrink after the front, and fit above the bottom edge', () => {
        const l = make(10, 10, 5);
        const { queue } = l;
        expect(queue.slotY).toHaveLength(VISIBLE_PODS);
        for (let i = 1; i < VISIBLE_PODS; i++) expect(queue.slotY[i]!).toBeGreaterThan(queue.slotY[i - 1]!);
        expect(queue.slotScale[0]).toBe(1);
        expect(queue.slotScale[1]!).toBeLessThan(1);
        const lastBottom = queue.slotY[VISIBLE_PODS - 1]! + (queue.podH * queue.slotScale[VISIBLE_PODS - 1]!) / 2;
        expect(lastBottom).toBeLessThan(queue.badgeY);
        expect(queue.badgeY).toBeLessThan(LOGICAL_H);
        const firstTop = queue.slotY[0]! - queue.podH / 2;
        expect(firstTop).toBeGreaterThanOrEqual(QUEUE_AREA.y);
    });

    test('columnAt finds the column under a point and ignores points above the queue', () => {
        const l = make(10, 10, 4);
        for (let c = 0; c < 4; c++) {
            expect(columnAt(l, l.queue.centers[c]!, 1000)).toBe(c);
            expect(columnAt(l, l.queue.centers[c]!, 1270)).toBe(c);
        }
        expect(columnAt(l, 360, 900)).toBe(-1);
        expect(columnAt(l, 2, 1000)).toBe(-1);
    });

    test('podSlot clamps deep pods to the spawn slot below the window', () => {
        const l = make(10, 10, 4);
        expect(podSlot(l, 2, 0).y).toBe(l.queue.slotY[0]!);
        expect(podSlot(l, 2, 3).y).toBe(l.queue.slotY[3]!);
        expect(podSlot(l, 2, 4).y).toBe(l.queue.spawnY);
        expect(podSlot(l, 2, 99).y).toBe(l.queue.spawnY);
        expect(podSlot(l, 1, 0).x).toBe(l.queue.centers[1]!);
    });

    test('rejects degenerate input', () => {
        expect(() => make(0, 5)).toThrow();
        expect(() => make(5, 5, 0)).toThrow();
        expect(() => make(5, 5, 3, 0)).toThrow();
    });
});
