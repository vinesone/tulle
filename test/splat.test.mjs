/**
 * Gaussian splat tests — parsing, GPU packing, depth sort, and the off-axis
 * window camera. Pure typed-array math; no canvas or GPU needed.
 *
 *   npm test
 */
import { parseSplat, parsePly, parseSplatFile, toSplatData, packSplats, sortSplats, boundsOf, covariance, toHalf, PACK_WIDTH } from '../src/core/splatData.js'
import { windowCamera, lookAt, perspective, multiply, transformPoint, basis } from '../src/core/camera.js'

let failed = 0
const ok = (cond, msg) => { if (cond) console.log(`ok    ${msg}`); else { console.error(`FAIL  ${msg}`); failed++ } }
const throws = (fn, msg) => { try { fn(); console.error(`FAIL  ${msg} — did not throw`); failed++ } catch { console.log(`ok    ${msg}`) } }
const near = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps

// ── Half floats ──────────────────────────────────────────────────────────────

ok(toHalf(1) === 0x3c00 && toHalf(-2) === 0xc000 && toHalf(0.5) === 0x3800, 'toHalf: exact powers of two')
ok(toHalf(0) === 0 && toHalf(65504) === 0x7bff && toHalf(1e6) === 0x7c00, 'toHalf: zero, max finite, overflow → ∞')
ok(toHalf(2 ** -24) === 0x0001 && toHalf(2 ** -30) === 0, 'toHalf: smallest subnormal, flush below it')
ok(toHalf(2047 / 1024) === 0x3fff && toHalf(4095 / 2048) === 0x4000, 'toHalf: round-to-nearest carries into the exponent')

// ── .splat ───────────────────────────────────────────────────────────────────

{
  const buf = new ArrayBuffer(64)
  const f = new Float32Array(buf), u = new Uint8Array(buf)
  f.set([1, 2, 3, 0.1, 0.2, 0.3], 0)
  u.set([255, 128, 0, 200, 255, 128, 128, 128], 24)   // colour; rot ≈ (1,0,0,0)
  f.set([-1, -2, -3, 1, 1, 1], 8)
  u.set([10, 20, 30, 40, 128, 255, 128, 128], 56)     // rot ≈ (0,1,0,0)
  const d = parseSplat(buf)
  ok(d.count === 2, '.splat: 32 bytes per splat')
  ok(d.positions[2] === 3 && d.positions[3] === -1, '.splat: positions')
  ok(near(d.scales[1], 0.2) && d.scales[5] === 1, '.splat: scales (linear)')
  ok(d.colors[0] === 255 && d.colors[3] === 200 && d.colors[7] === 40, '.splat: colours')
  ok(near(d.rotations[0], 1) && near(d.rotations[5], 1, 1e-2), '.splat: rotations decoded and normalised')
  ok(parseSplatFile(buf).count === 2, 'parseSplatFile sniffs a non-ply buffer as .splat')
  throws(() => parseSplat(new ArrayBuffer(33)), '.splat: rejects a partial record')
}

// ── .ply ─────────────────────────────────────────────────────────────────────

/** Build a binary little-endian .ply with the given float properties. */
function ply(props, rows, extraHeader = '') {
  const header = `ply\nformat binary_little_endian 1.0\n${extraHeader}element vertex ${rows.length}\n` +
    props.map(p => `property float ${p}\n`).join('') + 'end_header\n'
  const head = new TextEncoder().encode(header)
  const buf = new ArrayBuffer(head.length + rows.length * props.length * 4)
  new Uint8Array(buf).set(head)
  const view = new DataView(buf)
  rows.flat().forEach((v, i) => view.setFloat32(head.length + i * 4, v, true))
  return buf
}

