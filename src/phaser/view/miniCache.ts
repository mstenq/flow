/**
 * Bounded cache of level-select mini textures. Textures are generated lazily (`ensureMini`), kept in an LRU and
 * destroyed (`textures.remove`) when evicted, so scrolling hundreds of levels holds at most `capacity` canvases
 * (plus whatever is pinned, i.e. on a tile right now). Textures live in the game-global texture manager, so `clear()`
 * must run when the scene shuts down.
 */
import type { Scene } from 'phaser';
import { Lru } from '@game/lru';
import { ensureMini, miniKey } from './miniArt';
import type { MiniArt, MiniKind, MiniSource } from './miniArt';

/** Default texture budget. A 40x40 level is ~0.6 MB, so this is about 30 MB at worst. */
export const MINI_CACHE_SIZE = 48;

export class MiniCache {
    private readonly lru: Lru<string>;

    constructor(
        private readonly scene: Scene,
        capacity = MINI_CACHE_SIZE,
    ) {
        this.lru = new Lru<string>(capacity);
    }

    get size(): number {
        return this.lru.size;
    }

    has(id: string, kind: MiniKind): boolean {
        return this.lru.has(miniKey(id, kind));
    }

    /** Texture for the source (created on first use), marked most recently used. `pinned` keys are never evicted. */
    get(src: MiniSource, kind: MiniKind, pinned?: (key: string) => boolean): MiniArt {
        const art = ensureMini(this.scene, src, kind);
        for (const key of this.lru.touch(art.key, pinned)) this.drop(key);
        return art;
    }

    /** Destroy every cached texture (scene shutdown). */
    clear(): void {
        for (const key of this.lru.clear()) this.drop(key);
    }

    private drop(key: string): void {
        if (this.scene.textures.exists(key)) this.scene.textures.remove(key);
    }
}
