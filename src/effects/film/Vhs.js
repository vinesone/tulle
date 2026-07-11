import { Effect } from '../../core/Effect.js'

/**
 * VHS — the analog-tape look: unstable tracking, chroma bleed, a sweeping
 * dropout band, tape noise, and the odd vertical sync roll.
 *
 * One effect because these artifacts share a cause — a worn tape and a drifting
 * head — and reproducing them separately would double the noise lookups. Layer
 * it under `scanlines`, `grade`, `vignette`, and `grain` for a full dying-VCR
 * chain. Meant for opaque, full-frame footage; it reads and writes straight
 * colour and passes alpha through.
 *
 * `tracking` is the master instability. Kick it up for a moment to fake someone
 * whacking the top of the VCR:
 *
 *   tulle.set('vhs', { tracking: 1.6 }) // then ease it back down
 */
export class Vhs extends Effect {
  static fragSrc = /* glsl */`#version 300 es
    precision highp float;
    in  vec2 vUv;
    out vec4 fragColor;

    uniform sampler2D u_source;
    uniform vec2  u_resolution;
    uniform float u_time;

    uniform float tracking;    // head instability: jitter + dropout band
    uniform float bleed;       // chroma (R/B) horizontal separation
    uniform float noise;       // tape grain
    uniform float roll;        // vertical sync roll strength
    uniform float wobble;      // slow whole-picture horizontal warp
    uniform float desaturate;  // worn colour, 0..1

    float rnd(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

    void main() {
      float t = u_time;
      vec2  uv = vUv;

      // Vertical sync roll: a brief jump near the end of each cycle.
      float rollPhase = fract(t * 0.1 * roll);
      uv.y = fract(uv.y - smoothstep(0.97, 1.0, rollPhase) * 0.2 * roll);

      // A tracking-error band sweeping up the frame; distortion spikes inside it.
      float bandY = fract(t * 0.15);
      float band  = smoothstep(0.05, 0.0, abs(uv.y - bandY)) * tracking;

      // Per-scanline horizontal jitter + a gentle whole-picture wobble.
      float lineId = floor(uv.y * u_resolution.y);
      float jitter = rnd(vec2(lineId, floor(t * 24.0))) - 0.5;
      float warp   = sin(uv.y * 18.0 + t * 3.0) * 0.0015;
      uv.x += warp * wobble * 3.0 + jitter * (0.0015 * tracking + 0.04 * band);

      // Chroma bleed — worse in the band.
      float sep = (0.0025 + 0.02 * band) * (0.3 + bleed);
      vec3 col;
      col.r = texture(u_source, uv + vec2(sep, 0.0)).r;
      col.g = texture(u_source, uv).g;
      col.b = texture(u_source, uv - vec2(sep, 0.0)).b;
      float a = texture(u_source, uv).a;

      // Worn colour.
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(col, vec3(luma), desaturate);

      // Tape noise + bright dropout speckles concentrated in the band.
      float n = rnd(vec2(uv.y * u_resolution.y, floor(t * 48.0)) + uv.x * 40.0);
      col += (n - 0.5) * (0.09 * noise + 0.6 * band);
      col += step(0.97, n) * band * 1.2;

      fragColor = vec4(col, a);
    }
  `

  static defaults = {
    tracking:   0.5,
    bleed:      0.5,
    noise:      0.4,
    roll:       0.4,
    wobble:     0.5,
    desaturate: 0.25,
  }
  static uniforms = {
    tracking: 'float', bleed: 'float', noise: 'float',
    roll: 'float', wobble: 'float', desaturate: 'float',
  }
}
