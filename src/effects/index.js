import { ChromaticAberration } from './ChromaticAberration.js'
import { Blur } from './Blur.js'
import { Grain } from './Grain.js'
import { Vignette } from './Vignette.js'
import { Grade } from './Grade.js'
import { Invert } from './Invert.js'
import { Lut } from './Lut.js'
import { blends } from './Blend.js'

export { ChromaticAberration, Blur, Grain, Vignette, Grade, Invert, Lut }
export { makeLut } from './Lut.js'
export { Over, Add, Screen, blends, blendNames } from './Blend.js'

/** Canonical registry names for the built-in effects, blend modes included. */
export const builtins = {
  'chromatic-aberration': ChromaticAberration,
  'blur':                 Blur,
  'grain':                Grain,
  'vignette':             Vignette,
  'grade':                Grade,
  'invert':               Invert,
  'lut':                  Lut,
  ...blends,
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
