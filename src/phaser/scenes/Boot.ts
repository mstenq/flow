import { Scene } from 'phaser';
import { bootstrap } from '../bootstrap';
import { addSceneLabel } from './label';

export class Boot extends Scene {
    constructor() {
        super('Boot');
    }

    create() {
        bootstrap();
        addSceneLabel(this, 'Boot');
        this.scene.start('Preloader');
    }
}
