/**
 * Headless leak check: `bun tools/dev/leak.ts [restarts=20] [roundTrips=10] [level=heart]`.
 * Measures per-scene display-list size, active tweens, timers, particle emitters, event listeners, PlaybackRunner
 * listeners, textures, cameras, `window`/`document` listeners (net since the probe was installed), and audio
 * scheduler state. Runs N pause-menu restarts (the scene's own restart path) and M level-select <-> play round trips,
 * then prints before/after numbers. Exit code 1 if anything grew.
 */
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';

const [restarts = '20', roundTrips = '10', level = 'heart'] = process.argv.slice(2);
const server = await createServer({
    configFile: 'vite/config.dev.mjs',
    logLevel: 'error',
    server: { port: 0, strictPort: false, host: '127.0.0.1' },
});
await server.listen();
const addr = server.httpServer?.address();
const port = typeof addr === 'object' && addr ? addr.port : 8080;

/** Runs in the page. Counts everything we can observe for the running scenes. */
const PROBE = `(() => {
    const F = window.__FLOW__;
    const game = F.game;
    const listeners = (ee) => {
        const ev = ee && ee._events;
        if (!ev) return 0;
        let n = 0;
        for (const k of Object.keys(ev)) n += Array.isArray(ev[k]) ? ev[k].length : 1;
        return n;
    };
    const out = { scenes: {}, global: {} };
    for (const s of game.scene.getScenes(false)) {
        const key = s.scene.key;
        if (!['Play', 'LevelSelect'].includes(key) || !s.sys.isActive()) continue;
        const list = s.children.list;
        out.scenes[key] = {
            children: list.length,
            emitters: list.filter((o) => o.type === 'ParticleEmitter').length,
            tweens: s.tweens.getTweens().length,
            timers: s.time._active.length + s.time._pendingInsertion.length,
            sceneEvents: listeners(s.events),
            sysEvents: listeners(s.sys.events),
            inputEvents: listeners(s.input),
            cameras: s.cameras.cameras.length,
            runnerListeners: s.runner ? s.runner.listeners.length : undefined,
        };
    }
    out.global = {
        textures: game.textures.getTextureKeys().length,
        gameEvents: listeners(game.events),
        domListeners: window.__LEAK__ ? window.__LEAK__.net() : -1,
        audio: F.audio.stats(),
    };
    return out;
})()`;

const INSTALL = `(() => {
    const counts = new Map();
    const key = (t, type) => t.constructor.name + ':' + type;
    for (const proto of [window, document]) {
        const add = proto.addEventListener.bind(proto);
        const rem = proto.removeEventListener.bind(proto);
        const id = proto === window ? 'window' : 'document';
        proto.addEventListener = (type, fn, opts) => { counts.set(id + ':' + type + ':' + (fn && fn.name || ''), (counts.get(id + ':' + type + ':' + (fn && fn.name || '')) || 0) + 1); return add(type, fn, opts); };
        proto.removeEventListener = (type, fn, opts) => { counts.set(id + ':' + type + ':' + (fn && fn.name || ''), (counts.get(id + ':' + type + ':' + (fn && fn.name || '')) || 0) - 1); return rem(type, fn, opts); };
    }
    window.__LEAK__ = { net: () => [...counts.values()].reduce((a, b) => a + b, 0), counts };
    return true;
})()`;

