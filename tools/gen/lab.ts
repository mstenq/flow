/** sRGB <-> CIELAB (D65) helpers. */
export type Lab = [number, number, number];

function srgbToLinear(v: number): number {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function labF(t: number): number {
    return t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;
}

export function rgbToLab(r: number, g: number, b: number): Lab {
    const lr = srgbToLinear(r);
    const lg = srgbToLinear(g);
    const lb = srgbToLinear(b);
    const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047;
    const y = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb;
    const z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / 1.08883;
    const fx = labF(x);
    const fy = labF(y);
    const fz = labF(z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function hexToRgb(hex: string): [number, number, number] {
    const n = parseInt(hex.replace('#', ''), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
    const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    return `#${c(r)}${c(g)}${c(b)}`;
}

export function hexToLab(hex: string): Lab {
    const [r, g, b] = hexToRgb(hex);
    return rgbToLab(r, g, b);
}

export function distSq(a: Lab, b: Lab): number {
    const dl = a[0] - b[0];
    const da = a[1] - b[1];
    const db = a[2] - b[2];
    return dl * dl + da * da + db * db;
}

/** CIE76 delta E. */
export function deltaE(a: Lab, b: Lab): number {
    return Math.sqrt(distSq(a, b));
}

export function chroma(lab: Lab): number {
    return Math.hypot(lab[1], lab[2]);
}

/** Hue angle in degrees, 0..360. */
export function hueDeg(lab: Lab): number {
    const h = (Math.atan2(lab[2], lab[1]) * 180) / Math.PI;
    return h < 0 ? h + 360 : h;
}

/** Smallest absolute difference between two hue angles, 0..180. */
export function hueDiff(a: number, b: number): number {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
}

/** HSV hue in degrees (0..360). Closer to how people name colors than the Lab hue angle (e.g. pure red is 0, not 40). */
export function hsvHue(r: number, g: number, b: number): number {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    if (d === 0) return 0;
    let h: number;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    return h < 0 ? h + 360 : h;
}
