import type { Scene } from 'phaser';

export function addSceneLabel(scene: Scene, text: string): void {
    scene.add
        .text(360, 640, text, { fontFamily: 'monospace', fontSize: '48px', color: '#6cf' })
        .setOrigin(0.5);
}
