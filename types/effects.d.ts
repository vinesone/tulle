import { Effect, Tulle } from './index.js'

export class ChromaticAberration extends Effect {}
export class Blur extends Effect {}
export class Grain extends Effect {}
export class Vignette extends Effect {}
export class Grade extends Effect {}
export class Invert extends Effect {}

export class Over extends Effect {}
export class Add extends Effect {}
export class Screen extends Effect {}

export const blends: Record<string, typeof Effect>
export const blendNames: string[]

export const builtins: Record<string, typeof Effect>

/** Register every built-in effect on a Tulle class. */
export function registerBuiltins(tulle: typeof Tulle): typeof Tulle
