/** Seeded PRNG utilities. Never use `Math.random` in sim/generator code. */

/** mulberry32: returns a function producing floats in [0, 1). */
export function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** FNV-1a 32-bit string hash (e.g. default seed from a level id). */
export function hashString(s: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

/** Integer mixer (murmur3 fmix32). Deterministic 32-bit hash of a 32-bit int. */
export function mix32(x: number): number {
    let h = x | 0;
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h | 0;
}

export class Rng {
    private readonly gen: () => number;

    constructor(seed: number) {
        this.gen = mulberry32(seed);
    }

    /** Float in [0, 1). */
    next(): number {
        return this.gen();
    }

    /** Float in [min, max). */
    float(min: number, max: number): number {
        return min + (max - min) * this.gen();
    }

    /** Integer in [min, max] (both inclusive). */
    int(min: number, max: number): number {
        return min + Math.floor(this.gen() * (max - min + 1));
    }

    /** Integer in [0, n). */
    below(n: number): number {
        return Math.floor(this.gen() * n);
    }

    /** True with probability p. */
    chance(p: number): boolean {
        return this.gen() < p;
    }

    /** Uniform element of a non-empty array. */
    pick<T>(arr: readonly T[]): T {
        if (arr.length === 0) throw new Error('Rng.pick: empty array');
        return arr[Math.floor(this.gen() * arr.length)];
    }

    /** Fisher–Yates shuffle in place; returns the same array. */
    shuffle<T>(arr: T[]): T[] {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(this.gen() * (i + 1));
            const tmp = arr[i];
            arr[i] = arr[j];
            arr[j] = tmp;
        }
        return arr;
    }

    /** Index chosen with probability proportional to `weights[i]` (non-negative). Returns -1 if all weights are 0. */
    weighted(weights: readonly number[]): number {
        let total = 0;
        for (const w of weights) total += Math.max(0, w);
        if (total <= 0) return -1;
        let r = this.gen() * total;
        for (let i = 0; i < weights.length; i++) {
            const w = Math.max(0, weights[i]);
            if (r < w) return i;
            r -= w;
        }
        for (let i = weights.length - 1; i >= 0; i--) {
            if (weights[i] > 0) return i;
        }
        return -1;
    }

    /** Child RNG with an independent stream, derived deterministically. */
    fork(): Rng {
        return new Rng(Math.floor(this.gen() * 4294967296));
    }
}

export function createRng(seed: number): Rng {
    return new Rng(seed);
}
