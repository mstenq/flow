import { describe, expect, test } from 'bun:test';
import { Lru } from '@game/lru';

describe('Lru', () => {
    test('evicts the least recently used key when over capacity', () => {
        const lru = new Lru<string>(3);
        expect(lru.touch('a')).toEqual([]);
        lru.touch('b');
        lru.touch('c');
        expect(lru.touch('d')).toEqual(['a']);
        expect(lru.keys()).toEqual(['b', 'c', 'd']);
        expect(lru.has('a')).toBe(false);
    });

    test('touching an existing key refreshes it', () => {
        const lru = new Lru<string>(3);
        for (const k of ['a', 'b', 'c']) lru.touch(k);
        expect(lru.touch('a')).toEqual([]);
        expect(lru.touch('d')).toEqual(['b']);
        expect(lru.keys()).toEqual(['c', 'a', 'd']);
    });

    test('pinned keys are skipped and the next oldest goes instead', () => {
        const lru = new Lru<string>(3);
        for (const k of ['a', 'b', 'c']) lru.touch(k);
        expect(lru.touch('d', (k) => k === 'a')).toEqual(['b']);
        expect(lru.keys()).toEqual(['a', 'c', 'd']);
    });

    test('stays over capacity rather than evicting pinned keys', () => {
        const lru = new Lru<string>(2);
        lru.touch('a');
        lru.touch('b');
        expect(lru.touch('c', () => true)).toEqual([]);
        expect(lru.size).toBe(3);
        expect(lru.touch('d')).toEqual(['a', 'b']);
        expect(lru.keys()).toEqual(['c', 'd']);
    });

    test('never grows past capacity under a long scan, and the evicted list covers everything dropped', () => {
        const lru = new Lru<number>(48);
        const alive = new Set<number>();
        for (let i = 0; i < 1000; i++) {
            alive.add(i);
            for (const k of lru.touch(i)) alive.delete(k);
            expect(lru.size).toBeLessThanOrEqual(48);
        }
        expect(alive.size).toBe(48);
        expect([...alive].sort((x, y) => x - y)[0]).toBe(1000 - 48);
    });

    test('clear returns every key; capacity must be positive', () => {
        const lru = new Lru<string>(2);
        lru.touch('a');
        lru.touch('b');
        expect(lru.clear()).toEqual(['a', 'b']);
        expect(lru.size).toBe(0);
        expect(() => new Lru(0)).toThrow();
    });
});
