/**
 * Background: #05030c void, a faint nebula (fbm shader rendered at quarter resolution into a texture every few
 * frames, hue drifting over minutes) and a 2-layer parallax starfield (TileSprites drifting slowly).
 */
import type { GameObjects, Scene } from 'phaser';
import { LOGICAL_H, LOGICAL_W } from '@game/layout';
import { TEX } from '../fx/textures';

const NEBULA_KEY = 'fx-nebula-rt';
const NEBULA_W = 180;
const NEBULA_H = 320;
/** Re-render the nebula every N frames (it moves very slowly). */
const NEBULA_EVERY = 4;

const NEBULA_FRAG = `
precision mediump float;
uniform float uTime;
uniform float uHue;
varying vec2 outTexCoord;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){
    vec2 i = floor(p); vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p){ float v = 0.0; float a = 0.5; for (int i = 0; i < 4; i++){ v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }
vec3 hue(float h){ return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); }
void main(){
    vec2 uv = outTexCoord * vec2(0.5625, 1.0) * 2.6;
    float t = uTime;
    float n = fbm(uv + vec2(t * 0.012, t * 0.008));
    float m = fbm(uv * 1.6 - vec2(t * 0.01, -t * 0.006) + n);
    float cloud = smoothstep(0.35, 0.95, n * 0.6 + m * 0.6);
    vec3 a = hue(uHue) * 0.5 + 0.1;
    vec3 b = hue(uHue + 0.35) * 0.5 + 0.1;
    vec3 col = vec3(0.020, 0.012, 0.047) + (a * cloud * 0.10) + (b * m * m * 0.05);
    // vignette toward the edges
    vec2 c = outTexCoord - 0.5;
    col *= 1.0 - dot(c, c) * 1.1;
    gl_FragColor = vec4(col, 1.0);
}
`;

export class Background {
    private readonly nebula: GameObjects.Shader | null = null;
    private readonly nebulaImage: GameObjects.Image | null = null;
    private readonly far: GameObjects.TileSprite;
    private readonly near: GameObjects.TileSprite;
    private frame = 0;
    private timeS = 0;

    constructor(scene: Scene) {
        const renderer = scene.sys.renderer;
        if (renderer.type === 2) {
            if (scene.textures.exists(NEBULA_KEY)) scene.textures.remove(NEBULA_KEY);
            const shader = scene.add.shader(
                {
                    name: 'flow-nebula',
                    fragmentSource: NEBULA_FRAG,
                    initialUniforms: { uTime: 0, uHue: 0.75 },
                    setupUniforms: (setUniform: (name: string, value: unknown) => void) => {
                        setUniform('uTime', this.timeS);
                        // Full hue cycle over ~6 minutes, kept in the violet/teal band.
                        setUniform('uHue', 0.62 + 0.18 * Math.sin(this.timeS / 60));
                    },
                },
                NEBULA_W / 2,
                NEBULA_H / 2,
                NEBULA_W,
                NEBULA_H,
            );
            shader.removeFromDisplayList();
            shader.setRenderToTexture(NEBULA_KEY);
            this.nebula = shader;
            this.nebulaImage = scene.add.image(LOGICAL_W / 2, LOGICAL_H / 2, NEBULA_KEY).setDisplaySize(LOGICAL_W, LOGICAL_H).setDepth(-30);
        }
        this.far = scene.add.tileSprite(LOGICAL_W / 2, LOGICAL_H / 2, LOGICAL_W, LOGICAL_H, TEX.starsA).setDepth(-29).setAlpha(0.55);
        this.near = scene.add.tileSprite(LOGICAL_W / 2, LOGICAL_H / 2, LOGICAL_W, LOGICAL_H, TEX.starsB).setDepth(-28).setAlpha(0.7);
        this.timeS = Math.random() * 100;
    }

    update(dtMs: number): void {
        this.timeS += dtMs / 1000;
        this.far.tilePositionY -= dtMs * 0.004;
        this.far.tilePositionX += dtMs * 0.0012;
        this.near.tilePositionY -= dtMs * 0.011;
        this.near.tilePositionX += dtMs * 0.003;
        this.near.setAlpha(0.6 + 0.15 * Math.sin(this.timeS * 0.9));
        this.frame++;
        if (this.nebula && this.frame % NEBULA_EVERY === 0) this.nebula.renderImmediate();
    }

    destroy(): void {
        this.nebula?.destroy();
        this.nebulaImage?.destroy();
        this.far.destroy();
        this.near.destroy();
    }
}
