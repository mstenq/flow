import '@fontsource/orbitron/400.css';
import '@fontsource/orbitron/700.css';
import StartGame from './game/main';

/** iOS Safari ignores `user-scalable=no`; its pinch gesture events can still be cancelled. */
function blockPageZoom(): void {
    const stop = (e: Event) => e.preventDefault();
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(type, stop, { passive: false });
}

document.addEventListener('DOMContentLoaded', () => {
    blockPageZoom();
    StartGame('game-container');
});