{
  const props = ['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
    'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3']
  const d = parsePly(ply(props, [
    [1, 2, 3, 0, 0, 0, 0, 0, 0, 0, Math.log(0.5), Math.log(0.25), 0, 2, 0, 0, 0],
    [4, 5, 6, 0, 0, 0, 1 / 0.28209479177387814 / 2, -10, 0, 100, 0, 0, 0, 0, 0, 0, 3],
  ]))
  ok(d.count === 2 && d.positions[3] === 4, '.ply: positions')
  ok(near(d.scales[0], 0.5) && near(d.scales[1], 0.25) && near(d.scales[2], 1), '.ply: scales are exp(log-scale)')
  ok(d.rotations[0] === 1 && d.rotations[7] === 1, '.ply: rot_0..3 is w x y z, normalised')
  ok(d.colors[0] === 128 && d.colors[3] === 128, '.ply: f_dc 0 → mid grey; opacity 0 → sigmoid 0.5')
  ok(d.colors[4] === 255 && d.colors[5] === 0 && d.colors[7] === 255, '.ply: SH colour clamps; opacity logit → sigmoid')
  ok(parseSplatFile(ply(props, [[0, 0, 0, ...Array(14).fill(0)]])).count === 1, 'parseSplatFile sniffs the ply magic')
}

{
  // A plain point cloud: no scales, uchar colours — loads as small round splats.
  const header = 'ply\nformat binary_little_endian 1.0\ncomment from a scanner\nelement vertex 1\n' +
    'property float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n'
  const head = new TextEncoder().encode(header)
  const buf = new ArrayBuffer(head.length + 15)
  new Uint8Array(buf).set(head)
  const view = new DataView(buf)
  view.setFloat32(head.length + 8, 7, true)
  new Uint8Array(buf).set([255, 0, 51], head.length + 12)
  const d = parsePly(buf, { pointSize: 0.05 })
  ok(d.positions[2] === 7 && d.colors[0] === 255 && d.colors[2] === 51 && d.colors[3] === 255, '.ply point cloud: uchar colours, opaque')
  ok(near(d.scales[0], 0.05) && d.rotations[0] === 1, '.ply point cloud: pointSize and identity rotation')
}

throws(() => parsePly(new TextEncoder().encode('ply\nformat ascii 1.0\nelement vertex 0\nend_header\n').buffer), '.ply: rejects ascii with a clear error')
throws(() => parsePly(ply(['x', 'y', 'z'], [[1, 2, 3]]).slice(0, -4)), '.ply: rejects a truncated body')
throws(() => parsePly(ply(['x', 'y'], [[1, 2]])), '.ply: rejects vertices without z')

// ── toSplatData ──────────────────────────────────────────────────────────────

{
  const d = toSplatData({ positions: [0, 0, 0, 1, 1, 1] }, { pointSize: 0.2 })
  ok(d.count === 2 && near(d.scales[5], 0.2) && d.rotations[4] === 1 && d.colors[7] === 255, 'toSplatData fills defaults')
  throws(() => toSplatData({ positions: [0, 0, 0], colors: [1, 2] }), 'toSplatData rejects short arrays')
  throws(() => toSplatData({}), 'toSplatData requires positions')
}

// ── Covariance + packing ─────────────────────────────────────────────────────

{
  // Axis-aligned: Σ = diag(s²).
  const c = covariance([2, 3, 4], [1, 0, 0, 0], 0)
  ok(near(c[0], 4) && near(c[3], 9) && near(c[5], 16) && c[1] === 0 && c[2] === 0 && c[4] === 0, 'covariance: identity rotation → diag(s²)')

  // 90° about z swaps x and y variances.
  const h = Math.SQRT1_2
  const r = covariance([2, 3, 4], [h, 0, 0, h], 0)
  ok(near(r[0], 9) && near(r[3], 4) && near(r[5], 16) && near(r[1], 0), 'covariance: 90° about z swaps the x/y axes')

  const data = toSplatData({ positions: [1.5, -2, 3], scales: [0.5, 0.5, 0.5], colors: [10, 20, 30, 40] })
  const packed = packSplats(data)
  const f = new Float32Array(packed.data.buffer)
  ok(packed.width === PACK_WIDTH && packed.height === 1 && packed.data.length === PACK_WIDTH * 4, 'pack: one row of RGBA32UI texels')
  ok(f[0] === 1.5 && f[1] === -2 && f[2] === 3, 'pack: texel 0 holds position float bits')
  ok(packed.data[3] === (10 | 20 << 8 | 30 << 16 | 40 << 24), 'pack: colour packed little-endian into texel 0 .w')
  ok((packed.data[4] & 0xffff) === toHalf(4 * 0.25) && (packed.data[4] >>> 16) === 0, 'pack: texel 1 holds 4·Σ as half floats')
  ok(packSplats(toSplatData({ positions: new Float32Array(3 * 1025) })).height === 2, 'pack: 1024 splats per row')
}

