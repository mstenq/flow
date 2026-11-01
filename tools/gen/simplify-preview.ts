/**
 * Usage: bun tools/gen/simplify-preview.ts <png> [--max-colors N] [--min-region N] [--tolerance N]
 * Writes tools/gen/out/<id>.simplify.png: original | quantized (source colors) | neon, x8, on #05030c.
 */
import { mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hexToRgb } from './lab.ts';
import { simplifyImage } from './palette.ts';
import { readPng, writePng, ALPHA_THRESHOLD, type RgbaImage } from './png.ts';

const SCALE = 8;
const GAP = 2; // source pixels between panels
const BG = [0x05, 0x03, 0x0c];
const EMPTY = 255;

function flag(args: string[], name: string): number | undefined {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = Number(args[i + 1]);
    if (!Number.isFinite(v)) throw new Error(`${name} needs a number`);
    return v;
}

function main(): void {
    const args = process.argv.slice(2);
    const path = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
    if (!path) {
        console.error('usage: bun tools/gen/simplify-preview.ts <png> [--max-colors N] [--min-region N] [--tolerance N]');
        process.exit(1);
    }
    const maxColors = flag(args, '--max-colors') ?? 6;
    const minRegion = flag(args, '--min-region');
    const tolerance = flag(args, '--tolerance');

    const img = readPng(path);
    const out = simplifyImage(img, { maxColors, minRegion, tolerance });
    console.log(out.log.join('\n'));

    const { width, height } = img;
    const panelW = width + GAP;
    const totalW = (width * 3 + GAP * 4) * SCALE;
    const totalH = (height + GAP * 2) * SCALE;
    const canvas: RgbaImage = { width: totalW, height: totalH, data: new Uint8Array(totalW * totalH * 4) };
    for (let i = 0; i < totalW * totalH; i++) {
        canvas.data.set([BG[0], BG[1], BG[2], 255], i * 4);
    }
    const paint = (panel: number, x: number, y: number, rgb: [number, number, number]) => {
        const ox = (GAP + panel * panelW + x) * SCALE;
        const oy = (GAP + y) * SCALE;
        for (let dy = 0; dy < SCALE; dy++) {
            for (let dx = 0; dx < SCALE; dx++) {
                canvas.data.set([rgb[0], rgb[1], rgb[2], 255], ((oy + dy) * totalW + ox + dx) * 4);
            }
        }
    };

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * width + x;
            const idx = out.cells[i];
            if (img.data[i * 4 + 3] >= ALPHA_THRESHOLD) {
                paint(0, x, y, [img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]]);
            }
            if (idx === EMPTY) continue;
            paint(1, x, y, hexToRgb(out.sourceColors[idx]));
            paint(2, x, y, hexToRgb(out.palette[idx]));
        }
    }

    const outDir = join(dirname(fileURLToPath(import.meta.url)), 'out');
    mkdirSync(outDir, { recursive: true });
    const id = basename(path).replace(/\.png$/i, '');
    const outPath = join(outDir, `${id}.simplify.png`);
    writePng(outPath, canvas);
    console.log(`wrote ${outPath}`);
}

main();
