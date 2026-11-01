/**
 * Image → splat tests — depth lifting, backfill, depth-map resampling, and the
 * .splat writer. Pure math over typed arrays; no model, canvas, or GPU.
 *
 *   npm test
 */
import { splatFromDepth, normalizeDepth, snapEdges } from '../src/core/imageSplat.js'
import { encodeSplat, parseSplat, toSplatData } from '../src/core/splatData.js'
import { windowCamera, multiply, transformPoint } from '../src/core/camera.js'

let failed = 0
const ok = (cond, msg) => { if (cond) console.log(`ok    ${msg}`); else { console.error(`FAIL  ${msg}`); failed++ } }
const throws = (fn, msg) => { try { fn(); console.error(`FAIL  ${msg} — did not throw`); failed++ } catch { console.log(`ok    ${msg}`) } }
const near = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps

/** A w×h opaque image whose red channel is the column index. */
function image(w, h, alpha = () => 255) {
  const px = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) px.set([i % w, 0, 0, alpha(i)], i * 4)
  return px
}

// ── Lifting ──────────────────────────────────────────────────────────────────

{
  const w = 8, h = 4
  const flat = splatFromDepth({ pixels: image(w, h), disparity: new Float32Array(w * h).fill(1), width: w, height: h }, { fov: 60, overscan: 0 })
  ok(flat.data.count === w * h, 'one splat per opaque pixel (no backfill on a flat image)')
  ok([...Array(w * h).keys()].every(i => near(flat.data.positions[i * 3 + 2], -1)), 'disparity 1 → depth 1 (nearest)')
  ok(flat.camera.target[2] === -1 && near(flat.camera.fov, 60) && flat.camera.up[1] === 1, 'camera: median depth on the glass, same fov, y-up')
  const over = splatFromDepth({ pixels: image(w, h), disparity: new Float32Array(w * h).fill(1), width: w, height: h }, { fov: 60, overscan: 0.1 })
  ok(near(Math.tan(over.camera.fov * Math.PI / 360), 0.9 * Math.tan(Math.PI / 6)), 'camera: overscan frames 10% tighter')

  // From the returned camera with no head offset, every splat lands on its own pixel.
  const { view, proj } = windowCamera({ ...flat.camera, aspect: w / h })
  const vp = multiply(proj, view)
  const onPixel = [...Array(w * h).keys()].every(i => {
    const c = transformPoint(vp, flat.data.positions.subarray(i * 3, i * 3 + 3))
    const px = (c[0] / c[3] + 1) / 2 * w, py = (1 - c[1] / c[3]) / 2 * h
    return near(px, (i % w) + 0.5, 1e-3) && near(py, Math.floor(i / w) + 0.5, 1e-3)
  })
  ok(onPixel, 'zero offset reproduces the photo: each splat projects to its pixel centre')
  ok(flat.data.colors[5 * 4] === 5, 'colours come from the pixels, in order')
}

{
  // Disparity 0 is the far plane; inverse depth is linear in disparity.
  const d = splatFromDepth({ pixels: image(3, 1), disparity: [0, 0.5, 1], width: 3, height: 1 }, { far: 4, backfill: false })
  const z = i => -d.data.positions[i * 3 + 2]
  ok(near(z(0), 4) && near(z(2), 1) && near(1 / z(1), (1 / 4 + 1) / 2), 'depth: far at 0, 1 at 1, linear in inverse depth')
  ok(d.data.positions[0] < d.data.positions[6] && near(d.data.positions[1], 0), 'positions lie on their pixel rays')
  ok(d.data.scales[0] > d.data.scales[6], 'farther splats are larger (constant pixel footprint)')
}

