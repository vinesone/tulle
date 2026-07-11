import { Effect } from '../../core/Effect.js'

/**
 * Ripple — concentric waves radiating from a point, like a drop in water.
 *
 * Displaces the sampling UV along the radius by a travelling sine, animated with
 * u_time (supplied for free). `center` is in 0..1 UV space and defaults to the
 * middle — set it to the cursor with a function param for an interactive splash:
 *
 *   tulle.set('ripple', { center: ({ pointer }) => [pointer.u, pointer.v] })
 *
 * `amplitude` 0 is an exact identity, so it is safe to ease up from rest.
 */
export class Ripple extends Effect {
  static fragSrc = /* glsl */`#version 300 es
    precision highp float;
    in  vec2 vUv;
    out vec4 fragColor;

    uniform sampler2D u_source;
    uniform float u_time;
    uniform vec2  center;      // 0..1 UV
    uniform float amplitude;   // UV displacement, ~0.02 is lively
    uniform float frequency;   // ring density
    uniform float speed;       // outward travel
    uniform float decay;       // falloff with distance; 0 = none

    void main() {
      vec2  dir = vUv - center;
      float d   = length(dir);

      float wave = sin(d * frequency - u_time * speed);
      float fall = exp(-d * decay);
      vec2  off  = (d > 0.0 ? dir / d : vec2(0.0)) * wave * amplitude * fall;

      fragColor = texture(u_source, vUv - off);
    }
  `

  static defaults = {
    center:    [0.5, 0.5],
    amplitude: 0.02,
    frequency: 40.0,
    speed:     6.0,
    decay:     3.0,
  }
  static uniforms = {
    center: 'vec2', amplitude: 'float', frequency: 'float', speed: 'float', decay: 'float',
  }
}
