/**
 * Bounded least-recently-used key set (pure). It tracks only keys; the caller owns whatever the keys stand for and
 * releases it from `touch`'s return value (e.g. `textures.remove`).
 */
export class Lru<K> {
    /** Insertion order = recency order (oldest first). */
    private readonly order = new Map<K, true>();

    constructor(readonly capacity: number) {
        if (capacity < 1) throw new Error('Lru capacity must be at least 1');
    }

    get size(): number {
        return this.order.size;
    }

    has(key: K): boolean {
        return this.order.has(key);
    }

    keys(): K[] {
        return [...this.order.keys()];
    }

    /**
     * Mark `key` as most recently used (adding it if new). While over capacity, evicts the oldest keys that are not
     * `pinned` (in use right now, never evicted) and returns them. If everything is pinned the cache stays over capacity.
     */
    touch(key: K, pinned?: (key: K) => boolean): K[] {
        this.order.delete(key);
        this.order.set(key, true);
        const evicted: K[] = [];
        if (this.order.size <= this.capacity) return evicted;
        for (const k of this.order.keys()) {
            if (this.order.size <= this.capacity) break;
            if (k === key || pinned?.(k)) continue;
            this.order.delete(k);
            evicted.push(k);
        }
        return evicted;
    }

    delete(key: K): boolean {
        return this.order.delete(key);
    }

    clear(): K[] {
        const all = this.keys();
        this.order.clear();
        return all;
    }
}
