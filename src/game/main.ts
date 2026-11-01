import { Game } from 'phaser';
import { gameConfig } from './config';
import { gameFacade } from './gameFacade';
import { audioDirector } from '../phaser/audio';
import { getRoundState, getRunState, getSceneState } from './state';

/** Dev-only handle for headless tests (`tools/dev/interact.ts` `eval:` steps). Not present in production builds. */
export interface FlowDebugHandle {
    game: Game;
    rendererType: string;
    facade: typeof gameFacade;
    audio: typeof audioDirector;
    state: { run: typeof getRunState; round: typeof getRoundState; scene: typeof getSceneState };
}

declare global {
    interface Window {
        __FLOW__?: FlowDebugHandle;
    }
}

const rendererName = (game: Game): string => (game.renderer.type === 1 ? 'Canvas' : 'WebGL');

const StartGame = (parent: string) => {
    const game = new Game({ ...gameConfig, parent });
    if (import.meta.env.DEV) {
        game.events.once('ready', () => {
            window.__FLOW__ = {
                game,
                rendererType: rendererName(game),
                facade: gameFacade,
                audio: audioDirector,
                state: { run: getRunState, round: getRoundState, scene: getSceneState },
            };
        });
    }
    return game;
};

export default StartGame;
