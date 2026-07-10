import { Effect } from '../core/Effect.js'

/**
 * Film grain — per-pixel noise.
 *
 * Tulle supplies u_time, so grain animates on its own. Set speed to 0 to freeze
 * it into a static dither pattern.
 *
 * size is the grain cell in pixels — 1 is fine film stock, 4 is chunky.
 * colored gives per-channel RGB speckle instead of luminance noise.
 */
export class Grain extends Effect {
  static fragSrc = /* glsl */`#version 300 es
    precision highp float;

    in vec2 vUv;

    uniform sampler2D u_source;
    uniform vec2      u_resolution;
    uniform float     u_time;

    // Noise strength. Range: 0 (none) to ~0.3 (heavy). Default: 0.08
    uniform float amount;

    // Grain cell size in pixels. Default: 1
    uniform float size;

    // Animation rate. 0 freezes the pattern. Default: 1
    uniform float speed;

    // Per-channel noise instead of luminance noise.
    uniform bool colored;

    out vec4 fragColor;

    // Cheap hash — no texture lookup, stable across GPUs.
    float hash(vec2 p) {
      vec3 q = fract(vec3(p.xyx) * 0.1031);
      q += dot(q, q.yzx + 33.33);
      return fract((q.x + q.y) * q.z);
    }

    void main() {
      vec4 src = texture(u_source, vUv);

      // Quantise to a grain cell so size reads as physical grain, not blur.
      vec2 cell = floor(vUv * u_resolution / max(size, 1.0));

      // fract() keeps the seed small: hash precision collapses once time grows.
      vec2 seed = cell + fract(u_time * speed) * 137.0;

      vec3 noise = colored
        ? vec3(hash(seed), hash(seed + 17.0), hash(seed + 43.0)) - 0.5
        : vec3(hash(seed) - 0.5);

      fragColor = vec4(clamp(src.rgb + noise * amount, 0.0, 1.0), src.a);
    }
  `

  static defaults = {
    amount:  0.08,
    size:    1.0,
    speed:   1.0,
    colored: false,
  }

  static uniforms = {
    amount:  'float',
    size:    'float',
    speed:   'float',
    colored: 'bool',
  }
}
