import { Effect } from '../../core/Effect.js'

/**
 * Threshold — cut luminance into two tones at a level, with a soft edge.
 *
 * High-contrast black-and-white by default; give it `low`/`high` colours and it
 * is a hard duotone. `softness` widens the transition from a crisp cutoff to a
 * smooth ramp. Coverage (alpha) is preserved, so it composites cleanly.
 */
export class Threshold extends Effect {
  static fragSrc = /* glsl */`#version 300 es
    precision highp float;
    in  vec2 vUv;
    out vec4 fragColor;

    uniform sampler2D u_source;
    uniform float level;      // 0..1 luminance cutoff
    uniform float softness;   // 0 = hard edge, up to ~0.5 = smooth
    uniform vec3  low;        // colour below the cutoff
    uniform vec3  high;       // colour above the cutoff

    void main() {
      vec4 c = texture(u_source, vUv);
      vec3 rgb = c.a > 0.0 ? c.rgb / c.a : c.rgb;

      float luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
      float t = smoothstep(level - softness, level + softness, luma);

      rgb = mix(low, high, t);
      fragColor = vec4(rgb * c.a, c.a);
    }
  `

  static defaults = {
    level:    0.5,
    softness: 0.03,
    low:      [0.0, 0.0, 0.0],
    high:     [1.0, 1.0, 1.0],
  }
  static uniforms = { level: 'float', softness: 'float', low: 'vec3', high: 'vec3' }
}
