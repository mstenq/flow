/**
 * Scripted headless session: `bun tools/dev/interact.ts "<query>" step step ...`
 * Steps: `wait:<ms>`, `click:<x>,<y>`, `key:<Key>`, `shot:<path.png>`, `fps` (prints the game loop FPS),
 *        `scene` (prints the active scene keys), `drag:<x1>,<y1>,<x2>,<y2>[,<steps>[,<stepMs>]]` (press, move, release),
 *        `wheel:<dy>` (mouse wheel at the screen center), `goto:<query>` (navigate to a new query string),
 *        `reload` (reload the page; localStorage survives), `storage` (prints the saved progress JSON),
 *        `eval:<js expression>` (evaluate in the page and print the JSON result; `__FLOW__` is available in dev),
 *        `hide` / `show` (fake the page being hidden / visible: fires `visibilitychange`),
 *        `resize:<WxH>` (resize the viewport), `down:<x>,<y>` / `up` (press and hold, then release the mouse).
 * Env: `FLOW_PROD=1` tests the production build in dist/ (no `__FLOW__`, so `eval`/`fps`/`scene` steps are limited).
 * Example: bun tools/dev/interact.ts "level=dev-basic&autoplay=random&speed=2" wait:15000 shot:/tmp/a.png click:360,680 wait:1500 shot:/tmp/b.png
 */
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import type { Game } from 'phaser';

const [query = '', ...steps] = process.argv.slice(2);

/**
 * `FLOW_PROD=1` serves the production build in `dist/` (run `bun run build` first) instead of the Vite dev server,
 * to check the real bundle: no `window.__FLOW__`, no DEV levels, no hotkeys without `?debug=1`.
 */
const prod = process.env.FLOW_PROD === '1';
const distServer = prod
    ? Bun.serve({
          port: 0,
          hostname: '127.0.0.1',
          async fetch(req) {
              const path = decodeURIComponent(new URL(req.url).pathname);
              const file = Bun.file(`dist${path === '/' ? '/index.html' : path}`);
              return (await file.exists()) ? new Response(file) : new Response('not found', { status: 404 });
          },
      })
    : null;
const server = distServer
    ? null
    : await createServer({
          configFile: 'vite/config.dev.mjs',
          logLevel: 'error',
          server: { port: 0, strictPort: false, host: '127.0.0.1' },
      });
await server?.listen();
const addr = server?.httpServer?.address();
const port = distServer ? distServer.port : typeof addr === 'object' && addr ? addr.port : 8080;
let failed = false;
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
try {
    browser = await puppeteer.launch({
        browser: 'firefox',
        executablePath: '/usr/bin/firefox',
        headless: true,
        extraPrefsFirefox: { 'webgl.force-enabled': true, 'webgl.disabled': false },
        defaultViewport: { width: 720, height: 1280 },
    });
    const page = await browser.newPage();
    page.on('console', (msg) => {
        if (msg.type() === 'error') console.log(`[console.error] ${msg.text()}`);
    });
    page.on('pageerror', (err) => {
        failed = true;
        console.log(`[pageerror] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    });
    await page.goto(`http://127.0.0.1:${port}/?${query}`, { waitUntil: 'load' });
    for (const step of steps) {
        const [cmd, arg = ''] = [step.slice(0, step.indexOf(':') < 0 ? undefined : step.indexOf(':')), step.includes(':') ? step.slice(step.indexOf(':') + 1) : ''];
        if (cmd === 'wait') await new Promise((r) => setTimeout(r, Number(arg)));
        else if (cmd === 'drag') {
            const [x1, y1, x2, y2, steps = 8, stepMs = 16] = arg.split(',').map(Number) as [number, number, number, number, number?, number?];
            await page.mouse.move(x1, y1);
            await page.mouse.down();
            for (let i = 1; i <= steps; i++) {
                await page.mouse.move(x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps);
                await new Promise((r) => setTimeout(r, stepMs));
            }
            await page.mouse.up();
        } else if (cmd === 'wheel') {
            await page.mouse.move(360, 700);
            await page.mouse.wheel({ deltaY: Number(arg) });
        } else if (cmd === 'goto') {
            await page.goto(`http://127.0.0.1:${port}/?${arg}`, { waitUntil: 'load' });
        } else if (cmd === 'reload') {
            await page.reload({ waitUntil: 'load' });
        } else if (cmd === 'storage') {
            const json = await page.evaluate(() => window.localStorage.getItem('flow.progress.v1'));
            console.log(`storage ${json}`);
        } else if (cmd === 'eval') {
            const value = await page.evaluate(arg);
            console.log(`eval ${JSON.stringify(value)}`);
        } else if (cmd === 'hide' || cmd === 'show') {
            await page.evaluate((hidden) => {
                Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
                document.dispatchEvent(new Event('visibilitychange'));
            }, cmd === 'hide');
        } else if (cmd === 'resize') {
            const [w, h] = arg.split('x').map(Number) as [number, number];
            await page.setViewport({ width: w, height: h });
        } else if (cmd === 'down') {
            const [x, y] = arg.split(',').map(Number) as [number, number];
            await page.mouse.move(x, y);
            await page.mouse.down();
        } else if (cmd === 'up') {
            await page.mouse.up();
        } else if (cmd === 'click') {
            const [x, y] = arg.split(',').map(Number) as [number, number];
            await page.mouse.click(x, y);
        } else if (cmd === 'key') await page.keyboard.press(arg as Parameters<typeof page.keyboard.press>[0]);
        else if (cmd === 'shot') {
            await page.screenshot({ path: arg as `${string}.png` });
            console.log(`saved ${arg}`);
        } else if (cmd === 'fps') {
            const fps = await page.evaluate(() => (window as unknown as { __FLOW__?: { game: Game } }).__FLOW__?.game.loop.actualFps ?? -1);
            console.log(`fps ${fps.toFixed(1)}`);
        } else if (cmd === 'scene') {
            const keys = await page.evaluate(() =>
                (window as unknown as { __FLOW__?: { game: Game } }).__FLOW__?.game.scene.getScenes(true).map((s) => s.scene.key) ?? [],
            );
            console.log(`scenes ${keys.join(',')}`);
        } else console.log(`unknown step ${step}`);
    }
} catch (err) {
    failed = true;
    console.log(`[interact error] ${err instanceof Error ? err.message : String(err)}`);
} finally {
    await browser?.close().catch(() => {});
    await server?.close();
    await distServer?.stop(true);
}
process.exit(failed ? 1 : 0);