let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
let grew = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
try {
    browser = await puppeteer.launch({
        browser: 'firefox',
        executablePath: '/usr/bin/firefox',
        headless: true,
        extraPrefsFirefox: { 'webgl.force-enabled': true, 'webgl.disabled': false },
        defaultViewport: { width: 720, height: 1280 },
    });
    const page = await browser.newPage();
    page.on('pageerror', (err) => console.log(`[pageerror] ${err instanceof Error ? err.message : String(err)}`));
    await page.goto(`http://127.0.0.1:${port}/?level=${level}&intro=off&speed=2`, { waitUntil: 'load' });
    await sleep(2500);
    await page.mouse.click(5, 5); // a real gesture: creates the AudioContext, so the music scheduler is exercised too
    await sleep(500);
    await page.evaluate(INSTALL);

    const probe = async (label: string) => {
        const r = (await page.evaluate(PROBE)) as { scenes: Record<string, Record<string, number>>; global: Record<string, unknown> };
        console.log(`${label.padEnd(26)} ${JSON.stringify(r)}`);
        return r;
    };
    const evalIn = (code: string) => page.evaluate(`(() => { const g = window.__FLOW__.game; ${code} })()`);

    const base = await probe('play #1 (baseline)');
    for (let i = 1; i <= Number(restarts); i++) {
        await evalIn(`g.scene.getScene('Play').restartLevel(); return 1;`);
        await sleep(700);
        if (i % 5 === 0) await probe(`after ${i} restarts (clean)`);
        // Tap a few columns so pods fly, goo streams and particles run before the next restart.
        for (const col of [0, 1, 2]) await evalIn(`const p = g.scene.getScene('Play'); if (p.ready) p.tapColumn(${col}); return 1;`);
        await sleep(250);
    }
    await evalIn(`g.scene.getScene('Play').restartLevel(); return 1;`);
    await sleep(900);
    const afterRestarts = await probe('final restart (clean)');

    await evalIn(`g.scene.getScene('Play').toLevelSelect(); return 1;`);
    await sleep(1200);
    const lsBase = await probe('level select #1');
    let playFirst: Awaited<ReturnType<typeof probe>> | undefined;
    let playLast: Awaited<ReturnType<typeof probe>> | undefined;
    for (let i = 1; i <= Number(roundTrips); i++) {
        await evalIn(`g.scene.getScene('LevelSelect').scene.start('Play', { levelId: '${level}' }); return 1;`);
        await sleep(1100);
        if (i === 1) playFirst = await probe('play, round trip 1 (clean)');
        if (i === Number(roundTrips)) playLast = await probe(`play, round trip ${i} (clean)`);
        await evalIn(`const p = g.scene.getScene('Play'); if (p.ready) p.tapColumn(0); return 1;`);
        await sleep(300);
        await evalIn(`g.scene.getScene('Play').toLevelSelect(); return 1;`);
        await sleep(900);
        if (i % 5 === 0) await probe(`after ${i} round trips (LS)`);
    }
    await sleep(1000);
    const lsAfter = await probe('level select, after trips');

    const compare = (name: string, a: Record<string, number> | undefined, b: Record<string, number> | undefined) => {
        if (!a || !b) return;
        for (const k of Object.keys(a)) {
            if (typeof a[k] !== 'number' || (b[k] ?? 0) <= a[k]!) continue;
            grew = true;
            console.log(`GROWTH ${name}.${k}: ${a[k]} -> ${b[k]}`);
        }
    };
    const compareGlobal = (name: string, a: Record<string, unknown>, b: Record<string, unknown>) => {
        for (const k of ['textures', 'gameEvents', 'domListeners']) {
            const x = a[k] as number;
            const y = b[k] as number;
            if (y <= x) continue;
            grew = true;
            console.log(`GROWTH ${name}.global.${k}: ${x} -> ${y}`);
        }
    };
    compare('Play after restarts', base.scenes.Play, afterRestarts.scenes.Play);
    compareGlobal('restarts', base.global, afterRestarts.global);
    compare('Play after trips', playFirst?.scenes.Play, playLast?.scenes.Play);
    if (playFirst && playLast) compareGlobal('trips(play)', playFirst.global, playLast.global);
    compare('LevelSelect after trips', lsBase.scenes.LevelSelect, lsAfter.scenes.LevelSelect);
    compareGlobal('trips(LS)', lsBase.global, lsAfter.global);
    console.log(grew ? 'RESULT: growth detected' : 'RESULT: no growth');
} catch (err) {
    grew = true;
    console.log(`[leak error] ${err instanceof Error ? err.stack : String(err)}`);
} finally {
    await browser?.close().catch(() => {});
    await server.close();
}
process.exit(grew ? 1 : 0);
