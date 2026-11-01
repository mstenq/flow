import { describe, expect, test } from 'bun:test';
import { simplifyImage } from '../../tools/gen/palette';
import type { RgbaImage } from '../../tools/gen/png';

function makeImage(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): RgbaImage {
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4);
    return { width, height, data };
}

/** Round sprite on a transparent background with a 1px outline: `outline` color, noisy body (many exact colors). */
function sprite(outline: [number, number, number], noisy: boolean): RgbaImage {
    const c = 15.5;
    return makeImage(32, 32, (x, y) => {
        const d = Math.hypot(x - c, y - c);
        if (d > 12.4) return [0, 0, 0, 0];
        if (d > 11.2) return [...outline, 255];
        const n = noisy ? ((x * 7 + y * 13) % 11) * 2 : 0;
        const top = y < 16;
        return top ? [200 + n, 150 + n, 110, 255] : [120 + n, 170, 90 + n, 255];
    });
}

function outlineShare(img: RgbaImage, s: ReturnType<typeof simplifyImage>): { colors: number; border: Map<number, number> } {
    const { width: w, height: h } = img;
    const border = new Map<number, number>();
    const op = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && img.data[(y * w + x) * 4 + 3] >= 128;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (!op(x, y) || (op(x - 1, y) && op(x + 1, y) && op(x, y - 1) && op(x, y + 1))) continue;
            const l = s.cells[y * w + x];
            border.set(l, (border.get(l) ?? 0) + 1);
        }
    }
    return { colors: s.palette.length, border };
}

describe('thin outlines survive simplification', () => {
    test('1px black outline of a noisy sprite stays its own color (edge pixels vote)', () => {
        const img = sprite([0, 0, 0], true);
        const s = simplifyImage(img, { maxColors: 6 });
        const { border } = outlineShare(img, s);
        const [top, n] = [...border].sort((a, b) => b[1] - a[1])[0];
        const total = [...border.values()].reduce((a, b) => a + b, 0);
        expect(n / total).toBeGreaterThan(0.85);
        // The outline color is not shared with the body.
        expect(s.counts[top]).toBeLessThan(total * 2);
    });

    test('diagonal 1px outline is not dissolved as speckle (8-connected regions)', () => {
        // Diamond: its outline is purely diagonal, every 4-connected piece is a single pixel.
        const img = makeImage(32, 32, (x, y) => {
            const d = Math.abs(x - 15.5) + Math.abs(y - 15.5);
            if (d > 15) return [0, 0, 0, 0];
            if (d > 14) return [30, 10, 50, 255];
            return x < 16 ? [210, 160, 90, 255] : [120, 190, 90, 255];
        });
        const s = simplifyImage(img, { maxColors: 6 });
        expect(s.palette.length).toBe(3);
    });

    test('a dark green outline is not merged away for lack of a matching neon hue', () => {
        const img = makeImage(24, 24, (x, y) => {
            const edge = x === 2 || x === 21 || y === 2 || y === 21;
            const inside = x >= 2 && x <= 21 && y >= 2 && y <= 21;
            if (!inside) return [0, 0, 0, 0];
            if (edge) return [2, 31, 2, 255];
            return x < 12 ? [120, 168, 60, 255] : [198, 224, 150, 255];
        });
        const s = simplifyImage(img, { maxColors: 6 });
        expect(s.palette.length).toBe(3);
    });
});
