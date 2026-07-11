import { Effect } from '../../core/Effect.js'

/**
 * Gaussian blur — single pass, 9×9 taps.
 *
 * `radius` is measured in pixels and only scales the tap offsets, so the
 * kernel weights stay fixed. radius = 0 collapses every tap onto the centre
 * texel, which makes the effect an exact identity rather than a near-identity.
 *
 *   tulle.apply('blur', { radius: 6 })
 *   tulle.chain([{ name: 'blur', params: { radius: 4 } }, 'grain'])
 */
export class Blur extends Effect {
  static fragSrc = /* glsl */`#version 300 es
    precision highp float;

    in vec2 vUv;

    uniform sampler2D u_source;
    uniform vec2      u_resolution;

    // Blur spread, in pixels. Range: 0 (none) → ~20 (heavy). Default: 4
    uniform float radius;

    out vec4 fragColor;

    const int   TAPS  = 4;   // sample -4..4 on each axis
    const float SIGMA = 2.0; // in tap space, not pixels

    void main() {
      vec2  texel = 1.0 / u_resolution;
      vec2  step  = texel * (radius / float(TAPS));

      vec4  sum   = vec4(0.0);
      float wsum  = 0.0;

      for (int y = -TAPS; y <= TAPS; ++y) {
        for (int x = -TAPS; x <= TAPS; ++x) {
          vec2  offset = vec2(float(x), float(y));
          float weight = exp(-dot(offset, offset) / (2.0 * SIGMA * SIGMA));

          sum  += texture(u_source, vUv + offset * step) * weight;
          wsum += weight;
        }
      }

      fragColor = sum / wsum;
    }
  `

  static defaults = {
    radius: 4.0
  }

  static uniforms = {
    radius: 'float'
  }
}
