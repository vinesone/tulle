import { Effect } from '../core/Effect.js'

/**
 * LUT — colour grading through a 3D lookup table.
 *
 * The table is a size³ cube packed into a 2D strip: `size` slices laid left to
 * right, each `size`×`size`, so the texture is (size·size)×size. A pixel's blue
 * channel picks the slice (interpolating between two), red runs across the
 * slice, green down it. `makeLut()` builds one from a colour function; the
 * `lut` param is any image-like value (a canvas, ImageData, an image).
 *
 * Declaring `lut` as a `sampler2D` is all it takes for Tulle to give it its own
 * texture unit and upload it — see Effect's sampler handling.
 */
export class Lut extends Effect {
  static fragSrc = /* glsl */`#version 300 es
    precision highp float;
    in  vec2 vUv;
    out vec4 fragColor;

    uniform sampler2D u_source;
    uniform sampler2D lut;
    uniform float     size;    // cube edge, e.g. 32
    uniform float     amount;  // 0 = original, 1 = fully graded

    vec3 sampleLut(vec3 c) {
      float n = size;
      float blue   = clamp(c.b, 0.0, 1.0) * (n - 1.0);
      float slice0 = floor(blue);
      float slice1 = min(slice0 + 1.0, n - 1.0);
      float f      = blue - slice0;

      float r = clamp(c.r, 0.0, 1.0) * (n - 1.0);
      float g = clamp(c.g, 0.0, 1.0) * (n - 1.0);

      float texW = n * n;
      // +0.5 samples texel centres; the strip lays slices along x.
      float u0 = (slice0 * n + r + 0.5) / texW;
      float u1 = (slice1 * n + r + 0.5) / texW;
      float v  = (g + 0.5) / n;

      vec3 a = texture(lut, vec2(u0, v)).rgb;
      vec3 b = texture(lut, vec2(u1, v)).rgb;
      return mix(a, b, f);
    }

    void main() {
      vec4 src = texture(u_source, vUv);
      // Intermediates are premultiplied; grade the straight colour.
      vec3 rgb = src.a > 0.0 ? src.rgb / src.a : src.rgb;
      vec3 graded = sampleLut(clamp(rgb, 0.0, 1.0));
      rgb = mix(rgb, graded, amount);
      fragColor = vec4(rgb * src.a, src.a);
    }
  `

  static defaults = { size: 32, amount: 1.0, lut: null }
  static uniforms = { size: 'float', amount: 'float', lut: 'sampler2D' }
}

/**
 * Build a LUT as a canvas, ready to hand to the `lut` param.
 *
 * The callback maps a neutral input colour (each channel 0..1) to a graded one;
 * the default is identity. Runs in the browser — it needs a 2D canvas.
 *
 *   const warm = makeLut(32, (r, g, b) => [r * 1.15 + 0.04, g, b * 0.85])
 *   tulle.chain([{ name: 'lut', params: { lut: warm } }])
 *
 * @param {number} size — cube edge (32 is a good default; higher is smoother)
 * @param {(r: number, g: number, b: number) => [number, number, number]} fn
 * @returns {HTMLCanvasElement}
 */
export function makeLut(size = 32, fn = (r, g, b) => [r, g, b]) {
  const w = size * size
  const h = size
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h

  const ctx = canvas.getContext('2d')
  const img = ctx.createImageData(w, h)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const slice = Math.floor(x / size)
      const r = (x - slice * size) / (size - 1)
      const g = y / (size - 1)
      const b = slice / (size - 1)

      const out = fn(r, g, b)
      const i = (y * w + x) * 4
      img.data[i]     = clamp255(out[0])
      img.data[i + 1] = clamp255(out[1])
      img.data[i + 2] = clamp255(out[2])
      img.data[i + 3] = 255
    }
  }

  ctx.putImageData(img, 0, 0)
  return canvas
}

const clamp255 = v => Math.max(0, Math.min(255, Math.round(v * 255)))
