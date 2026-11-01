import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const positional: string[] = [];
let wait = 2000;
let size = '720x1280';
for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--wait') wait = Number(args[++i]);
    else if (a === '--size') size = args[++i]!;
    else positional.push(a);
}
const [query = '', out = '/tmp/flow-shot.png'] = positional;
const [w, h] = size.split('x').map(Number) as [number, number];

const server = await createServer({
    configFile: 'vite/config.dev.mjs',
    logLevel: 'error',
    server: { port: 0, strictPort: false, host: '127.0.0.1' },
});
await server.listen();
const addr = server.httpServer?.address();
const port = typeof addr === 'object' && addr ? addr.port : 8080;

let hadPageError = false;
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
try {
    browser = await puppeteer.launch({
        browser: 'firefox',
        executablePath: '/usr/bin/firefox',
        headless: true,
        extraPrefsFirefox: {
            'webgl.force-enabled': true,
            'webgl.disabled': false,
        },
        defaultViewport: { width: w, height: h },
    });
    const page = await browser.newPage();
    page.on('console', (msg) => {
        if (msg.type() === 'error') console.log(`[console.error] ${msg.text()}`);
    });
    page.on('pageerror', (err) => {
        hadPageError = true;
        console.log(`[pageerror] ${err instanceof Error ? err.message : String(err)}`);
    });
    await page.goto(`http://127.0.0.1:${port}/?${query}`, { waitUntil: 'load' });
    await new Promise((r) => setTimeout(r, wait));
    const renderer = await page.evaluate(() => window.__FLOW__?.rendererType ?? 'unknown (window.__FLOW__ missing)');
    console.log(`renderer: ${renderer}`);
    await page.screenshot({ path: out as `${string}.png` });
    console.log(`saved ${out}`);
} catch (err) {
    hadPageError = true;
    console.log(`[shot error] ${err instanceof Error ? err.message : String(err)}`);
} finally {
    await browser?.close().catch(() => {});
    await server.close();
}
process.exit(hadPageError ? 1 : 0);
