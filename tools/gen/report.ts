/**
 * Level report: `tools/gen/out/<id>.html` (self-contained, dark/neon) and `tools/gen/out/<id>.preview.png`.
 * The HTML embeds the original PNG, the simplified + neon boards, pods, stats, and a step-through replay of
 * the solution (a snapshot after every tap + settle, precomputed by the generator).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import type { LevelData } from '@game/types';
import { EMPTY } from '@game/types';
import type { RgbaImage } from './png.ts';
import type { SimplifiedImage } from './palette.ts';
import type { Trace } from './board.ts';
import { cellColor } from '@game/grid';
import { hexToRgb } from './lab.ts';
import { isFastPlayTrap } from './difficulty.ts';

export interface ReportInput {
    level: LevelData;
    image: RgbaImage;
    simplified: SimplifiedImage;
    trace: Trace;
    summary: string[];
    timings: Record<string, number>;
    knobs: string;
}

const BG: [number, number, number] = [7, 5, 15];

function encodePng(img: RgbaImage): Buffer {
    const png = new PNG({ width: img.width, height: img.height });
    png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
    return PNG.sync.write(png);
}

function dataUrl(img: RgbaImage): string {
    return `data:image/png;base64,${encodePng(img).toString('base64')}`;
}

function blank(width: number, height: number, rgb: [number, number, number]): RgbaImage {
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) data.set([rgb[0], rgb[1], rgb[2], 255], i * 4);
    return { width, height, data };
}

/** Pixel-exact upscale of a board (one color per cell) with a transparent background. */
function boardImage(width: number, height: number, cells: Uint8Array, colors: string[], scale: number): RgbaImage {
    const W = width * scale;
    const H = height * scale;
    const data = new Uint8Array(W * H * 4);
    const rgb = colors.map(hexToRgb);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const c = cells[y * width + x];
            if (c === EMPTY) continue;
            const [r, g, b] = rgb[c];
            for (let dy = 0; dy < scale; dy++) {
                for (let dx = 0; dx < scale; dx++) data.set([r, g, b, 255], ((y * scale + dy) * W + x * scale + dx) * 4);
            }
        }
    }
    return { width: W, height: H, data };
}

function upscale(img: RgbaImage, scale: number): RgbaImage {
    const W = img.width * scale;
    const H = img.height * scale;
    const data = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const s = (Math.floor(y / scale) * img.width + Math.floor(x / scale)) * 4;
            const a = img.data[s + 3] >= 128 ? 255 : 0;
            data.set([img.data[s], img.data[s + 1], img.data[s + 2], a], (y * W + x) * 4);
        }
    }
    return { width: W, height: H, data };
}

/** Separable box blur on a float RGB buffer (in place, `passes` times ≈ gaussian). */
function blur(buf: Float32Array, w: number, h: number, r: number, passes: number): void {
    const tmp = new Float32Array(buf.length);
    for (let pass = 0; pass < passes; pass++) {
        for (let y = 0; y < h; y++) {
            for (let ch = 0; ch < 3; ch++) {
                let acc = 0;
                for (let x = -r; x <= r; x++) acc += buf[(y * w + Math.max(0, Math.min(w - 1, x))) * 3 + ch];
                for (let x = 0; x < w; x++) {
                    tmp[(y * w + x) * 3 + ch] = acc / (2 * r + 1);
                    const add = Math.min(w - 1, x + r + 1);
                    const sub = Math.max(0, x - r);
                    acc += buf[(y * w + add) * 3 + ch] - buf[(y * w + sub) * 3 + ch];
                }
            }
        }
        for (let x = 0; x < w; x++) {
            for (let ch = 0; ch < 3; ch++) {
                let acc = 0;
                for (let y = -r; y <= r; y++) acc += tmp[(Math.max(0, Math.min(h - 1, y)) * w + x) * 3 + ch];
                for (let y = 0; y < h; y++) {
                    buf[(y * w + x) * 3 + ch] = acc / (2 * r + 1);
                    const add = Math.min(h - 1, y + r + 1);
                    const sub = Math.max(0, y - r);
                    acc += tmp[(add * w + x) * 3 + ch] - tmp[(sub * w + x) * 3 + ch];
                }
            }
        }
    }
}

