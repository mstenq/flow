/**
 * Chromatic aberration as a custom camera filter (Phaser 4 RenderNode + Controller).
 * Red and blue are sampled pushed outward / inward from the center by `amount` (UV units, ~0.004-0.02).
 * Keep `active = false` when idle so it costs nothing.
 */
import { Filters, Renderer } from 'phaser';
import type { Cameras } from 'phaser';

const NODE = 'FilterFlowChroma';

const FRAG = `
#pragma phaserTemplate(shaderName)
precision mediump float;
uniform sampler2D uMainSampler;
uniform float uAmount;
varying vec2 outTexCoord;
#pragma phaserTemplate(fragmentHeader)
void main()
{
    vec2 d = (outTexCoord - 0.5) * uAmount;
    vec4 base = texture2D(uMainSampler, outTexCoord);
    float r = texture2D(uMainSampler, outTexCoord + d).r;
    float b = texture2D(uMainSampler, outTexCoord - d).b;
    gl_FragColor = vec4(r, base.g, b, base.a);
}
`;

export class ChromaController extends Filters.Controller {
    amount = 0;

    constructor(camera: Cameras.Scene2D.Camera) {
        super(camera, NODE);
    }
}

class ChromaNode extends Renderer.WebGL.RenderNodes.BaseFilterShader {
    constructor(manager: Renderer.WebGL.RenderNodes.RenderNodeManager) {
        super(NODE, manager, undefined, FRAG);
    }

    setupUniforms(controller: ChromaController): void {
        this.programManager.setUniform('uAmount', controller.amount);
    }
}

/** Register the node once per renderer and attach a controller to the camera's external filters. */
export function addChromaFilter(camera: Cameras.Scene2D.Camera): ChromaController | null {
    const renderer = camera.scene.sys.renderer;
    if (!(renderer instanceof Renderer.WebGL.WebGLRenderer)) return null;
    const nodes = renderer.renderNodes;
    if (!nodes.hasNode(NODE)) nodes.addNodeConstructor(NODE, ChromaNode);
    const controller = new ChromaController(camera);
    controller.active = false;
    camera.filters.external.add(controller);
    return controller;
}
