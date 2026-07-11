// Colour
import { Grade }    from './color/Grade.js'
import { Invert }   from './color/Invert.js'
import { Lut }      from './color/Lut.js'
import { Duotone }  from './color/Duotone.js'

// Focus
import { Blur }     from './focus/Blur.js'
import { Sharpen }  from './focus/Sharpen.js'

// Film
import { Grain }               from './film/Grain.js'
import { Vignette }            from './film/Vignette.js'
import { ChromaticAberration } from './film/ChromaticAberration.js'
import { Scanlines }           from './film/Scanlines.js'
import { Vhs }                 from './film/Vhs.js'

// Distort
import { Shatter }              from './distort/Shatter.js'
import { Pixelate }             from './distort/Pixelate.js'
import { Ripple }               from './distort/Ripple.js'
import { Shockwave, BlastField } from './distort/Shockwave.js'

// Stylize
import { Posterize }  from './stylize/Posterize.js'
import { Threshold }  from './stylize/Threshold.js'
import { EdgeDetect } from './stylize/EdgeDetect.js'

// Blend
import { blends } from './blend/Blend.js'

// Re-export every effect by name, grouped as above.
export { Grade, Invert, Lut, Duotone }                        // color
export { Blur, Sharpen }                                       // focus
export { Grain, Vignette, ChromaticAberration, Scanlines, Vhs } // film
export { Shatter, Pixelate, Ripple, Shockwave, BlastField }   // distort
export { Posterize, Threshold, EdgeDetect }                   // stylize
export { makeLut } from './color/Lut.js'
export { Over, Add, Screen, blends, blendNames } from './blend/Blend.js'

/** Canonical registry names for the built-in effects, blend modes included. */
export const builtins = {
  // color
  'grade':                Grade,
  'invert':               Invert,
  'lut':                  Lut,
  'duotone':              Duotone,
  // focus
  'blur':                 Blur,
  'sharpen':              Sharpen,
  // film
  'grain':                Grain,
  'vignette':             Vignette,
  'chromatic-aberration': ChromaticAberration,
  'scanlines':            Scanlines,
  'vhs':                  Vhs,
  // distort
  'shatter':              Shatter,
  'pixelate':             Pixelate,
  'ripple':               Ripple,
  'shockwave':            Shockwave,
  // stylize
  'posterize':            Posterize,
  'threshold':            Threshold,
  'edge-detect':          EdgeDetect,
  // blend
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
