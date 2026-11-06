/**
 * Level select grid math (pure). Tiles live in "content" coordinates: x in logical pixels, y measured from the top of
 * the scroll area. `scroll` is how far the content is moved up (0 = top).
 */
import { LOGICAL_W } from './layout';

export const SELECT = {
    cols: 2,
    margin: 40,
    gapX: 24,
    gapY: 26,
    tileH: 362,
    sectionH: 78,
    topPad: 20,
    bottomPad: 60,
} as const;

export const TILE_W = (LOGICAL_W - SELECT.margin * 2 - SELECT.gapX * (SELECT.cols - 1)) / SELECT.cols;

export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface SelectLayout {
    campaign: Rect[];
    dev: Rect[];
    /** Content y of the "DEV" section title, or null without dev levels. */
    devTitleY: number | null;
    contentHeight: number;
}

function place(count: number, startY: number): { rects: Rect[]; endY: number } {
    const rects: Rect[] = [];
    for (let i = 0; i < count; i++) {
        const col = i % SELECT.cols;
        const row = Math.floor(i / SELECT.cols);
        rects.push({ x: SELECT.margin + col * (TILE_W + SELECT.gapX), y: startY + row * (SELECT.tileH + SELECT.gapY), w: TILE_W, h: SELECT.tileH });
    }
    const rows = Math.ceil(count / SELECT.cols);
    return { rects, endY: startY + rows * (SELECT.tileH + SELECT.gapY) };
}

export function layoutSelect(campaignCount: number, devCount: number): SelectLayout {
    const main = place(campaignCount, SELECT.topPad);
    if (devCount === 0) return { campaign: main.rects, dev: [], devTitleY: null, contentHeight: main.endY + SELECT.bottomPad };
    const devTitleY = main.endY + 8;
    const dev = place(devCount, devTitleY + SELECT.sectionH);
    return { campaign: main.rects, dev: dev.rects, devTitleY, contentHeight: dev.endY + SELECT.bottomPad };
}

export function maxScroll(contentHeight: number, viewHeight: number): number {
    return Math.max(0, contentHeight - viewHeight);
}

export function clampScroll(scroll: number, contentHeight: number, viewHeight: number): number {
    return Math.max(0, Math.min(maxScroll(contentHeight, viewHeight), scroll));
}

/** Scroll that centers `rect` in the view (clamped). */
export function scrollToCenter(rect: Rect, contentHeight: number, viewHeight: number): number {
    return clampScroll(rect.y + rect.h / 2 - viewHeight / 2, contentHeight, viewHeight);
}

/** Index of the rect under a point given in content coordinates, or -1. */
export function hitRect(rects: readonly Rect[], x: number, contentY: number): number {
    return rects.findIndex((r) => x >= r.x && x <= r.x + r.w && contentY >= r.y && contentY <= r.y + r.h);
}

/** Drag/tap discrimination: a press that moved more than `threshold` px is a drag, never a tap. */
export function isTap(dx: number, dy: number, thresholdPx = 14): boolean {
    return Math.hypot(dx, dy) <= thresholdPx;
}

/**
 * Virtualization window: half-open range `[start, end)` of rects whose vertical span touches `[top, bottom]`
 * (content coordinates). `rects` must be sorted by `y` (they are: campaign rows, then the dev rows). Binary search,
 * so it stays cheap at thousands of tiles. Empty range when nothing touches the window.
 */
export function visibleRange(rects: readonly Rect[], top: number, bottom: number): { start: number; end: number } {
    // First rect whose bottom edge reaches `top` (rect bottoms are sorted too: same height, rising y).
    let lo = 0;
    let hi = rects.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (rects[mid]!.y + rects[mid]!.h < top) lo = mid + 1;
        else hi = mid;
    }
    const start = lo;
    // First rect that starts below `bottom`.
    hi = rects.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (rects[mid]!.y <= bottom) lo = mid + 1;
        else hi = mid;
    }
    return { start, end: Math.max(start, lo) };
}

/** Index of the rect nearest the content y (the row a viewer is looking at), clamped; -1 for an empty list. */
export function nearestRect(rects: readonly Rect[], contentY: number): number {
    if (rects.length === 0) return -1;
    const { start, end } = visibleRange(rects, contentY, contentY);
    if (end > start) return start;
    return contentY < rects[0]!.y ? 0 : rects.length - 1;
}

/** Scrollbar thumb for a scroll position: `top` and `height` in track pixels. Pure. */
export function scrollThumb(scroll: number, contentHeight: number, viewHeight: number, trackHeight: number, minThumb = 44): { top: number; height: number } {
    if (contentHeight <= viewHeight) return { top: 0, height: trackHeight };
    const height = Math.min(trackHeight, Math.max(minThumb, (viewHeight / contentHeight) * trackHeight));
    const t = Math.max(0, Math.min(1, scroll / (contentHeight - viewHeight)));
    return { top: t * (trackHeight - height), height };
}

/** Inverse of `scrollThumb`: scroll position when the thumb's center is dragged to `trackY` (0..trackHeight). */
export function scrollFromTrack(trackY: number, contentHeight: number, viewHeight: number, trackHeight: number, minThumb = 44): number {
    const { height } = scrollThumb(0, contentHeight, viewHeight, trackHeight, minThumb);
    const span = trackHeight - height;
    if (span <= 0) return 0;
    const t = Math.max(0, Math.min(1, (trackY - height / 2) / span));
    return t * (contentHeight - viewHeight);
}
