import { ChromaticAberration } from './ChromaticAberration.js'
import { Blur } from './Blur.js'
import { Grain } from './Grain.js'

export { ChromaticAberration, Blur, Grain }

/** Canonical registry names for the built-in effects. */
export const builtins = {
  'chromatic-aberration': ChromaticAberration,
  'blur':                 Blur,
  'grain':                Grain,
}

/**
 * Register every built-in effect.
 * Takes Tulle as an argument rather than importing it — effects must not depend
 * on the class that consumes them.
 *
 *   import { Tulle } from 'tulle'
 *   import { registerBuiltins } from 'tulle/effects'
 *   registerBuiltins(Tulle)
 *
 * @param {typeof import('../core/Tulle.js').Tulle} Tulle
 */
export function registerBuiltins(Tulle) {
  for (const [name, EffectClass] of Object.entries(builtins)) Tulle.register(name, EffectClass)
  return Tulle
}
