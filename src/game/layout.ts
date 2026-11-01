/**
 * Pure layout math for the 720x1280 portrait play screen. No Phaser, no DOM, so it is unit-testable.
 *
 * ```
 *    0 -  90  top bar (pause, level name, speed; debug strip under the name)
 *  100 - 780  board area 680x680, cell = floor(680 / max(W, H)), board centered in the area
 *  800 - 910  lanes row, L slots evenly spaced
 *  912 - 940  toast line (denied-tap reasons)
 *  940 - 1280 queue: C columns, front pod + next 3 pods, "+n" badge for deeper pods
 * ```
 */

export const LOGICAL_W = 720;
export const LOGICAL_H = 1280;

export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface Point2 {
    x: number;
    y: number;
}

export interface LayoutInput {
    /** Board width in cells. */
    width: number;
    /** Board height in cells. */
    height: number;
    /** Queue columns. */
    columns: number;
    /** Lane slots. */
    lanes: number;
}

export interface BoardLayout {
    /** The 680x680 area the board is centered in. */
    area: Rect;
    cell: number;
    /** Actual board rectangle (cell * W by cell * H), centered in `area`. */
    rect: Rect;
}

export interface LaneLayout {
    y: number;
    slotW: number;
    slotH: number;
    /** Slot centers (x). */
    centers: number[];
    /** Slot rects. */
    rects: Rect[];
}

export interface QueueLayout {
    area: Rect;
    colW: number;
    /** Pod width at the front slot. */
    podW: number;
    /** Pod height at the front slot. */
    podH: number;
    /** Column center x. */
    centers: number[];
    /** Tap/hit rect per column (the whole column strip of the queue area). */
    hitRects: Rect[];
    /** Center y of the front pod and the next pods. */
    slotY: number[];
    /** Uniform scale of the pod graphic per slot. */
    slotScale: number[];
    /** Where the "+n" badge sits. */
    badgeY: number;
    /** Where a pod waiting beyond the visible slots sits (it slides up into the last slot from here). */
    spawnY: number;
}

export interface Layout {
    width: number;
    height: number;
    topBar: Rect;
    board: BoardLayout;
    lanes: LaneLayout;
    toastY: number;
    queue: QueueLayout;
}

/** Pods drawn per column: the front pod plus the next three. */
export const VISIBLE_PODS = 4;

export const TOP_BAR: Rect = { x: 0, y: 0, w: LOGICAL_W, h: 90 };
export const BOARD_AREA: Rect = { x: 20, y: 100, w: 680, h: 680 };
export const LANES_Y = 800;
export const LANES_H = 110;
export const TOAST_Y = 926;
export const QUEUE_AREA: Rect = { x: 0, y: 940, w: LOGICAL_W, h: 340 };

const LANE_MARGIN = 24;
const LANE_GAP = 12;
const LANE_MAX_W = 168;
const QUEUE_MARGIN = 12;
const POD_MAX_W = 132;
const POD_H = 104;
const SLOT_SCALE = 0.55;
const SLOT_GAP = 8;

export function computeLayout(input: LayoutInput): Layout {
    const { width, height, columns, lanes } = input;
    if (width < 1 || height < 1) throw new Error('computeLayout: board must be at least 1x1');
    if (columns < 1 || lanes < 1) throw new Error('computeLayout: need at least 1 column and 1 lane');
    return {
        width: LOGICAL_W,
        height: LOGICAL_H,
        topBar: TOP_BAR,
        board: computeBoard(width, height),
        lanes: computeLanes(lanes),
        toastY: TOAST_Y,
        queue: computeQueue(columns),
    };
}

function computeBoard(width: number, height: number): BoardLayout {
    const cell = Math.max(1, Math.floor(BOARD_AREA.w / Math.max(width, height)));
    const w = cell * width;
    const h = cell * height;
    return {
        area: BOARD_AREA,
        cell,
        rect: {
            x: BOARD_AREA.x + Math.floor((BOARD_AREA.w - w) / 2),
            y: BOARD_AREA.y + Math.floor((BOARD_AREA.h - h) / 2),
            w,
            h,
        },
    };
}

