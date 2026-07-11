import { Effect, Tulle } from './index.js'

// color
export class Grade extends Effect {}
export class Invert extends Effect {}
export class Lut extends Effect {}
export class Duotone extends Effect {}

// focus
export class Blur extends Effect {}
export class Sharpen extends Effect {}

// film
export class Grain extends Effect {}
export class Vignette extends Effect {}
export class ChromaticAberration extends Effect {}
export class Scanlines extends Effect {}
export class Vhs extends Effect {}

// distort
export class Shatter extends Effect {}
export class Pixelate extends Effect {}
export class Ripple extends Effect {}
export class Shockwave extends Effect {
  static MAX_BLASTS: number
}

/** A ring buffer of shockwave blasts, shaped for the Shockwave `blasts` uniform. */
export class BlastField {
  detonate(u: number, v: number, time: number): this
  buffer(): Float32Array
}

// stylize
export class Posterize extends Effect {}
export class Threshold extends Effect {}
export class EdgeDetect extends Effect {}

/** Build a LUT canvas from a colour-mapping function. Browser only. */
export function makeLut(
  size?: number,
  fn?: (r: number, g: number, b: number) => [number, number, number],
): HTMLCanvasElement

export class Over extends Effect {}
export class Add extends Effect {}
export class Screen extends Effect {}

export const blends: Record<string, typeof Effect>
export const blendNames: string[]

export const builtins: Record<string, typeof Effect>

/** Register every built-in effect on a Tulle class. */
export function registerBuiltins(tulle: typeof Tulle): typeof Tulle
