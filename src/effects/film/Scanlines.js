import { Effect } from '../../core/Effect.js'

/**
 * Scanlines — CRT-style horizontal darkening, optionally rolling.
 *
 * A sine across the vertical axis dims alternating rows; `count` sets how many
 * lines span the frame, `intensity` how deep they cut. `speed` rolls them over
 * time (reads u_time, supplied for free) for a live-monitor feel. Multiplies the
 * premultiplied colour, so coverage is untouched.
 */
export class Scanlines extends Effect {
  static fragSrc = /* glsl */`#version 300 es
    precision highp float;
    in  vec2 vUv;
    out vec4 fragColor;

    uniform sampler2D u_source;
    uniform float u_time;
    uniform float count;      // number of lines across the frame
    uniform float intensity;  // 0 = off, 1 = full black troughs
    uniform float speed;      // vertical roll, lines/sec-ish

    const float TAU = 6.28318530718;

    void main() {
      vec4 c = texture(u_source, vUv);

      float phase = (vUv.y * count - u_time * speed) * TAU;
      float line  = 0.5 + 0.5 * sin(phase);     // 0..1
      float dim   = 1.0 - intensity * (1.0 - line);

      fragColor = c * dim;   // premultiplied: scales colour and coverage together
    }
  `

  static defaults = { count: 240.0, intensity: 0.3, speed: 0.0 }
  static uniforms = { count: 'float', intensity: 'float', speed: 'float' }
}
