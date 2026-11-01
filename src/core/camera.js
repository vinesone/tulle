/**
 * Camera math — column-major mat4s (the layout WebGL's uniformMatrix4fv wants)
 * and the one projection head tracking needs: the off-axis "window" camera.
 *
 * A plain perspective camera that follows your head just swings the view around,
 * which reads as the scene sliding, not as depth. A window camera keeps a fixed
 * rectangle in the scene — the focus plane — pinned to the edges of the screen,
 * and moves only the eye. The frustum skews to stay anchored to that rectangle,
 * so things behind the plane parallax away from you and things in front of it
 * pop out, exactly as they would through a real pane of glass.
 *
 *   const { view, proj } = windowCamera({ position, target, fov: 50, aspect }, head.offset)
 *
 * Everything here is pure and allocation-light; no GL.
 */

/** @typedef {[number, number, number]} Vec3 */

const sub   = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const len   = a => Math.hypot(a[0], a[1], a[2])
const norm  = a => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l] }

/** a·b for column-major 4×4 matrices. */
export function multiply(a, b) {
  const out = new Float32Array(16)
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]
  return out
}

/** Transform a point (w = 1) by a column-major mat4; returns [x, y, z, w]. */
export function transformPoint(m, p) {
  const [x, y, z] = p
  return [
    m[0] * x + m[4] * y + m[8]  * z + m[12],
    m[1] * x + m[5] * y + m[9]  * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
    m[3] * x + m[7] * y + m[11] * z + m[15],
  ]
}

/**
 * A view matrix from an eye and an orthonormal basis (right, up, forward). The
 * camera looks down −z in its own space, the GL convention.
 */
function viewFromBasis(eye, r, u, f) {
  return new Float32Array([
    r[0], u[0], -f[0], 0,
    r[1], u[1], -f[1], 0,
    r[2], u[2], -f[2], 0,
    -(r[0] * eye[0] + r[1] * eye[1] + r[2] * eye[2]),
    -(u[0] * eye[0] + u[1] * eye[1] + u[2] * eye[2]),
     (f[0] * eye[0] + f[1] * eye[1] + f[2] * eye[2]),
    1,
  ])
}

/** Right/up/forward for a camera at `position` looking at `target`. */
export function basis(position, target, up = [0, 1, 0]) {
  const f = norm(sub(target, position))
  let r = cross(f, up)
  // Looking straight along `up` leaves the basis undefined; pick any perpendicular.
  if (len(r) < 1e-8) r = cross(f, Math.abs(f[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1])
  r = norm(r)
  return { right: r, up: cross(r, f), forward: f }
}

/** A view matrix looking from `position` to `target`. */
export function lookAt(position, target, up = [0, 1, 0]) {
  const { right, up: u, forward } = basis(position, target, up)
  return viewFromBasis(position, right, u, forward)
}

/** glFrustum: an asymmetric perspective projection. */
export function frustum(l, r, b, t, n, f) {
  return new Float32Array([
    2 * n / (r - l), 0, 0, 0,
    0, 2 * n / (t - b), 0, 0,
    (r + l) / (r - l), (t + b) / (t - b), -(f + n) / (f - n), -1,
    0, 0, -2 * f * n / (f - n), 0,
  ])
}

/** A symmetric perspective projection; `fov` is vertical, in degrees. */
export function perspective(fov, aspect, n, f) {
  const t = n * Math.tan(fov * Math.PI / 360)
  return frustum(-t * aspect, t * aspect, -t, t, n, f)
}

/**
 * The off-axis window camera.
 *
 * The base camera (`position` → `target`, `fov`, `aspect`) defines the window:
 * the rectangle on the plane through `target` that it sees exactly. `offset`
 * moves the eye relative to that window, in units of the window's half-height —
 * the same units HeadTracker.offset reports, so a head one half-screen to the
 * right moves the eye one half-window to the right. `x` is right, `y` up, and
 * `z` away from the screen (negative leans in). The window never moves, so
 * whatever sits on the target plane stays put on screen.
 *
 * With a zero offset this is exactly lookAt + perspective.
 *
 * @param {{ position: Vec3, target: Vec3, up?: Vec3, fov?: number, aspect?: number,
 *           near?: number, far?: number }} camera
 * @param {{ x?: number, y?: number, z?: number } | null} [offset]
 * @param {number} [parallax=1] — scales the offset; 0 freezes the view.
 * @returns {{ view: Float32Array, proj: Float32Array, eye: Vec3 }}
 */
export function windowCamera(camera, offset = null, parallax = 1) {
  const { position, target, up = [0, 1, 0], fov = 50, aspect = 1 } = camera
  const { right: r, up: u, forward: f } = basis(position, target, up)

  const D  = len(sub(target, position)) || 1
  const hh = D * Math.tan(fov * Math.PI / 360) // window half-height, world units
  const hw = hh * aspect
  const near = camera.near ?? D * 0.02
  const far  = camera.far  ?? D * 200

  const ox = (offset?.x ?? 0) * hh * parallax
  const oy = (offset?.y ?? 0) * hh * parallax
  // Never let the eye reach (or pass) the glass — the frustum would invert.
  const oz = Math.max((offset?.z ?? 0) * hh * parallax, -D * 0.9)

  const eye = [
    position[0] + r[0] * ox + u[0] * oy - f[0] * oz,
    position[1] + r[1] * ox + u[1] * oy - f[1] * oz,
    position[2] + r[2] * ox + u[2] * oy - f[2] * oz,
  ]

  // Window edges relative to the eye, scaled from the window plane to the near plane.
  const k = near / (D + oz)
  return {
    view: viewFromBasis(eye, r, u, f),
    proj: frustum((-hw - ox) * k, (hw - ox) * k, (-hh - oy) * k, (hh - oy) * k, near, far),
    eye,
  }
}
