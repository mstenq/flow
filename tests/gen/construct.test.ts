import { describe, expect, test } from 'bun:test';
import { Rng } from '@game/rng';
import { replay, toLevel, traceSolution } from '../../tools/gen/board';
import { construct, deal } from '../../tools/gen/construct';
import { sampleKnobs } from '../../tools/gen/knobs';
import { fixtureBoards } from './fixtures';

describe('construct', () => {
    test('200 random seeds on 3 fixture boards all replay to a win', () => {
        const boards = fixtureBoards();
        let overflow = 0;
        for (let seed = 0; seed < 200; seed++) {
            const { name, board } = boards[seed % boards.length];
            const rng = new Rng(seed * 7919 + 13);
            const knobs = sampleKnobs(rng.next(), rng);
            const built = construct(board, knobs, rng);
            const level = toLevel(board, built.layout, { id: `${name}-${seed}`, name });
            const r = replay(level);
            if (!r.won) throw new Error(`${name} seed ${seed}: ${r.reason}`);
            // Totals per color are exact and every column is non-empty.
            for (let c = 0; c < board.numColors; c++) {
                const total = built.order.filter((p) => p.color === c).reduce((s, p) => s + p.capacity, 0);
                expect(total).toBe(board.counts[c]);
            }
            expect(level.columns.every((col) => col.length > 0)).toBe(true);
            // The stall budget is respected: a lane is always free after a settle (until the win).
            const trace = traceSolution(level, false);
            trace.stalledAfter.slice(0, -1).forEach((s) => expect(s).toBeLessThan(level.lanes));
            overflow += built.order.filter((p) => p.kind !== 'fit').length;
        }
        // Harder knobs really do produce stalling pods.
        expect(overflow).toBeGreaterThan(20);
    });

    test('deal is order-preserving and fills every column', () => {
        const rng = new Rng(5);
        for (const style of ['balanced', 'random', 'clumped', 'roundrobin'] as const) {
            for (let n = 3; n < 30; n += 4) {
                const cols = deal(n, 3, style, rng);
                expect(cols.length).toBe(n);
                expect(new Set(cols).size).toBe(3);
            }
        }
    });

    test('zero overflow knobs build only fit pods', () => {
        const { board } = fixtureBoards()[2];
        const rng = new Rng(9);
        const knobs = { ...sampleKnobs(0, rng), overflowRate: 0, parkRate: 0 };
        const built = construct(board, knobs, rng);
        expect(built.order.every((p) => p.kind === 'fit')).toBe(true);
    });
});