{
  // A smooth ramp stretches splats along depth; a hard edge does not. Rows of a
  // 64×48 image, so a pixel is a realistic sliver of the field of view.
  const w = 64, h = 48
  const rows = f => Float32Array.from({ length: w * h }, (_, i) => f(i % w))
  const mid = (h / 2) * w + w / 4 // a pixel well inside the left half, mid-height

  const r = splatFromDepth({ pixels: image(w, h), disparity: rows(x => x / (w - 1)), width: w, height: h }, { far: 3, backfill: false })
  const step = Math.abs(r.data.positions[(mid + 1) * 3 + 2] - r.data.positions[mid * 3 + 2])
  ok(r.data.scales[mid * 3 + 2] > r.data.scales[mid * 3] && r.data.scales[mid * 3 + 2] >= 0.5 * step,
    'slope: depth axis stretches to cover the step to its neighbours')

  const edge = rows(x => x < 30 ? 0 : 1) // mid-block, as real edges usually are
  const e = splatFromDepth({ pixels: image(w, h), disparity: edge, width: w, height: h }, { far: 4, backfill: false })
  const at = (h / 2) * w + 30
  ok(near(e.data.scales[at * 3 + 2], e.data.scales[at * 3]) && near(e.data.scales[(at - 1) * 3 + 2], e.data.scales[(at - 1) * 3]),
    'edge: no stretching across a depth discontinuity')

  const b = splatFromDepth({ pixels: image(w, h), disparity: edge, width: w, height: h }, { far: 4 })
  const extra = b.data.count - w * h
  const plate = [...Array(extra).keys()].map(j => ({ x: b.data.positions[(w * h + j) * 3], z: -b.data.positions[(w * h + j) * 3 + 2] }))
  ok(extra > 0 && plate.every(p => near(p.z, 4 * 1.01)), 'backfill: a plate just behind the far side of the edge')
  ok(plate.some(p => p.x > 0.05), 'backfill: the plate extends under the foreground, not just at the edge')
  const flatB = splatFromDepth({ pixels: image(w, h), disparity: new Float32Array(w * h).fill(0.5), width: w, height: h })
  ok(flatB.data.count === w * h, 'backfill: none where nothing stands in front of anything')
}

{
  const transparent = splatFromDepth({ pixels: image(4, 1, i => (i % 2 ? 0 : 255)), disparity: [1, 1, 1, 1], width: 4, height: 1 })
  ok(transparent.data.count === 2, 'transparent pixels make no splat')
}

// ── snapEdges ────────────────────────────────────────────────────────────────

{
  // A blurred edge: 1 1 1 1.5 2 2.5 3 3 3 — the ramp pixels snap to a side.
  const ramp = Float32Array.from([1, 1, 1, 1.5, 2, 2.5, 3, 3, 3])
  const snapped = snapEdges(ramp, 9, 1, 0.01)
  ok([...snapped].every(v => v === 1 || v === 3), 'snap: a blurred edge becomes a step — no pixels left mid-air')
  ok(snapped[3] === 1 && snapped[5] === 3, 'snap: each pixel goes to the nearer side')
  const gentle = Float32Array.from([1, 1.001, 1.002, 1.003, 1.004])
  ok(snapEdges(gentle, 5, 1, 0.01).every((v, i) => v === gentle[i]), 'snap: smooth slopes are untouched')
}

// ── normalizeDepth ───────────────────────────────────────────────────────────

{
  const n = normalizeDepth({ data: [10, 20, 30, 40], width: 2, height: 2 }, 2, 2)
  ok(n[0] === 0 && n[3] === 1 && near(n[1], 1 / 3), 'normalize: stretched to 0..1')
  const up = normalizeDepth({ data: [0, 1], width: 2, height: 1 }, 4, 1)
  ok(up[0] === 0 && up[3] === 1 && up[1] > 0 && up[1] < up[2], 'normalize: bilinear upsampling is monotone')
  ok(normalizeDepth({ data: [5, 5], width: 2, height: 1 }, 2, 1).every(v => v === 1), 'normalize: a constant map is flat, not NaN')
  throws(() => normalizeDepth({ data: [1], width: 2, height: 2 }, 2, 2), 'normalize: rejects a short map')
}

// ── encodeSplat ──────────────────────────────────────────────────────────────

{
  const h = Math.SQRT1_2
  const src = toSplatData({
    positions: [1, 2, 3, -4, 5, -6],
    scales: [0.1, 0.2, 0.3, 1, 2, 3],
    rotations: [1, 0, 0, 0, h, 0, h, 0],
    colors: [1, 2, 3, 4, 250, 251, 252, 253],
  })
  const back = parseSplat(encodeSplat(src))
  ok(back.count === 2 && back.positions.every((v, i) => v === src.positions[i]), 'encode → parse: positions exact')
  ok(back.scales.every((v, i) => v === src.scales[i]) && back.colors.every((v, i) => v === src.colors[i]), 'encode → parse: scales and colours exact')
  ok(back.rotations.every((v, i) => near(v, src.rotations[i], 1e-2)), 'encode → parse: rotations within byte quantisation')
}

console.log('')
if (failed) { console.error(`${failed} test(s) failed.`); process.exit(1) }
console.log('image splat: all tests passed.')
