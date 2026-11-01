import { beforeEach, describe, expect, test } from 'bun:test';
import { introKey, levelMechanics, unseenMechanics } from '@game/mechanics';
import { getRunState, hasSeen, runActions } from '@game/state';
import { parseFlags } from '@game/urlParams';
import { lvl } from './helpers';

const plain = lvl('0011', [[[0, 2]], [[1, 2]]], 2);
const mixed = lvl(
    `
    0011
    0.12
`,
    [[[0, 3], { color: 1, capacity: 3, hidden: true }], [{ color: 2, capacity: 1, lock: 5 }], [[1, 1]]],
    2,
    [{ id: 5, x: 1, y: 0 }],
);

describe('mechanic intro cards', () => {
    beforeEach(() => runActions.reset());

    test('levelMechanics lists hidden, locked and linked pods in card order', () => {
        expect(levelMechanics(plain)).toEqual([]);
        expect(levelMechanics(mixed)).toEqual(['hidden', 'locked']);
        const linked = { columns: [[{ id: 1, color: 0, capacity: 1, link: 2 }], [{ id: 2, color: 0, capacity: 1, link: 1 }]] };
        expect(levelMechanics(linked)).toEqual(['linked']);
    });

    test('a card shows once: markSeen hides it for later levels', () => {
        expect(unseenMechanics(mixed, hasSeen).map((m) => m.id)).toEqual(['hidden', 'locked']);
        runActions.markSeen(introKey('hidden'));
        expect(unseenMechanics(mixed, hasSeen).map((m) => m.id)).toEqual(['locked']);
        runActions.markSeen(introKey('locked'));
        expect(unseenMechanics(mixed, hasSeen)).toEqual([]);
        expect(getRunState().firstSeen[introKey('hidden')]).toBe(true);
    });

    test('resetSeen forgets the cards', () => {
        runActions.markSeen(introKey('locked'));
        runActions.resetSeen();
        expect(unseenMechanics(mixed, hasSeen).map((m) => m.id)).toEqual(['hidden', 'locked']);
    });

    test('?intro=off flag', () => {
        expect(parseFlags('?intro=off').introOff).toBe(true);
        expect(parseFlags('').introOff).toBe(false);
    });
});
