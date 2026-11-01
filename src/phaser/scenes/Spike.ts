import { BlendModes, Actions, Math as PMath, Scene } from 'phaser';
import type { GameObjects, Cameras, Textures } from 'phaser';

const NEON = [0xff2e63, 0xff9f1c, 0xffe94d, 0x39ff88, 0x22e6ff, 0x4d7cff, 0xb44dff, 0xff4de1];
const GRID = 48;
const CELL = 14;

const NEBULA_FRAG = `
precision mediump float;
uniform float uTime;
uniform vec2 uRes;
varying vec2 outTexCoord;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){
    vec2 i = floor(p); vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1,0)), f.x), mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), f.x), f.y);
}
float fbm(vec2 p){ float v = 0.0; float a = 0.5; for (int i = 0; i < 5; i++){ v += a * noise(p); p *= 2.0; a *= 0.5; } return v; }
void main(){
    vec2 uv = outTexCoord * vec2(uRes.x / uRes.y, 1.0) * 3.0;
    float n = fbm(uv + vec2(uTime * 0.05, uTime * 0.03));
    float m = fbm(uv * 1.7 - vec2(uTime * 0.04, 0.0));
    vec3 col = vec3(0.02, 0.012, 0.05) + vec3(0.10, 0.02, 0.16) * n + vec3(0.0, 0.07, 0.12) * m;
    gl_FragColor = vec4(col, 1.0);
}
`;

/** Throwaway FX spike scene (?spike=1). Findings live in plan/notes-phaser4.md. */
export class Spike extends Scene {
    private fpsText!: GameObjects.Text;
    private board!: Textures.DynamicTexture;
    private cells = new Uint8Array(GRID * GRID);
    private mover!: GameObjects.Arc;
    private uiCam!: Cameras.Scene2D.Camera;

    constructor() {
        super('Spike');
    }

