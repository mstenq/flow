import { describe, expect, test } from 'bun:test';
import { SELECT, TILE_W, clampScroll, hitRect, isTap, layoutSelect, nearestRect, scrollFromTrack, scrollThumb, scrollToCenter, visibleRange } from '@game/selectLayout';

describe('selectLayout', () => {
    test('two columns inside the margins', () => {
        const l = layoutSelect(5, 0);
        expect(l.campaign).toHaveLength(5);
        expect(l.campaign[0]!.x).toBe(SELECT.margin);
        expect(l.campaign[1]!.x + TILE_W).toBeCloseTo(720 - SELECT.margin);
        expect(l.campaign[2]!.y).toBeGreaterThan(l.campaign[0]!.y);
        expect(l.devTitleY).toBeNull();
    });

    test('dev section starts below the campaign', () => {
        const l = layoutSelect(3, 3);
        expect(l.devTitleY).not.toBeNull();
        expect(l.dev[0]!.y).toBeGreaterThan(l.campaign[2]!.y + SELECT.tileH);
        expect(l.contentHeight).toBeGreaterThan(l.dev[2]!.y + SELECT.tileH);
    });

    test('scroll clamps and centers', () => {
        expect(clampScroll(-50, 3000, 1000)).toBe(0);
        expect(clampScroll(5000, 3000, 1000)).toBe(2000);
        expect(clampScroll(10, 500, 1000)).toBe(0);
        const l = layoutSelect(12, 0);
        expect(scrollToCenter(l.campaign[0]!, l.contentHeight, 1000)).toBe(0);
        expect(scrollToCenter(l.campaign[11]!, l.contentHeight, 1000)).toBe(l.contentHeight - 1000);
    });

    test('hit testing and the tap threshold', () => {
        const l = layoutSelect(4, 0);
        const r = l.campaign[3]!;
        expect(hitRect(l.campaign, r.x + 5, r.y + 5)).toBe(3);
        expect(hitRect(l.campaign, 2, 2)).toBe(-1);
        expect(isTap(3, 4)).toBe(true);
        expect(isTap(30, 0)).toBe(false);
    });
});

describe('virtualization window', () => {
    const l = layoutSelect(400, 3);
    const all = [...l.campaign, ...l.dev];
    const stride = SELECT.tileH + SELECT.gapY;

    test('window math matches a brute-force scan everywhere', () => {
        for (let top = -500; top < l.contentHeight + 500; top += 137) {
            const bottom = top + 1800;
            const want = all.map((r, i) => (r.y + r.h >= top && r.y <= bottom ? i : -1)).filter((i) => i >= 0);
            const { start, end } = visibleRange(all, top, bottom);
            const got = Array.from({ length: end - start }, (_, k) => start + k);
            expect(got).toEqual(want);
        }
    });

    test('the window stays small no matter how long the list is', () => {
        const view = 1090;
        const overscan = stride;
        let most = 0;
        for (let scroll = 0; scroll <= l.contentHeight - view; scroll += 53) {
            const { start, end } = visibleRange(all, scroll - overscan, scroll + view + overscan);
            most = Math.max(most, end - start);
        }
        // (1090 + 2 * 358) / 358 rows, two columns, plus one partial row at each end.
        expect(most).toBeLessThanOrEqual(2 * Math.ceil((view + 2 * overscan) / stride) + 2);
        expect(most).toBeGreaterThan(8);
    });

    test('empty window, empty list, window past the ends', () => {
        expect(visibleRange([], 0, 100)).toEqual({ start: 0, end: 0 });
        expect(visibleRange(all, -5000, -4000)).toEqual({ start: 0, end: 0 });
        const past = visibleRange(all, l.contentHeight + 10, l.contentHeight + 900);
        expect(past.end - past.start).toBe(0);
    });

    test('a window shifted by one row recycles exactly one row of tiles', () => {
        const a = visibleRange(all, 3000, 4800);
        const b = visibleRange(all, 3000 + stride, 4800 + stride);
        expect(b.start - a.start).toBe(SELECT.cols);
        expect(b.end - a.end).toBe(SELECT.cols);
    });

    test('nearestRect and scroll-to-current at #250', () => {
        expect(nearestRect([], 0)).toBe(-1);
        expect(nearestRect(all, -100)).toBe(0);
        expect(nearestRect(all, 1e9)).toBe(all.length - 1);
        const cur = all[249]!;
        const scroll = scrollToCenter(cur, l.contentHeight, 1090);
        expect(nearestRect(all, scroll + 545)).toBe(248);
        const { start, end } = visibleRange(all, scroll, scroll + 1090);
        expect(start).toBeLessThanOrEqual(249);
        expect(end).toBeGreaterThan(249);
    });

    test('scrollbar thumb and jump are inverses at the ends and the middle', () => {
        const view = 1090;
        const track = 1000;
        expect(scrollThumb(0, 500, 1000, track)).toEqual({ top: 0, height: track });
        const max = l.contentHeight - view;
        const t0 = scrollThumb(0, l.contentHeight, view, track);
        const t1 = scrollThumb(max, l.contentHeight, view, track);
        expect(t0.top).toBe(0);
        expect(t1.top + t1.height).toBeCloseTo(track);
        expect(t0.height).toBeGreaterThanOrEqual(44);
        for (const s of [0, max * 0.3, max * 0.5, max]) {
            const th = scrollThumb(s, l.contentHeight, view, track);
            expect(scrollFromTrack(th.top + th.height / 2, l.contentHeight, view, track)).toBeCloseTo(s, 3);
        }
        expect(scrollFromTrack(-50, l.contentHeight, view, track)).toBe(0);
        expect(scrollFromTrack(5000, l.contentHeight, view, track)).toBeCloseTo(max);
    });
});
