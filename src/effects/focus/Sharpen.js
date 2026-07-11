import { Effect } from '../../core/Effect.js'

/**
 * Sharpen — unsharp mask via a 5-tap cross kernel.
 *
 * Accentuates local contrast by subtracting the four neighbours from the centre.
 * `amount` 0 is an exact identity (the kernel sums to 1); push it up for bite.
 * `thickness` sets the tap distance in pixels (needs u_resolution, supplied for
 * free), so a wider radius sharpens coarser detail. Works on premultiplied
 * colour, which keeps edges against transparency clean.
 */
export class Sharpen extends Effect {
  static fragSrc = /* glsl */`#version 300 es
    precision highp float;
    in  vec2 vUv;
    out vec4 fragColor;

    uniform sampler2D u_source;
    uniform vec2  u_resolution;
    uniform float amount;      // 0 = identity, ~1 = strong
    uniform float thickness;   // tap distance, in pixels

    void main() {
      vec2 px = thickness / u_resolution;

      vec4 c = texture(u_source, vUv);
      vec4 n =
        texture(u_source, vUv + vec2( px.x, 0.0)) +
        texture(u_source, vUv + vec2(-px.x, 0.0)) +
        texture(u_source, vUv + vec2(0.0,  px.y)) +
        texture(u_source, vUv + vec2(0.0, -px.y));

      // (1 + 4a)·centre − a·neighbours: unit gain at amount 0.
      fragColor = c * (1.0 + 4.0 * amount) - n * amount;
    }
  `

  static defaults = { amount: 0.5, thickness: 1.0 }
  static uniforms = { amount: 'float', thickness: 'float' }
}