    create() {
        const gameLayer: GameObjects.GameObject[] = [];
        const uiLayer: GameObjects.GameObject[] = [];

        // 4. custom fragment shader GameObject (full-screen background)
        const bg = this.add.shader(
            {
                name: 'nebula',
                fragmentSource: NEBULA_FRAG,
                initialUniforms: { uTime: 0, uRes: [720, 1280] },
                setupUniforms: (setUniform: (name: string, value: unknown) => void) => {
                    setUniform('uTime', this.time.now / 1000);
                    setUniform('uRes', [720, 1280]);
                },
            },
            360,
            640,
            720,
            1280,
        );
        gameLayer.push(bg);

        // 2. additive Graphics: overlapping neon shapes
        for (let i = 0; i < 4; i++) {
            const gg = this.add.graphics().setBlendMode(BlendModes.ADD).setPosition(120 + i * 150, 200);
            gg.fillStyle(NEON[(i * 2) % 8]!, 1);
            switch (i) {
                case 0: gg.fillCircle(0, 0, 36); break;
                case 1: gg.fillRoundedRect(-34, -34, 68, 68, 14); break;
                case 2: gg.fillTriangle(0, -40, 38, 30, -38, 30); break;
                default: gg.lineStyle(8, NEON[3]!, 1).strokeCircle(0, 0, 34); break;
            }
            gameLayer.push(gg);
        }
        // overlapping additive pair (shows blend)
        for (const [x, c] of [[560, NEON[0]!], [600, NEON[4]!]] as const) {
            const o = this.add.graphics().setBlendMode(BlendModes.ADD).setPosition(x, 290);
            o.fillStyle(c, 0.8).fillCircle(0, 0, 40);
            gameLayer.push(o);
        }
        // per-object Glow filter (v4: enableFilters + filters.internal.addGlow)
        const glowObj = this.add.graphics().setPosition(620, 200);
        glowObj.lineStyle(4, NEON[1]!, 1).strokeRoundedRect(-30, -30, 60, 60, 12);
        glowObj.enableFilters();
        glowObj.filters!.internal.addGlow(NEON[1]!, 6, 0, 1, false, 0.1, 12);
        gameLayer.push(glowObj);

        // particle texture
        const pg = this.make.graphics({ x: 0, y: 0 }, false);
        pg.fillStyle(0xffffff, 1).fillCircle(8, 8, 8);
        pg.generateTexture('dot', 16, 16);
        pg.destroy();

        // 3. emitter with trail following a moving point
        this.mover = this.add.circle(100, 420, 6, 0xffffff).setBlendMode(BlendModes.ADD);
        const emitter = this.add.particles(0, 0, 'dot', {
            follow: this.mover,
            frequency: 10,
            lifespan: { min: 500, max: 900 },
            speed: { min: 10, max: 50 },
            angle: { min: 0, max: 360 },
            scale: { start: 0.9, end: 0 },
            alpha: { start: 0.9, end: 0 },
            tint: [0x22e6ff, 0xb44dff, 0xff4de1],
            blendMode: 'ADD',
        });
        gameLayer.push(this.mover, emitter);

        // 5. board in a DynamicTexture, redrawn each frame
        const tg = this.make.graphics({ x: 0, y: 0 }, false);
        tg.fillStyle(0xffffff, 1).fillRoundedRect(0, 0, CELL, CELL, 4);
        tg.generateTexture('tile', CELL, CELL);
        tg.destroy();
        for (let i = 0; i < this.cells.length; i++) this.cells[i] = PMath.Between(0, 7);
        this.board = this.textures.addDynamicTexture('board', GRID * CELL, GRID * CELL)!;
        const boardImg = this.add.image(360, 560 + (GRID * CELL) / 2 + 10, 'board');
        gameLayer.push(boardImg);

        // 1. bloom on the main (game) camera, UI on a second unfiltered camera
        const main = this.cameras.main;
        const bloom = Actions.AddEffectBloom(main, {
            threshold: 0.35,
            blurRadius: 2,
            blurSteps: 4,
            blurQuality: 1,
            blendAmount: 1,
        });
        void bloom;

        // 6. font + UI (crisp, no bloom)
        const font = (size: number) => ({ fontFamily: 'Orbitron', fontStyle: '700', fontSize: `${size}px`, color: '#e8f6ff' });
        uiLayer.push(
            this.add.text(24, 16, 'SPIKE', font(28)),
            this.add.text(24, 310, 'ADD + EMITTER TRAIL', { ...font(18), color: '#22e6ff' }),
            this.add.text(24, 520, 'BOARD 48x48 DynamicTexture / frame', { ...font(18), color: '#ff4de1' }),
            this.add.text(24, 1240, '0123456789', font(32)),
        );
        this.fpsText = this.add.text(700, 16, 'FPS', font(28)).setOrigin(1, 0);
        uiLayer.push(this.fpsText);

        this.uiCam = this.cameras.add(0, 0, 720, 1280);
        main.ignore(uiLayer);
        this.uiCam.ignore(gameLayer);
    }

    update(time: number) {
        this.mover.x = 360 + Math.sin(time / 600) * 280;
        this.mover.y = 420 + Math.sin(time / 300) * 40;

        // redraw every frame: mutate some cells, clear, restamp all 2304 tiles, render()
        for (let k = 0; k < 40; k++) this.cells[PMath.Between(0, this.cells.length - 1)] = PMath.Between(0, 7);
        const b = this.board;
        b.clear();
        for (let r = 0; r < GRID; r++) {
            for (let c = 0; c < GRID; c++) {
                b.stamp('tile', undefined, c * CELL, r * CELL, {
                    tint: NEON[this.cells[r * GRID + c]!]!,
                    originX: 0,
                    originY: 0,
                    scale: 0.92,
                });
            }
        }
        b.render();

        this.fpsText.setText(`${Math.round(this.game.loop.actualFps)} FPS`);
    }
}