/** Neon board: glowing inset tiles on a dark background with a faint grid. */
export function neonPreview(level: LevelData): RgbaImage {
    const { width, height } = level;
    const cell = Math.max(8, Math.min(32, Math.floor(640 / Math.max(width, height))));
    const pad = cell * 2;
    const W = width * cell + pad * 2;
    const H = height * cell + pad * 2;
    const rgb = level.palette.map(hexToRgb);
    const glow = new Float32Array(W * H * 3);
    const tile = new Float32Array(W * H * 3);
    const mask = new Uint8Array(W * H);
    const inset = Math.max(1, Math.round(cell * 0.1));
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const ch = level.cells[y * width + x];
            if (ch === '.') continue;
            const [r, g, b] = rgb[cellColor(ch)];
            for (let dy = 0; dy < cell; dy++) {
                for (let dx = 0; dx < cell; dx++) {
                    const px = pad + x * cell + dx;
                    const py = pad + y * cell + dy;
                    const i = py * W + px;
                    glow[i * 3] = r;
                    glow[i * 3 + 1] = g;
                    glow[i * 3 + 2] = b;
                    if (dx < inset || dy < inset || dx >= cell - inset || dy >= cell - inset) continue;
                    // Brighter core toward the tile center.
                    const cx = (dx - cell / 2) / (cell / 2);
                    const cy = (dy - cell / 2) / (cell / 2);
                    const core = 1 - 0.35 * Math.min(1, Math.hypot(cx, cy));
                    const lift = 0.25 * (1 - Math.min(1, Math.hypot(cx, cy)));
                    tile[i * 3] = Math.min(255, r * core + 255 * lift);
                    tile[i * 3 + 1] = Math.min(255, g * core + 255 * lift);
                    tile[i * 3 + 2] = Math.min(255, b * core + 255 * lift);
                    mask[i] = 1;
                }
            }
        }
    }
    blur(glow, W, H, Math.max(2, Math.round(cell * 0.6)), 3);
    const out = blank(W, H, BG);
    for (let i = 0; i < W * H; i++) {
        const px = i % W;
        const py = (i - px) / W;
        const grid = (px - pad) % cell === 0 || (py - pad) % cell === 0 ? 10 : 0;
        let r = BG[0] + grid + glow[i * 3] * 0.55;
        let g = BG[1] + grid + glow[i * 3 + 1] * 0.55;
        let b = BG[2] + grid * 1.6 + glow[i * 3 + 2] * 0.55;
        if (mask[i]) {
            r = tile[i * 3];
            g = tile[i * 3 + 1];
            b = tile[i * 3 + 2];
        }
        out.data.set([Math.min(255, r), Math.min(255, g), Math.min(255, b), 255], i * 4);
    }
    // Keys: small dark ring with a bright center on the key cell.
    for (const key of level.keys) {
        const cx = pad + key.x * cell + cell / 2;
        const cy = pad + key.y * cell + cell / 2;
        const rad = cell * 0.32;
        for (let py = Math.floor(cy - rad - 1); py <= cy + rad + 1; py++) {
            for (let px = Math.floor(cx - rad - 1); px <= cx + rad + 1; px++) {
                const d = Math.hypot(px + 0.5 - cx, py + 0.5 - cy);
                if (d > rad) continue;
                const v = d > rad * 0.55 ? [10, 8, 20] : [255, 255, 255];
                out.data.set([v[0], v[1], v[2], 255], (py * W + px) * 4);
            }
        }
    }
    return out;
}

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function writeReport(outDir: string, input: ReportInput): { html: string; preview: string } {
    mkdirSync(outDir, { recursive: true });
    const { level, image, simplified, trace } = input;
    const id = level.id;
    const preview = neonPreview(level);
    const previewPath = join(outDir, `${id}.preview.png`);
    writeFileSync(previewPath, encodePng(preview));

    const scale = Math.max(4, Math.floor(288 / Math.max(level.width, level.height)));
    const original = dataUrl(upscale(image, scale));
    const simple = dataUrl(boardImage(simplified.width, simplified.height, simplified.cells, simplified.sourceColors, scale));
    const neon = dataUrl(preview);

    const data = {
        level,
        frames: trace.frames,
        sourceColors: simplified.sourceColors,
        stalledPod: trace.stalledPod,
    };
    const htmlPath = join(outDir, `${id}.html`);
    writeFileSync(htmlPath, html(input, { original, simple, neon }, JSON.stringify(data)));
    return { html: htmlPath, preview: previewPath };
}

