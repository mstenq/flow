/** Small boards shared by the generator tests. */
import { TEST_PALETTE } from '../game/helpers';
import type { Board } from '../../tools/gen/board';
import { boardFromAscii } from '../../tools/gen/board';

/** Concentric rings: every inner color is buried behind the outer ones. */
export const RINGS = `
    00000000
    01111110
    01222210
    01233210
    01233210
    01222210
    01111110
    00000000
`;

/** Open shape with holes and interleaved colors (like a sprite on a transparent background). */
export const SPRITE = `
    ...0000...
    ..011110..
    .01222210.
    0123..3210
    0123..3210
    .01222210.
    ..014410..
    ...0000...
`;

/** Full rectangle with stripes and blobs (like a scene). */
export const SCENE = `
    000000000000
    000011110000
    222211112222
    233331133332
    244443344442
    111111111111
    155511155511
    111111111111
`;

export function fixtureBoards(): { name: string; board: Board }[] {
    return [
        { name: 'rings', board: boardFromAscii(RINGS, TEST_PALETTE) },
        { name: 'sprite', board: boardFromAscii(SPRITE, TEST_PALETTE) },
        { name: 'scene', board: boardFromAscii(SCENE, TEST_PALETTE) },
    ];
}
