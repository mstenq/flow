import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

export interface RgbaImage {
    width: number;
    height: number;
    /** RGBA, row-major, 4 bytes per pixel. */
    data: Uint8Array;
}

export const MAX_BOARD_SIZE = 48;
export const ALPHA_THRESHOLD = 128;

/** Reads a PNG. Throws if it is larger than 48 in either dimension or has no opaque pixel (alpha >= 128). */
export function readPng(path: string): RgbaImage {
    const png = PNG.sync.read(readFileSync(path));
    const { width, height } = png;
    if (width > MAX_BOARD_SIZE || height > MAX_BOARD_SIZE) {
        throw new Error(`${path}: image is ${width}x${height}, the maximum is ${MAX_BOARD_SIZE}x${MAX_BOARD_SIZE}`);
    }
    const data = new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength).slice();
    let opaque = 0;
    for (let i = 3; i < data.length; i += 4) {
        if (data[i] >= ALPHA_THRESHOLD) opaque++;
    }
    if (opaque === 0) throw new Error(`${path}: image has no opaque pixels (alpha >= ${ALPHA_THRESHOLD})`);
    return { width, height, data };
}

export function writePng(path: string, img: RgbaImage): void {
    const png = new PNG({ width: img.width, height: img.height });
    png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
    writeFileSync(path, PNG.sync.write(png));
}
