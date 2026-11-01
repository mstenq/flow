/**
 * bun tools/gen/make-samples.ts — draws the small, clean pixel-art sample PNGs into levels-src/.
 * Deterministic: re-running produces identical files.
 */
import { join } from 'node:path';
import { writePng } from './png.ts';
import type { RgbaImage } from './png.ts';
import { hexToRgb } from './lab.ts';
import { LEVELS_SRC } from './output.ts';

type Legend = Record<string, string>;

/** ASCII art → image. '.' is transparent; every row must have the same width. */
function fromAscii(rows: string[], legend: Legend): RgbaImage {
    const width = rows[0].length;
    rows.forEach((r, y) => {
        if (r.length !== width) throw new Error(`row ${y} has width ${r.length}, expected ${width}: "${r}"`);
    });
    const height = rows.length;
    const data = new Uint8Array(width * height * 4);
    rows.forEach((row, y) => {
        for (let x = 0; x < width; x++) {
            const ch = row[x];
            if (ch === '.') continue;
            const hex = legend[ch];
            if (!hex) throw new Error(`no color for '${ch}'`);
            const [r, g, b] = hexToRgb(hex);
            data.set([r, g, b, 255], (y * width + x) * 4);
        }
    });
    return { width, height, data };
}

function fromFn(width: number, height: number, legend: Legend, f: (x: number, y: number) => string): RgbaImage {
    const rows: string[] = [];
    for (let y = 0; y < height; y++) {
        let row = '';
        for (let x = 0; x < width; x++) row += f(x, y);
        rows.push(row);
    }
    return fromAscii(rows, legend);
}

const heart = fromAscii(
    [
        '..ooo..ooo..',
        '.orrrooorrro',
        'orwwwrrrrrro',
        'orwwrrrrrrro',
        'orwrrrrrrrro',
        '.orrrrrrrro.',
        '..orrrrrro..',
        '...orrrro...',
        '....orro....',
        '.....oo.....',
    ],
    { o: '#5c0a1a', r: '#e8283c', w: '#ffe0e6' },
);

const invader = fromAscii(
    [
        'kkkkkkkkkkkkkkk',
        'kyykkkkkkkkkkyk',
        'kykkgkkkkkgkkkk',
        'kkkkkgkkkgkkkkk',
        'kkkkgggggggkkkk',
        'kkkggeegggeeggk',
        'kkkggeegggeeggk',
        'kkgggggggggggkk',
        'kkgkgggggggkgkk',
        'kkgkgkkkkkgkgkk',
        'kkkkkggkggkkkyy',
        'kyykkkkkkkkkkyk',
    ],
    { k: '#0c0c18', y: '#ffe14a', g: '#46e04a', e: '#ff3ad0' },
);

const mushroom = fromAscii(
    [
        '.....oooooo.....',
        '...oorrrrrroo...',
        '..orrwwwrrrrro..',
        '.orrwwwwwrrwwro.',
        '.orrwwwwwrrwwwo.',
        'orrrrwwwrrrrwwro',
        'orrrrrrrrrrrrrro',
        'orwwwrrrrwwwrrro',
        'owwwwwrrwwwwwrro',
        'owwwwwrrwwwwwrro',
        '.oooooooooooooo.',
        '....obbbbbbo....',
        '....obeebeeo....',
        '....obeebeeo....',
        '....obbbbbbo....',
        '.....oooooo.....',
    ],
    { o: '#2a1020', r: '#e02430', w: '#fff4e8', b: '#f0c890', e: '#3a2a80' },
);

/** Full-rectangle sunset: sky bands, a sun sinking into the sea, reflection stripes, a dark island. */
const sunset = fromFn(32, 24, { v: '#3a1670', m: '#c02890', o: '#ff7a20', s: '#ffe040', b: '#1050c0', w: '#d8f0ff', d: '#0a6a38' }, (x, y) => {
    const sunX = 15.5;
    const sunY = 13;
    const inSun = Math.hypot(x - sunX, (y - sunY) * 1.1) < 6.2;
    const horizon = 14;
    // Island silhouette on the right, sitting on the horizon.
    const island = y >= 10 && y <= horizon && x >= 23 && x <= 30 && y >= 10 + Math.abs(x - 26.5) * 0.9;
    if (island) return 'd';
    if (y < horizon) {
        if (inSun) return 's';
        if (y < 5) return 'v';
        if (y < 10) return 'm';
        return 'o';
    }
    // Sea: reflection under the sun, foam stripes.
    const refl = Math.abs(x - sunX) < 6 - (y - horizon) * 0.35 && (y - horizon) % 2 === 0;
    if (refl) return 's';
    if ((y === 18 && x % 9 < 4) || (y === 21 && (x + 4) % 10 < 4)) return 'w';
    return 'b';
});

/** Full-rectangle ringed planet on a starfield. */
const planet = fromFn(24, 24, { k: '#0a0a30', p: '#ff6a20', q: '#ffd040', r: '#30e0ff', s: '#f4f1ff', g: '#e02040' }, (x, y) => {
    const cx = 11.5;
    const cy = 11.5;
    const dx = x - cx;
    const dy = y - cy;
    // Tilted ring ellipse.
    const rx = dx * Math.cos(-0.45) - dy * Math.sin(-0.45);
    const ry = dx * Math.sin(-0.45) + dy * Math.cos(-0.45);
    const ringD = Math.hypot(rx / 11, ry / 3.4);
    const onRing = ringD > 0.72 && ringD < 1.0;
    const inPlanet = Math.hypot(dx, dy) < 7;
    const frontHalf = ry > 0;
    if (onRing && (frontHalf || !inPlanet)) return 'r';
    if (inPlanet) {
        const band = Math.floor((ry + 8) / 2.2) % 3;
        return band === 0 ? 'q' : band === 1 ? 'p' : 'g';
    }
    // Stars: little plus shapes.
    const stars = [
        [3, 3],
        [19, 2],
        [2, 18],
        [20, 20],
        [15, 21],
    ];
    for (const [sx, sy] of stars) if (Math.abs(x - sx) + Math.abs(y - sy) <= 1) return 's';
    return 'k';
});

/** Concentric rainbow arcs over a sky block, clouds at both feet. */
const rainbow = fromFn(28, 18, { r: '#ff2a40', o: '#ff8a20', y: '#ffe030', g: '#40e050', b: '#2f7bff', v: '#9b40ff', c: '#f4f8ff', k: '#0a1440' }, (x, y) => {
    const d = Math.hypot(x - 13.5, (y - 18.5) * 1.05);
    const cloudL = Math.hypot(x - 4, (y - 15.5) * 1.4) < 4.2;
    const cloudR = Math.hypot(x - 23, (y - 15.5) * 1.4) < 4.2;
    if (cloudL || cloudR) return 'c';
    const bands = ['r', 'o', 'y', 'g', 'b', 'v'];
    const band = Math.floor((17.5 - d) / 2);
    if (band >= 0 && band < bands.length) return bands[band];
    return 'k';
});

const samples: [string, RgbaImage][] = [
    ['heart.png', heart],
    ['invader.png', invader],
    ['mushroom.png', mushroom],
    ['sunset.png', sunset],
    ['planet.png', planet],
    ['rainbow.png', rainbow],
];

for (const [file, img] of samples) {
    const path = join(LEVELS_SRC, file);
    writePng(path, img);
    console.log(`wrote ${path} (${img.width}x${img.height})`);
}
