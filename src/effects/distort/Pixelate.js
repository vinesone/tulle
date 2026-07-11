import { Effect } from '../../core/Effect.js'

/**
 * Pixelate — snap sampling to a coarse grid of square cells.
 *
 * `size` is the cell edge in pixels, so it means the same thing at any canvas
 * resolution (needs u_resolution, supplied for free). size = 1 samples the
 * centre of each 1-pixel cell — an exact identity, not a near-identity, so it is
 * safe to leave in a chain and animate up from zero.
 */
export class Pixelate extends Effect {
  static fragSrc = /* glsl */`#version 300 es
    precision highp float;
    in  vec2 vUv;
    out vec4 fragColor;

    uniform sampler2D u_source;
    uniform vec2      u_resolution;
    uniform float     size;   // cell size, in pixels

    void main() {
      vec2 cells = u_resolution / max(size, 1.0);
      vec2 uv    = (floor(vUv * cells) + 0.5) / cells;
      fragColor  = texture(u_source, uv);
    }
  `

  static defaults = { size: 8.0 }
  static uniforms = { size: 'float' }
}
