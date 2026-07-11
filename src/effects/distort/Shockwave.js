import { Effect } from '../../core/Effect.js'

/**
 * Shockwave — expanding ring distortion, detonated on demand.
 *
 * Not a post-process of a static param: each blast is a (center, birthTime)
 * pair, and the shader animates the ring outward from u_time - birthTime. Up to
 * MAX_BLASTS run at once, so rapid clicks overlap instead of cancelling.
 *
 * The blast list is a flat Float32Array of vec3 (u, v, birth) uploaded through
 * the raw-binder escape hatch, because Tulle's declared-type table stops at a
 * single vec3, not an array of them. Pair it with a BlastField (below) to stamp
 * blasts on click:
 *
 *   const blasts = new BlastField()
 *   tulle.chain(['shockwave']).set('shockwave', { blasts: blasts.buffer() })
 *   tulle.on('pointerdown', p => blasts.detonate(p.u, p.v, tulle.frame.time))
 */
const MAX_BLASTS = 6

export class Shockwave extends Effect {
  static fragSrc = /* glsl */`#version 300 es
    precision highp float;
    in  vec2 vUv;
    out vec4 fragColor;

    uniform sampler2D u_source;
    uniform vec2      u_resolution;
    uniform float     u_time;

    // (u, v, birth) per blast. birth < 0.0 marks an empty slot.
    uniform vec3  blasts[${MAX_BLASTS}];

    uniform float speed;      // wavefront units (screen heights) per second
    uniform float amplitude;  // peak UV displacement at the front
    uniform float width;      // thickness of the ring
    uniform float decay;      // how fast a blast fades with age

    void main() {
      float aspect = u_resolution.x / u_resolution.y;

      vec2  push  = vec2(0.0);   // accumulated UV displacement
      float front = 0.0;         // how close vUv is to any wavefront, 0..1

      for (int i = 0; i < ${MAX_BLASTS}; i++) {
        float birth = blasts[i].z;
        if (birth < 0.0) continue;

        float age = u_time - birth;
        if (age < 0.0) continue;

        // Distance to the blast centre, corrected so the ring is a circle on a
        // non-square canvas rather than an ellipse.
        vec2  d    = vUv - blasts[i].xy;
        d.x       *= aspect;
        float dist = length(d);

        float radius = age * speed;
        float ring   = dist - radius;                 // 0 exactly on the front
        float band   = exp(-(ring * ring) / (width * width));
        float energy = band * exp(-age * decay);

        push  += (dist > 1e-4 ? d / dist : vec2(0.0)) * energy * amplitude;
        front  = max(front, energy);
      }

      // Sample the pushed-in UV. Split the channels across the wavefront for a
      // lens-shock look — cheap chromatic aberration that only bites at the ring.
      vec2 uv = vUv - push;
      float ca = front * 0.006;
      vec4 col;
      col.r = texture(u_source, uv + vec2(ca, 0.0)).r;
      col.g = texture(u_source, uv).g;
      col.b = texture(u_source, uv - vec2(ca, 0.0)).b;
      col.a = 1.0;

      // Bright rim on the crest.
      fragColor = col + front * 0.25;
    }
  `

  static defaults = {
    speed:     0.9,
    amplitude: 0.06,
    width:     0.05,
    decay:     2.2,
    blasts:    emptyBlasts(),
  }

  static uniforms = {
    speed:     'float',
    amplitude: 'float',
    width:     'float',
    decay:     'float',
    // Escape hatch: upload the whole vec3[] in one call.
    blasts: (gl, loc, value) => gl.uniform3fv(loc, value),
  }
}

Shockwave.MAX_BLASTS = MAX_BLASTS

function emptyBlasts() {
  const a = new Float32Array(MAX_BLASTS * 3)
  for (let i = 0; i < MAX_BLASTS; i++) a[i * 3 + 2] = -1 // birth < 0 → empty
  return a
}

/**
 * A tiny ring buffer of blasts, shaped for the uniform above. detonate() stamps
 * a new blast at (u, v, time); buffer() hands back the flat array to upload.
 */
export class BlastField {
  #data = emptyBlasts()
  #next = 0

  detonate(u, v, time) {
    const i = this.#next * 3
    this.#data[i]     = u
    this.#data[i + 1] = v
    this.#data[i + 2] = time
    this.#next = (this.#next + 1) % MAX_BLASTS
    return this
  }

  buffer() { return this.#data }
}
