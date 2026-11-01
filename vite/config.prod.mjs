import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { readdirSync, rmSync } from 'node:fs';

const r = (p) => fileURLToPath(new URL(p, import.meta.url));

/** The dev-only test levels (`public/levels/dev-*.json`) are not part of the game: drop them from `dist/levels/`. */
const stripDevLevels = () => ({
    name: 'strip-dev-levels',
    apply: 'build',
    closeBundle() {
        const dir = r('../dist/levels');
        let files = [];
        try {
            files = readdirSync(dir);
        } catch {
            return;
        }
        for (const f of files) {
            if (f.startsWith('dev-') && f.endsWith('.json')) rmSync(`${dir}/${f}`);
        }
    },
});

export default defineConfig({
    base: './',
    resolve: {
        alias: {
            '@game': r('../src/game'),
            '@data': r('../src/data')
        }
    },
    logLevel: 'warning',
    build: {
        rollupOptions: {
            output: {
                manualChunks: {
                    phaser: ['phaser']
                }
            }
        },
        minify: 'terser',
        terserOptions: {
            compress: {
                passes: 2
            },
            mangle: true,
            format: {
                comments: false
            }
        }
    },
    server: {
        port: 8080
    },
    plugins: [stripDevLevels()]
});
