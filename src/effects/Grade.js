import { Effect } from '../core/Effect.js'

/**
 * Grade — exposure, contrast, and saturation in one pass.
 *
 * The everyday full-render colour adjustment. It un-premultiplies before
 * grading and re-premultiplies after, so it is correct over a transparent
 * background: the maths runs on the actual colour, not on colour already scaled
 * by alpha.
 */
export class Grade extends Effect {
  static fragSrc = /* glsl */`#version 300 es
    precision highp float;
    in  vec2 vUv;
    out vec4 fragColor;

    uniform sampler2D u_source;
    uniform float exposure;    // linear multiply, 1 = unchanged
    uniform float contrast;    // about mid-grey, 1 = unchanged
    uniform float saturation;  // 0 = greyscale, 1 = unchanged, >1 = punchier

    void main() {
      vec4 c = texture(u_source, vUv);

      // Work in straight (un-premultiplied) colour.
      vec3 rgb = c.a > 0.0 ? c.rgb / c.a : c.rgb;

      rgb *= exposure;
      rgb  = (rgb - 0.5) * contrast + 0.5;

      float luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
      rgb = mix(vec3(luma), rgb, saturation);

      rgb = clamp(rgb, 0.0, 1.0);
      fragColor = vec4(rgb * c.a, c.a);   // back to premultiplied
    }
  `

  static defaults = { exposure: 1.0, contrast: 1.0, saturation: 1.0 }
  static uniforms = { exposure: 'float', contrast: 'float', saturation: 'float' }
}
