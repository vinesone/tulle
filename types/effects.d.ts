import { Effect, Tulle } from './index.js'

export class ChromaticAberration extends Effect {}
export class Blur extends Effect {}
export class Grain extends Effect {}

export const builtins: Record<string, typeof Effect>

/** Register every built-in effect on a Tulle class. */
export function registerBuiltins(tulle: typeof Tulle): typeof Tulle
