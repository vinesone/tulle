/**
 * Batteries-included entry. Importing anything from here registers every
 * built-in effect (on the shared global registry), so you skip the
 * registerBuiltins() step entirely:
 *
 *   import { Tulle } from 'tulle/ready'
 *
 *   Tulle.mount('#app', { width: 640, height: 420 })
 *        .chain(['blur', 'grain'])
 *        .play(video)
 *
 * Everything the lean `tulle` and `tulle/effects` entries export is re-exported
 * here too (Tulle, Effect, Transform, Text, every effect class, makeLut, …), so
 * this is a one-import front door.
 *
 * Prefer the lean `tulle` entry when you want to register only the effects you
 * use and keep the baseline bundle small — this one intentionally pulls them all.
 */
import { Tulle } from './core/Tulle.js'
import { registerBuiltins } from './effects/index.js'

registerBuiltins(Tulle) // side effect: fills the global registry once, on import

export * from './index.js'
export * from './effects/index.js'
