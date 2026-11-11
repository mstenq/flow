/**
 * Zobrist hashing for the solver memo.
 *
 * State is two independent 32-bit lanes (A, B) XOR-updated incrementally on every mutation — no BigInt on
 * the hot path. Cell keys are precomputed tables; column-head / lane / key features are derived on the fly with
 * a seeded integer mixer (equivalent to a lazily-filled random table).
 *
 * Features hashed: emptied cells, column heads, lanes (lane, pod, remaining), collected keys.
 */
import { mix32, mulberry32 } from './rng';

export const TAG_HEAD = 0x48454144;
export const TAG_LANE = 0x4c414e45;
export const TAG_KEY = 0x4b455921;

export class Zobrist {
    readonly cellA: Int32Array;
    readonly cellB: Int32Array;
    private readonly seedA: number;
    private readonly seedB: number;

    constructor(width: number, height: number, podCount: number) {
        const seed = mix32(mix32(mix32(0x464c4f57 ^ width) + height) + podCount);
        const rnd = mulberry32(seed);
        const n = width * height;
        this.seedA = (rnd() * 4294967296) | 0;
        this.seedB = (rnd() * 4294967296) | 0;
        this.cellA = new Int32Array(n);
        this.cellB = new Int32Array(n);
        for (let i = 0; i < n; i++) {
            this.cellA[i] = (rnd() * 4294967296) | 0;
            this.cellB[i] = (rnd() * 4294967296) | 0;
        }
    }

    featureA(tag: number, a: number, b: number): number {
        return mix32(mix32(mix32(this.seedA ^ tag) ^ a) + b);
    }

    featureB(tag: number, a: number, b: number): number {
        return mix32(mix32(mix32(this.seedB ^ tag) ^ a) + b);
    }
}

/** Combine the two 32-bit lanes into a 64-bit bigint (A = low word). */
export function toBigHash(a: number, b: number): bigint {
    return (BigInt(b >>> 0) << 32n) | BigInt(a >>> 0);
}

/**
 * Combine the two lanes into a safe-integer number (53 bits: 32 from A, 21 from B). Fast `Set<number>` key.
 * Collision odds at 200k states ≈ n² / 2⁵⁴ ≈ 2e-6.
 */
export function toNumberHash(a: number, b: number): number {
    return (b >>> 11) * 4294967296 + (a >>> 0);
}
