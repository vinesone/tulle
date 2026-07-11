import { Effect } from '../../core/Effect.js'

/**
 * Invert — negate colour, keep alpha.
 *
 * On premultiplied colour the inverse is `alpha - rgb` (invert the straight
 * colour, then re-premultiply), which is a single line and leaves transparent
 * pixels transparent.
 */
export class Invert extends Effect {
  static fragSrc = /* glsl */`#version 300 es
    precision highp float;
    in  vec2 vUv;
    out vec4 fragColor;

    uniform sampler2D u_source;
    uniform float amount;   // 0 = original, 1 = fully inverted

    void main() {
      vec4 c = texture(u_source, vUv);
      vec3 inv = c.a - c.rgb;                 // premultiplied invert
      fragColor = vec4(mix(c.rgb, inv, amount), c.a);
    }
  `

  static defaults = { amount: 1.0 }
  static uniforms = { amount: 'float' }
}
