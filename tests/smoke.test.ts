import { expect, test } from 'bun:test';
import { parseFlags, parseStartTarget } from '@game/urlParams';

test('smoke', () => {
    expect(1 + 1).toBe(2);
});

test('parseStartTarget', () => {
    expect(parseStartTarget('')).toEqual({ scene: 'LevelSelect' });
    expect(parseStartTarget('?spike=1')).toEqual({ scene: 'Spike' });
    expect(parseStartTarget('?level=abc')).toEqual({ scene: 'Play', data: { levelId: 'abc' } });
    expect(parseStartTarget('level=abc&spike=1')).toEqual({ scene: 'Spike' });
    expect(parseStartTarget('?level=')).toEqual({ scene: 'LevelSelect' });
});

test('parseFlags', () => {
    expect(parseFlags('?debug=1').debug).toBe(true);
    expect(parseFlags('').debug).toBe(false);
});
