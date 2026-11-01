import { Scene } from 'phaser';
import { parseStartTarget } from '@game/urlParams';
import { loadLevelList } from '../levels';
import { addSceneLabel } from './label';

export class Preloader extends Scene {
    constructor() {
        super('Preloader');
    }

    preload() {
        addSceneLabel(this, 'Preloader');
    }

    create() {
        // Fetch and parse the level index while the fonts load, so the level select opens with it ready.
        void loadLevelList();
        void Promise.all([
            document.fonts.load('700 28px Orbitron'),
            document.fonts.load('400 28px Orbitron'),
        ]).then(() => this.go());
    }

    private go() {
        const target = parseStartTarget(window.location.search);
        if (target.scene === 'Play') {
            this.scene.start('Play', target.data);
            return;
        }
        this.scene.start(target.scene);
    }
}