// ── Sorting ──────────────────────────────────────────────────────────────────

{
  // Camera at origin looking down −z: z = −10 is farthest and must draw first.
  const positions = new Float32Array([0, 0, -1, 0, 0, -10, 0, 0, -5, 0, 0, -5.5])
  const view = lookAt([0, 0, 0], [0, 0, -1])
  ok(sortSplats(positions, 4, view).join() === '1,3,2,0', 'sort: back to front along the view axis')
  const turned = lookAt([0, 0, -20], [0, 0, 0])
  ok(sortSplats(positions, 4, turned).join() === '0,2,3,1', 'sort: reverses when the camera turns around')
  ok(sortSplats(new Float32Array([1, 1, 1, 1, 1, 1]), 2, view).join() === '0,1', 'sort: equal depths keep their order')
}

// ── Bounds ───────────────────────────────────────────────────────────────────

{
  const n = 1000
  const p = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) { p[i * 3] = (i % 100) / 100; p[i * 3 + 1] = 0; p[i * 3 + 2] = 0 }
  p[0] = 1e6 // a floater
  const b = boundsOf(p, n)
  ok(b.max[0] < 1.01 && b.min[0] >= 0, 'bounds: percentile box ignores floaters')
  ok(near(b.center[0], 0.5, 0.02) && b.center[1] === 0, 'bounds: centre is the median, not dragged by outliers')
  ok(boundsOf(new Float32Array(0), 0).radius === 1, 'bounds: empty scene has a usable radius')
}

// ── Window camera ────────────────────────────────────────────────────────────

const project = (view, proj, p) => { const c = transformPoint(multiply(proj, view), p); return [c[0] / c[3], c[1] / c[3]] }

{
  const cam = { position: [1, 2, 10], target: [1, 2, 0], up: [0, 1, 0], fov: 60, aspect: 16 / 9, near: 0.1, far: 100 }

  // Zero offset is exactly lookAt + perspective.
  const { view, proj } = windowCamera(cam)
  const v0 = lookAt(cam.position, cam.target, cam.up), p0 = perspective(60, 16 / 9, 0.1, 100)
  ok(view.every((x, i) => near(x, v0[i])) && proj.every((x, i) => near(x, p0[i])), 'window: zero offset = lookAt + perspective')

  // The invariant: wherever the head goes, the window's corners stay on the screen's corners.
  const { right: r, up: u } = basis(cam.position, cam.target, cam.up)
  const hh = 10 * Math.tan(Math.PI / 6), hw = hh * 16 / 9
  const corner = (sx, sy) => [1 + r[0] * sx * hw + u[0] * sy * hh, 2 + r[1] * sx * hw + u[1] * sy * hh, r[2] * sx * hw + u[2] * sy * hh]
  for (const offset of [{ x: 0.7, y: -0.3, z: 0 }, { x: -1, y: 1, z: -0.5 }, { x: 0.2, y: 0.1, z: 2 }]) {
    const w = windowCamera(cam, offset)
    const pinned = [[-1, -1], [1, -1], [-1, 1], [1, 1]].every(([sx, sy]) => {
      const [x, y] = project(w.view, w.proj, corner(sx, sy))
      return near(x, sx, 1e-3) && near(y, sy, 1e-3)
    })
    ok(pinned, `window: corners stay pinned for offset ${JSON.stringify(offset)}`)
  }

  // Parallax: a point behind the window shifts the same way as the head; one in front, the opposite way.
  const w = windowCamera(cam, { x: 0.5, y: 0, z: 0 })
  const behind = project(w.view, w.proj, [1, 2, -10])[0], front = project(w.view, w.proj, [1, 2, 5])[0]
  ok(behind > 0 && front < 0, 'window: head right → far points follow the head, near points slide against it')

  const eye = windowCamera(cam, { x: 1, y: 0, z: 0 }, 0.5).eye
  ok(near(eye[0], 1 + 0.5 * hh) && near(eye[2], 10), 'window: parallax scales the eye offset')
  const clamped = windowCamera(cam, { z: -100 }).eye
  ok(clamped[2] > 0.5, 'window: the eye never reaches the glass')
}

console.log('')
if (failed) { console.error(`${failed} test(s) failed.`); process.exit(1) }
console.log('splat: all tests passed.')