function computeLanes(count: number): LaneLayout {
    const avail = LOGICAL_W - LANE_MARGIN * 2 - LANE_GAP * (count - 1);
    const slotW = Math.min(LANE_MAX_W, Math.floor(avail / count));
    const total = slotW * count + LANE_GAP * (count - 1);
    const left = Math.round((LOGICAL_W - total) / 2);
    const rects: Rect[] = [];
    const centers: number[] = [];
    for (let i = 0; i < count; i++) {
        const x = left + i * (slotW + LANE_GAP);
        rects.push({ x, y: LANES_Y, w: slotW, h: LANES_H });
        centers.push(x + slotW / 2);
    }
    return { y: LANES_Y, slotW, slotH: LANES_H, centers, rects };
}

function computeQueue(count: number): QueueLayout {
    const usable = LOGICAL_W - QUEUE_MARGIN * 2;
    const colW = usable / count;
    const podW = Math.min(POD_MAX_W, Math.floor(colW - 10));
    const centers: number[] = [];
    const hitRects: Rect[] = [];
    for (let i = 0; i < count; i++) {
        const x = QUEUE_MARGIN + i * colW;
        centers.push(x + colW / 2);
        hitRects.push({ x, y: QUEUE_AREA.y, w: colW, h: QUEUE_AREA.h });
    }
    const slotY: number[] = [];
    const slotScale: number[] = [];
    let top = QUEUE_AREA.y + 10;
    for (let i = 0; i < VISIBLE_PODS; i++) {
        const scale = i === 0 ? 1 : SLOT_SCALE;
        const h = POD_H * scale;
        slotY.push(top + h / 2);
        slotScale.push(scale);
        top += h + SLOT_GAP;
    }
    const lastBottom = top - SLOT_GAP;
    return {
        area: QUEUE_AREA,
        colW,
        podW,
        podH: POD_H,
        centers,
        hitRects,
        slotY,
        slotScale,
        badgeY: Math.min(lastBottom + 18, LOGICAL_H - 12),
        spawnY: lastBottom + POD_H * SLOT_SCALE,
    };
}

/** Center of board cell `(cx, cy)` in logical pixels. Works for out-of-grid cells too (used for exit paths). */
export function cellCenter(layout: Layout, cx: number, cy: number): Point2 {
    const { rect, cell } = layout.board;
    return { x: rect.x + (cx + 0.5) * cell, y: rect.y + (cy + 0.5) * cell };
}

/** Which board cell is under logical point `(x, y)`, or null when outside the board. */
export function cellAt(layout: Layout, x: number, y: number): Point2 | null {
    const { rect, cell } = layout.board;
    if (x < rect.x || y < rect.y || x >= rect.x + rect.w || y >= rect.y + rect.h) return null;
    return { x: Math.floor((x - rect.x) / cell), y: Math.floor((y - rect.y) / cell) };
}

/** Queue column under logical x (within the queue area vertically too), or -1. */
export function columnAt(layout: Layout, x: number, y: number): number {
    const { hitRects } = layout.queue;
    for (let i = 0; i < hitRects.length; i++) {
        const r = hitRects[i]!;
        if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return i;
    }
    return -1;
}

/** Slot center for pod `index` in `column` (index beyond the visible window clamps to the spawn slot below). */
export function podSlot(layout: Layout, column: number, index: number): Point2 & { scale: number } {
    const q = layout.queue;
    const x = q.centers[column]!;
    if (index >= VISIBLE_PODS) return { x, y: q.spawnY, scale: q.slotScale[VISIBLE_PODS - 1]! };
    return { x, y: q.slotY[index]!, scale: q.slotScale[index]! };
}
