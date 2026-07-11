import { Effect } from '../../core/Effect.js'

/**
 * Vignette — darken toward the corners.
 *
 * A natural full-render post effect. It multiplies rgb by a falloff that starts
 * at `radius` (0 = centre, 1 = corner) and reaches `1 - amount` by
 * `radius + softness`. Alpha is left untouched, and since the factor is ≤ 1 the
 * result stays valid premultiplied colour — so this darkens toward black without
 * eating into a transparent background.
 */
export class Vignette extends Effect {
  static fragSrc = /* glsl */`#version 300 es
    precision highp float;
    in  vec2 vUv;
    out vec4 fragColor;

    uniform sampler2D u_source;
    uniform float amount;    // strength, 0 (off) → ~1 (corners to black)
    uniform float radius;    // where darkening begins, 0..1 from centre
    uniform float softness;  // falloff width

    void main() {
      vec4 c = texture(u_source, vUv);
      // distance(centre) normalised so a corner is ~1.0
      float d = distance(vUv, vec2(0.5)) * 1.41421356;
      float darken = mix(1.0, 1.0 - amount, smoothstep(radius, radius + softness, d));
      fragColor = vec4(c.rgb * clamp(darken, 0.0, 1.0), c.a);
    }
  `

  static defaults = { amount: 0.5, radius: 0.5, softness: 0.4 }
  static uniforms = { amount: 'float', radius: 'float', softness: 'float' }
}
