/**
 * Transform — a 2D affine matrix for placing a layer in the frame.
 *
 * Produces a 3×3 matrix as a column-major Float32Array, ready for
 * gl.uniformMatrix3fv and the u_transform in every effect's vertex stage. It
 * operates in clip space: positions run -1..1 with the origin at the centre, so
 * a transform is resolution-independent — scale 0.5 is half the frame at any
 * canvas size.
 *
 *   // a half-size layer parked in the top-right quadrant
 *   Transform.identity().translate(0.5, 0.5).scale(0.5)
 *
 * Methods post-multiply, so they read outermost-last: the line above scales
 * first, then translates.
 */
/** Shared identity. Treat as read-only; callers copy it before mutating. */
export const IDENTITY = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1])

export class Transform {
  /** @param {Float32Array} [m] column-major 3×3; defaults to identity */
  constructor(m) { this.m = m ? Float32Array.from(m) : Float32Array.from(IDENTITY) }

  static identity() { return new Transform() }

  /** Move by (tx, ty) in clip space (1 = half the frame). */
  translate(tx, ty) { return this.#mul(fromTranslate(tx, ty)) }

  /** Scale about the centre. One argument scales uniformly. */
  scale(sx, sy = sx) { return this.#mul(fromScale(sx, sy)) }

  /** Rotate about the centre, radians, counter-clockwise. */
  rotate(rad) { return this.#mul(fromRotate(rad)) }

  /** The raw column-major matrix, for the uniform. */
  matrix() { return this.m }

  /** this = this · other, so later calls apply further from the geometry. */
  #mul(other) { return new Transform(multiply(this.m, other)) }
}

/** Coerce a Transform, a 9-element array, or null/undefined into a matrix or null. */
export function toMatrix(value) {
  if (!value) return null
  if (value instanceof Transform) return value.matrix()
  if (value.length === 9) return Float32Array.from(value)
  throw new Error('Tulle: a transform must be a Transform or a 9-element matrix.')
}

// ── Matrix builders (column-major: index = col*3 + row) ─────────────────────────

function fromTranslate(tx, ty) {
  return new Float32Array([1, 0, 0, 0, 1, 0, tx, ty, 1])
}

function fromScale(sx, sy) {
  return new Float32Array([sx, 0, 0, 0, sy, 0, 0, 0, 1])
}

function fromRotate(rad) {
  const c = Math.cos(rad), s = Math.sin(rad)
  return new Float32Array([c, s, 0, -s, c, 0, 0, 0, 1])
}

/** a · b, both column-major 3×3. */
function multiply(a, b) {
  const out = new Float32Array(9)
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 3; row++) {
      let sum = 0
      for (let k = 0; k < 3; k++) sum += a[k * 3 + row] * b[col * 3 + k]
      out[col * 3 + row] = sum
    }
  }
  return out
}
