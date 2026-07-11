import { Effect } from '../../core/Effect.js'

/**
 * Shatter — melt a source down, then explode it into scattering fragments,
 * driven by a single `progress` uniform (0 = intact, 1 = gone).
 *
 * It's a *gather* displacement: for each output pixel it works out where the
 * source pixel came from, so the whole thing is one texture read with no
 * geometry. Two stages overlap as progress rises — columns sag downward first
 * (the melt), then an NxN grid of blocks flies outward from the centre with a
 * per-block random kick and dissolves at staggered times (the explosion).
 *
 * Because every term is scaled by `progress`, at 0 it is an exact identity —
 * which makes it reversible for free: ease `progress` back toward 0 and the
 * source reassembles. That is the whole trick behind a click-to-explode /
 * click-to-restore interaction.
 *
 *   tulle.composite([
 *     { source: bg },
 *     { source: title, effects: [{ name: 'shatter', params: { progress: 0 } }] },
 *   ])
 *   // in the loop: tulle.setLayerEffect(1, 'shatter', { progress })
 *
 * `u_pointer` is bound for free, so `hover` adds a ripple centred on the cursor —
 * handy for a rollover cue before the detonation.
 */
export class Shatter extends Effect {
  static fragSrc = /* glsl */`#version 300 es
    precision highp float;

    in  vec2 vUv;
    out vec4 fragColor;

    uniform sampler2D u_source;
    uniform float     u_time;
    uniform vec2      u_pointer;   // 0..1, bottom-left — bound for free

    // How far through the collapse: 0 intact → 1 fully gone. Default: 0
    uniform float progress;
    // Rollover intensity for the cursor ripple + glow, 0..1. Default: 0
    uniform float hover;
    // Fragment grid density — higher is finer debris. Default: 22
    uniform float cells;
    // Explosion displacement scale. Range ~0.1 → 1.2. Default: 0.55
    uniform float blast;
    // Melt (downward sag) amount. Range 0 → ~0.6. Default: 0.25
    uniform float drip;

    float hash21(vec2 p) {
      p = fract(p * vec2(123.34, 345.45));
      p += dot(p, p + 34.345);
      return fract(p.x * p.y);
    }

    void main() {
      // Two overlapping stages: melt leads, explosion follows.
      float melt = smoothstep(0.0,  0.55, progress);
      float boom = smoothstep(0.30, 1.0,  progress);

      vec2 uv = vUv;

      // Melt: columns sag downward (sampled upward), more toward the bottom.
      float colR = hash21(vec2(floor(vUv.x * 90.0), 1.0));
      uv.y += drip * melt * (0.35 + 0.65 * colR) * vUv.y;

      // Explode: each block flies outward with a random kick.
      vec2  cell   = floor(vUv * cells);
      vec2  jitter = vec2(hash21(cell), hash21(cell + 5.2)) * 2.0 - 1.0;
      vec2  radial = normalize(vUv - 0.5 + 1e-4);
      vec2  disp   = (radial * 0.8 + jitter * 0.6) * blast * boom * boom;

      // Hover ripple centred on the cursor.
      float dc = distance(vUv, u_pointer);
      disp += radial * sin(dc * 42.0 - u_time * 6.0) * 0.003 * hover * smoothstep(0.4, 0.0, dc);

      vec4 c = texture(u_source, uv - disp);

      // Dissolve: blocks fade at staggered times as they scatter.
      float when = 0.15 + 0.7 * hash21(cell + 2.0);
      c *= 1.0 - smoothstep(when, when + 0.35, progress);

      // Ember tint + hover glow. Buffers are premultiplied, so scale additions
      // by coverage (c.a) to keep colour and alpha in step.
      vec3 ember = mix(vec3(1.0, 0.55, 0.15), vec3(1.0, 0.12, 0.04), hash21(cell + 9.0));
      c.rgb += ember * c.a * boom * 0.8;
      c.rgb += c.a * hover * 0.18;

      fragColor = c;
    }
  `

  static defaults = {
    progress: 0.0,
    hover:    0.0,
    cells:    22.0,
    blast:    0.55,
    drip:     0.25,
  }

  static uniforms = {
    progress: 'float',
    hover:    'float',
    cells:    'float',
    blast:    'float',
    drip:     'float',
  }
}
