import { Effect } from '../../core/Effect.js'

/**
 * Posterize — quantise each channel to a fixed number of levels.
 *
 * Banding, on purpose: the smooth ramp of a gradient collapses into flat steps,
 * the print / screen-print look. `levels` is per channel — 2 is stark, 8 is
 * subtle. Un-premultiplies so the steps land on true colour, not on
 * alpha-scaled colour.
 */
export class Posterize extends Effect {
  static fragSrc = /* glsl */`#version 300 es
    precision highp float;
    in  vec2 vUv;
    out vec4 fragColor;

    uniform sampler2D u_source;
    uniform float levels;   // steps per channel; >= 2

    void main() {
      vec4 c = texture(u_source, vUv);
      vec3 rgb = c.a > 0.0 ? c.rgb / c.a : c.rgb;

      float n = max(levels, 2.0);
      rgb = floor(rgb * n) / (n - 1.0);
      rgb = clamp(rgb, 0.0, 1.0);

      fragColor = vec4(rgb * c.a, c.a);
    }
  `

  static defaults = { levels: 5.0 }
  static uniforms = { levels: 'float' }
}
