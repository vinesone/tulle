import { Effect } from '../../core/Effect.js'

/**
 * EdgeDetect — a Sobel operator over luminance, drawn as glowing outlines.
 *
 * The 3×3 Sobel gradient magnitude at each texel becomes an edge intensity,
 * tinted by `color` over a `background`. `amount` crossfades between the source
 * and the pure edge image, so it ranges from a subtle ink pass to a full
 * blueprint. `thickness` scales the sampling step in pixels (needs
 * u_resolution, supplied for free).
 */
export class EdgeDetect extends Effect {
  static fragSrc = /* glsl */`#version 300 es
    precision highp float;
    in  vec2 vUv;
    out vec4 fragColor;

    uniform sampler2D u_source;
    uniform vec2  u_resolution;
    uniform float amount;      // 0 = source, 1 = pure edges
    uniform float thickness;   // sampling step, in pixels
    uniform vec3  color;       // edge colour
    uniform vec3  background;  // fill behind the edges

    float luma(vec2 uv) {
      vec4 c = texture(u_source, uv);
      vec3 rgb = c.a > 0.0 ? c.rgb / c.a : c.rgb;
      return dot(rgb, vec3(0.2126, 0.7152, 0.0722));
    }

    void main() {
      vec2 px = thickness / u_resolution;

      // Sobel kernels over the 3×3 luminance neighbourhood.
      float tl = luma(vUv + px * vec2(-1.0,  1.0));
      float tc = luma(vUv + px * vec2( 0.0,  1.0));
      float tr = luma(vUv + px * vec2( 1.0,  1.0));
      float ml = luma(vUv + px * vec2(-1.0,  0.0));
      float mr = luma(vUv + px * vec2( 1.0,  0.0));
      float bl = luma(vUv + px * vec2(-1.0, -1.0));
      float bc = luma(vUv + px * vec2( 0.0, -1.0));
      float br = luma(vUv + px * vec2( 1.0, -1.0));

      float gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
      float gy = (tl + 2.0 * tc + tr) - (bl + 2.0 * bc + br);
      float edge = clamp(length(vec2(gx, gy)), 0.0, 1.0);

      vec3 edgeRgb = mix(background, color, edge);

      vec4 src = texture(u_source, vUv);
      vec3 rgb = mix(src.a > 0.0 ? src.rgb / src.a : src.rgb, edgeRgb, amount);

      // amount also lifts coverage toward opaque, so edges show over transparency.
      float a = mix(src.a, 1.0, amount);
      fragColor = vec4(rgb * a, a);
    }
  `

  static defaults = {
    amount:     1.0,
    thickness:  1.0,
    color:      [0.6, 1.0, 0.9],
    background: [0.02, 0.03, 0.06],
  }
  static uniforms = {
    amount: 'float', thickness: 'float', color: 'vec3', background: 'vec3',
  }
}