function html(input: ReportInput, imgs: { original: string; simple: string; neon: string }, json: string): string {
    const { level } = input;
    const s = level.meta.stats;
    const trap = isFastPlayTrap(s);
    const statRows: [string, string][] = [
        ['difficulty', `${level.meta.difficulty.toFixed(3)} <span class="dim">(target ${level.meta.targetDifficulty.toFixed(2)})</span>`],
        ['greedyWinRate', pct(s.greedyWinRate)],
        ['randomWinRate', pct(s.randomWinRate)],
        ['fastGreedyWinRate', s.fastGreedyWinRate === undefined ? '-' : `${pct(s.fastGreedyWinRate)}${trap ? ' <span class="badge trap">FAST-PLAY TRAP</span>' : ''}`],
        ['fastRandomWinRate', s.fastRandomWinRate === undefined ? '-' : pct(s.fastRandomWinRate)],
        ['pod capacity', `max ${s.maxPodCapacity ?? '-'} / median ${s.medianPodCapacity ?? '-'}`],
        ['longest drain', s.longestDrainSec === undefined ? '-' : `~${s.longestDrainSec.toFixed(1)}s <span class="dim">at 1x</span>`],
        ['deadEndRatio', s.deadEndRatio.toFixed(3)],
        ['minLanes', `${s.minLanes}${s.minLanesProven === false ? ' <span class="dim">(budget)</span>' : ''} / ${level.lanes}`],
        ['branching', s.branching.toFixed(2)],
        ['overflow pods', String(s.overflowPods ?? '-')],
        ['peak stalled', String(s.peakStalled ?? '-')],
        ['hidden share', s.hiddenShare.toFixed(2)],
        ['locks / pairs', `${s.lockCount} / ${s.pairCount}`],
    ];
    const timing = Object.entries(input.timings)
        .map(([k, v]) => `${k} ${(v / 1000).toFixed(2)}s`)
        .join(' · ');
    const pods = level.columns.flat();
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(level.name)} — FLOW level report</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root { --bg:#07050f; --panel:#110d20; --line:#251d40; --text:#e8e4ff; --dim:#8a83b0; --accent:#00f0ff; --hot:#ff2bd6; }
* { box-sizing:border-box; }
body { margin:0; background:radial-gradient(1200px 600px at 20% -10%, #1a1036 0%, var(--bg) 60%); color:var(--text); font:14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width:1280px; margin:0 auto; padding:24px; }
h1 { margin:0; font-size:28px; letter-spacing:.06em; text-transform:uppercase; text-shadow:0 0 12px rgba(0,240,255,.6); }
h2 { font-size:13px; letter-spacing:.14em; text-transform:uppercase; color:var(--accent); margin:0 0 12px; }
.sub { color:var(--dim); margin-top:4px; }
.badge.trap { background:#5a0a1c; border-color:#ff2950; color:#ff9aab; font-weight:700; margin:0 0 0 6px; }
.badge { display:inline-block; padding:2px 10px; border-radius:999px; border:1px solid var(--line); margin-right:6px; font-size:12px; }
.score { font-size:44px; font-weight:700; color:var(--hot); text-shadow:0 0 18px rgba(255,43,214,.7); line-height:1; }
.panel { background:linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,0)), var(--panel); border:1px solid var(--line); border-radius:14px; padding:16px; box-shadow:0 0 0 1px rgba(0,0,0,.4), 0 10px 40px rgba(0,0,0,.35); }
.grid { display:grid; gap:16px; }
.top { grid-template-columns: 1fr auto; align-items:end; margin-bottom:16px; }
.imgs { grid-template-columns: repeat(3, 1fr); }
.imgs figure { margin:0; text-align:center; }
.imgs img { max-width:100%; image-rendering:pixelated; border-radius:8px; background:repeating-conic-gradient(#0d0a1a 0% 25%, #120e22 0% 50%) 50% / 16px 16px; }
.imgs figcaption { color:var(--dim); font-size:12px; margin-top:6px; }
.two { grid-template-columns: 340px 1fr; margin-top:16px; }
table { border-collapse:collapse; width:100%; }
td { padding:5px 4px; border-bottom:1px solid var(--line); }
td:first-child { color:var(--dim); }
.dim { color:var(--dim); }
pre { margin:0; white-space:pre-wrap; font:12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color:#c9c2f0; }
.replay { margin-top:16px; }
.controls { display:flex; gap:8px; align-items:center; margin-bottom:12px; flex-wrap:wrap; }
button { background:#1b1433; color:var(--text); border:1px solid #3a2d66; border-radius:8px; padding:6px 14px; font:inherit; cursor:pointer; }
button:hover { border-color:var(--accent); box-shadow:0 0 10px rgba(0,240,255,.35); }
input[type=range] { flex:1; min-width:200px; accent-color:var(--hot); }
.stage { display:grid; grid-template-columns: auto 1fr; gap:16px; align-items:start; }
canvas { background:var(--bg); border-radius:10px; border:1px solid var(--line); display:block; }
.lanes { display:flex; gap:8px; margin-bottom:14px; flex-wrap:wrap; }
.lane { width:118px; height:64px; border-radius:10px; border:1px dashed #3a2d66; display:flex; flex-direction:column; justify-content:center; align-items:center; font-size:12px; position:relative; overflow:hidden; }
.lane.full { border-style:solid; }
.lane .fill { position:absolute; left:0; bottom:0; height:6px; }
.lane.stalled { animation:pulse 1.2s infinite; }
@keyframes pulse { 50% { box-shadow:0 0 14px rgba(255,41,80,.7) inset; } }
.cols { display:flex; gap:10px; align-items:flex-start; flex-wrap:wrap; }
.col { min-width:74px; display:flex; flex-direction:column; gap:5px; padding:6px; border-radius:10px; border:1px solid var(--line); background:rgba(0,0,0,.25); }
.col.tapped { border-color:var(--hot); box-shadow:0 0 12px rgba(255,43,214,.5); }
.col h3 { margin:0 0 2px; font-size:11px; color:var(--dim); font-weight:600; text-align:center; letter-spacing:.1em; }
.pod { height:30px; border-radius:7px; display:flex; align-items:center; justify-content:space-between; padding:0 7px; font-weight:700; font-size:12px; color:#08060f; position:relative; }
.pod.hidden { background:repeating-linear-gradient(45deg,#2a2148,#2a2148 5px,#1c1633 5px,#1c1633 10px) !important; color:var(--text); }
.pod.locked { outline:2px dashed #fff; outline-offset:-3px; }
.pod .tag { font-size:10px; font-weight:600; padding:0 4px; border-radius:4px; background:rgba(0,0,0,.55); color:#fff; }
.pod.next { box-shadow:0 0 0 2px #fff, 0 0 14px rgba(255,255,255,.6); }
.info { margin:6px 0 12px; color:var(--dim); min-height:20px; }
.info b { color:var(--text); }
.legend { color:var(--dim); font-size:12px; margin-top:10px; }
.swatch { display:inline-block; width:12px; height:12px; border-radius:3px; vertical-align:-2px; margin:0 4px 0 10px; }
.win { color:#7dff3a; font-weight:700; } .dead { color:#ff2950; font-weight:700; }
</style></head>
<body><main>
<div class="grid top">
  <div>
    <h1>${esc(level.name)}</h1>
    <div class="sub">id <b>${esc(level.id)}</b> · ${level.width}×${level.height} · ${level.palette.length} colors · ${pods.length} pods · ${level.lanes} lanes · ${level.columns.length} columns · tick ${level.tickMs}ms · seed ${level.meta.seed} · ${esc(level.meta.generatorVersion)}</div>
    <div class="sub">${timing}</div>
  </div>
  <div style="text-align:right"><div class="dim">difficulty</div><div class="score">${level.meta.difficulty.toFixed(2)}</div><div class="dim">target ${level.meta.targetDifficulty.toFixed(2)}</div></div>
</div>

<div class="panel grid imgs">
  <figure><img src="${imgs.original}" alt="original"><figcaption>original PNG</figcaption></figure>
  <figure><img src="${imgs.simple}" alt="simplified"><figcaption>simplified (${level.palette.length} source colors)</figcaption></figure>
  <figure><img src="${imgs.neon}" alt="neon"><figcaption>neon board (keys ringed)</figcaption></figure>
</div>

<div class="grid two">
  <div class="panel">
    <h2>Stats</h2>
    <table>${statRows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>
    <h2 style="margin-top:16px">Knobs</h2>
    <pre>${esc(input.knobs)}</pre>
  </div>
  <div class="panel">
    <h2>Generator log</h2>
    <pre>${esc(input.summary.join('\n'))}</pre>
  </div>
</div>

<div class="panel replay">
  <h2>Solution replay (settled play)</h2>
  <div class="controls">
    <button id="first">⏮</button><button id="prev">◀ prev</button><button id="play">▶ play</button><button id="next">next ▶</button><button id="last">⏭</button>
    <input type="range" id="slider" min="0" value="0">
    <span id="stepLabel" class="dim"></span>
  </div>
  <div class="info" id="info"></div>
  <div class="stage">
    <canvas id="board"></canvas>
    <div>
      <h2>Lanes</h2>
      <div class="lanes" id="lanes"></div>
      <h2>Columns <span class="dim" style="text-transform:none;letter-spacing:0">(front on top · white ring = next solution tap)</span></h2>
      <div class="cols" id="cols"></div>
      <div class="legend">striped = hidden (true color shown as border) · dashed outline = locked (K = key id) · ⇄ = linked partner · red pulse = stalled lane</div>
    </div>
  </div>
</div>
</main>
<script id="data" type="application/json">${json.replace(/</g, '\\u003c')}</script>
<script>
const D = JSON.parse(document.getElementById('data').textContent);
const L = D.level, F = D.frames, W = L.width, H = L.height;
const pal = L.palette;
const podById = new Map();
L.columns.forEach((col, c) => col.forEach((p) => podById.set(p.id, { ...p, col: c })));
const cv = document.getElementById('board');
const cs = Math.max(6, Math.min(28, Math.floor(520 / Math.max(W, H))));
cv.width = W * cs; cv.height = H * cs;
const ctx = cv.getContext('2d');
const slider = document.getElementById('slider');
slider.max = F.length - 1;
let cur = 0, timer = null;

function drawBoard(f, prev) {
  ctx.fillStyle = '#07050f'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.strokeStyle = 'rgba(80,60,140,.18)'; ctx.lineWidth = 1;
  for (let x = 0; x <= W; x++) { ctx.beginPath(); ctx.moveTo(x*cs+.5, 0); ctx.lineTo(x*cs+.5, H*cs); ctx.stroke(); }
  for (let y = 0; y <= H; y++) { ctx.beginPath(); ctx.moveTo(0, y*cs+.5); ctx.lineTo(W*cs, y*cs+.5); ctx.stroke(); }
  for (let i = 0; i < W*H; i++) {
    const ch = f.cells[i], x = i % W, y = (i - x) / W;
    if (ch === '.') {
      if (prev && prev.cells[i] !== '.') {   // drained this step
        ctx.strokeStyle = pal[parseInt(prev.cells[i], 36)]; ctx.globalAlpha = .55; ctx.lineWidth = 1;
        ctx.strokeRect(x*cs+2.5, y*cs+2.5, cs-5, cs-5); ctx.globalAlpha = 1;
      }
      continue;
    }
    const col = pal[parseInt(ch, 36)];
    ctx.shadowColor = col; ctx.shadowBlur = cs * .6; ctx.fillStyle = col;
    ctx.fillRect(x*cs+1, y*cs+1, cs-2, cs-2);
  }
  ctx.shadowBlur = 0;
  for (const k of f.keys) {
    const cx = k.x*cs + cs/2, cy = k.y*cs + cs/2;
    ctx.fillStyle = '#0a0814'; ctx.beginPath(); ctx.arc(cx, cy, cs*.36, 0, 7); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = 'bold ' + Math.max(8, cs*.45) + 'px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('K' + k.id, cx, cy + 1);
  }
}

function podEl(p, nextId) {
  const truth = podById.get(p.id);
  const el = document.createElement('div');
  el.className = 'pod' + (p.hidden ? ' hidden' : '') + (p.locked ? ' locked' : '') + (p.id === nextId ? ' next' : '');
  el.style.background = pal[truth.color];
  if (p.hidden) el.style.border = '2px solid ' + pal[truth.color];
  const left = document.createElement('span');
  left.textContent = p.hidden ? '? ' + truth.capacity : String(truth.capacity);
  el.appendChild(left);
  const tags = [];
  if (p.locked) tags.push('K' + p.lock);
  if (p.link !== null) tags.push('⇄' + p.link);
  if (p.hidden) tags.push('hid');
  tags.push('#' + p.id);
  const t = document.createElement('span'); t.className = 'tag'; t.textContent = tags.join(' ');
  el.appendChild(t);
  return el;
}

function render(i) {
  cur = i; slider.value = i;
  const f = F[i], prev = i > 0 ? F[i-1] : null, nextF = F[i+1];
  drawBoard(f, prev);
  const lanes = document.getElementById('lanes'); lanes.innerHTML = '';
  f.lanes.forEach((l, li) => {
    const el = document.createElement('div');
    if (!l) { el.className = 'lane'; el.innerHTML = '<span class="dim">lane ' + (li+1) + ' · free</span>'; lanes.appendChild(el); return; }
    el.className = 'lane full ' + l.state;
    el.style.borderColor = pal[l.color];
    el.style.boxShadow = '0 0 12px ' + pal[l.color] + '55';
    el.innerHTML = '<b style="color:' + pal[l.color] + '">#' + l.podId + (l.link !== null ? ' ⇄' + l.link : '') + '</b><span>' + (l.capacity - l.remaining) + ' / ' + l.capacity + '</span><span class="dim">' + l.state + '</span><div class="fill" style="background:' + pal[l.color] + ';width:' + (100 * (l.capacity - l.remaining) / l.capacity) + '%"></div>';
    lanes.appendChild(el);
  });
  const nextCol = i < L.solution.length ? L.solution[i] : -1;
  const nextId = nextCol >= 0 && f.columns[nextCol].length ? f.columns[nextCol][0].id : -1;
  const cols = document.getElementById('cols'); cols.innerHTML = '';
  f.columns.forEach((col, c) => {
    const el = document.createElement('div'); el.className = 'col' + (c === f.tapped ? ' tapped' : '');
    const h = document.createElement('h3'); h.textContent = 'COL ' + c; el.appendChild(h);
    col.forEach((p) => el.appendChild(podEl(p, nextId)));
    if (!col.length) { const e = document.createElement('div'); e.className = 'dim'; e.style.fontSize = '11px'; e.textContent = 'empty'; el.appendChild(e); }
    cols.appendChild(el);
  });
  const left = [...f.cells].filter((ch) => ch !== '.').length;
  let msg;
  if (i === 0) msg = 'Start. <b>' + left + '</b> cells. Next tap: column <b>' + nextCol + '</b>.';
  else {
    const tappedPod = prev.columns[f.tapped][0];
    const truth = podById.get(tappedPod.id);
    const pair = truth.link !== undefined ? ' + partner #' + truth.link : '';
    const stalled = f.lanes.filter((l) => l && l.state === 'stalled').length;
    msg = 'Step <b>' + i + '</b>: tapped column <b>' + f.tapped + '</b> → pod #' + truth.id + pair + ' (<span style="color:' + pal[truth.color] + '">■</span> cap ' + truth.capacity + ')' +
      (D.stalledPod[i-1] ? ' <b style="color:#ff2950">stalls</b>' : ' completes') + ' · drained <b>' + f.drained + '</b> · <b>' + left + '</b> left · stalled lanes ' + stalled + '/' + L.lanes;
    if (f.won) msg += ' · <span class="win">WON</span>';
    if (f.dead) msg += ' · <span class="dead">DEAD</span>';
  }
  document.getElementById('info').innerHTML = msg;
  document.getElementById('stepLabel').textContent = 'step ' + i + ' / ' + (F.length - 1);
}
const go = (i) => render(Math.max(0, Math.min(F.length - 1, i)));
document.getElementById('first').onclick = () => go(0);
document.getElementById('last').onclick = () => go(F.length - 1);
document.getElementById('prev').onclick = () => go(cur - 1);
document.getElementById('next').onclick = () => go(cur + 1);
slider.oninput = () => go(+slider.value);
document.getElementById('play').onclick = (e) => {
  if (timer) { clearInterval(timer); timer = null; e.target.textContent = '▶ play'; return; }
  if (cur >= F.length - 1) go(0);
  e.target.textContent = '❚❚ pause';
  timer = setInterval(() => { if (cur >= F.length - 1) { clearInterval(timer); timer = null; document.getElementById('play').textContent = '▶ play'; return; } go(cur + 1); }, 700);
};
document.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') go(cur + 1); if (e.key === 'ArrowLeft') go(cur - 1); });
render(0);
</script>
</body></html>`;
}

function pct(v: number): string {
    return `${(v * 100).toFixed(1)}%`;
}
