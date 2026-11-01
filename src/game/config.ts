import { AUTO, Scale } from 'phaser';
import type { Types } from 'phaser';
import { Boot } from '../phaser/scenes/Boot';
import { Preloader } from '../phaser/scenes/Preloader';
import { LevelSelect } from '../phaser/scenes/LevelSelect';
import { Play } from '../phaser/scenes/Play';
import { Spike } from '../phaser/scenes/Spike';

export const GAME_WIDTH = 720;
export const GAME_HEIGHT = 1280;

export const gameConfig: Types.Core.GameConfig = {
    type: AUTO,
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
    backgroundColor: '#05030c',
    disableContextMenu: true,
    scale: {
        mode: Scale.FIT,
        autoCenter: Scale.CENTER_BOTH,
    },
    input: {
        activePointers: 3,
    },
    scene: [Boot, Preloader, LevelSelect, Play, Spike],
};
