/** bun tools/gen/sweep-shot.ts <out.png> [--html path] [--q text] [--sort key] [--status ok|failed] [--skip N] [--rows N] — screenshot part of sweep.html. */
import puppeteer from 'puppeteer-core';
import { join } from 'node:path';
import { REPORT_OUT } from './output.ts';

const a = process.argv.slice(2);
const flag = (n: string, d = '') => (a.includes(n) ? a[a.indexOf(n) + 1] : d);
const out = a.find((x, i) => !x.startsWith('--') && !a[i - 1]?.startsWith('--')) ?? '/tmp/sweep.png';
const html = flag('--html', join(REPORT_OUT, 'sweep.html'));
const skip = Number(flag('--skip', '0'));
const rows = Number(flag('--rows', '3'));
const browser = await puppeteer.launch({ browser: 'firefox', executablePath: '/usr/bin/firefox', headless: true, defaultViewport: { width: 1500, height: 1000 } });
try {
    const page = await browser.newPage();
    await page.goto('file://' + html);
    await page.evaluate(
        (q, sort, status) => {
            const set = (id: string, v: string) => {
                const el = document.getElementById(id) as HTMLInputElement;
                el.value = v;
                el.dispatchEvent(new Event('input'));
            };
            set('q', q);
            if (sort) set('sort', sort);
            if (status) set('status', status);
        },
        flag('--q'),
        flag('--sort'),
        flag('--status'),
    );
    const tiles = await page.$$('.tile');
    const slice = tiles.slice(skip, skip + rows * Number(flag('--cols', '4')));
    await page.evaluate((s, n) => {
        const t = [...document.querySelectorAll('.tile')] as HTMLElement[];
        t.forEach((el, i) => (el.style.display = i >= s && i < s + n ? '' : 'none'));
    }, skip, rows * Number(flag('--cols', '4')));
    if (a.includes('--compact')) await page.addStyleTag({ content: '.imgs img{width:100px;height:100px}.meta{font-size:11px;grid-template-columns:1fr}#grid{grid-template-columns:repeat(auto-fill,minmax(230px,1fr))}header{display:none}' });
    await page.screenshot({ path: out as `${string}.png`, fullPage: true });
    console.log(`wrote ${out} (${slice.length} tiles)`);
} finally {
    await browser.close();
}
