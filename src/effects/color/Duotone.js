import { Effect } from '../../core/Effect.js'

/**
 * Duotone — remap luminance onto a two-colour gradient (dark → light).
 *
 * The classic editorial / poster look: throw away hue, keep tone, then paint
 * that tone between two colours. `amount` crossfades back toward the original,
 * so it doubles as a tint. Un-premultiplies to read true luminance, then
 * re-premultiplies, so it is correct over transparency.
 */
export class Duotone extends Effect {
  static fragSrc = /* glsl */`#version 300 es
    precision highp float;
    in  vec2 vUv;
    out vec4 fragColor;

    uniform sampler2D u_source;
    uniform vec3  dark;    // colour mapped to black
    uniform vec3  light;   // colour mapped to white
    uniform float amount;  // 0 = original, 1 = full duotone

    void main() {
      vec4 c = texture(u_source, vUv);
      vec3 rgb = c.a > 0.0 ? c.rgb / c.a : c.rgb;

      float luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
      vec3  duo  = mix(dark, light, luma);

      rgb = mix(rgb, duo, amount);
      fragColor = vec4(rgb * c.a, c.a);
    }
  `

  static defaults = {
    dark:   [0.05, 0.03, 0.18],
    light:  [1.0,  0.78, 0.30],
    amount: 1.0,
  }
  static uniforms = { dark: 'vec3', light: 'vec3', amount: 'float' }
}
