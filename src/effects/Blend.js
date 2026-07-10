import { Effect } from '../core/Effect.js'

/**
 * Blend modes — two-input effects that composite an upper layer onto a lower one.
 *
 * These read two textures: u_source is the layer below, u_layer the layer above
 * (Effect binds input 0 and input 1). Tulle's compositor renders each layer into
 * its own buffer, then runs one of these to combine them.
 *
 * All intermediate buffers hold PREMULTIPLIED alpha (the Renderer premultiplies
 * on upload), which is the whole reason these are one-liners: premultiplied
 * `over` is `layer + base·(1-layerAlpha)` with no divide and no edge halo, and
 * `opacity` is a plain scalar multiply of the premultiplied upper layer — it
 * scales coverage and intensity together, exactly as expected.
 *
 * @see docs/composition.md — "Blend modes belong in a shader" / "Premultiplied alpha"
 */

const HEAD = /* glsl */`#version 300 es
  precision highp float;
  in  vec2 vUv;
  out vec4 fragColor;

  uniform sampler2D u_source;   // base — the layer below
  uniform sampler2D u_layer;    // the layer above
  uniform float     opacity;    // 0..1, applied to the upper layer

  void main() {
    vec4 base = texture(u_source, vUv);
    vec4 top  = texture(u_layer,  vUv) * opacity;   // premultiplied scale
`

/** name → the single premultiplied expression that produces fragColor. */
const MODES = {
  // Porter-Duff source-over: the default stack behaviour.
  over:   'top + base * (1.0 - top.a)',
  // Additive — light accumulates. Bright where layers overlap; great for glow.
  add:    'min(base + top, 1.0)',
  // Screen — inverse-multiply. Lightens without blowing out like add does.
  screen: 'base + top - base * top',
}

/** Build one Effect subclass per blend mode. */
function makeBlend(expr) {
  return class extends Effect {
    static fragSrc  = `${HEAD}    fragColor = ${expr};\n  }\n`
    static defaults = { opacity: 1.0 }
    static uniforms = { opacity: 'float' }
  }
}

export const Over   = makeBlend(MODES.over)
export const Add    = makeBlend(MODES.add)
export const Screen = makeBlend(MODES.screen)

/** Canonical registry names for the blend modes. */
export const blends = { over: Over, add: Add, screen: Screen }

/** Every blend mode's registry name. */
export const blendNames = Object.keys(blends)
