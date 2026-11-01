/**
 * Head tracking tests — landmark → pose geometry, the One Euro filter, and the
 * tracker's neutral/offset bookkeeping via the manual source. No camera needed.
 *
 *   npm test
 */
import { HeadTracker, OneEuro, poseFromLandmarks } from '../src/core/Head.js'

let failed = 0
const ok = (cond, msg) => { if (cond) console.log(`ok    ${msg}`); else { console.error(`FAIL  ${msg}`); failed++ } }
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps

// ── poseFromLandmarks ────────────────────────────────────────────────────────

/** 478 landmarks with the four eye corners placed; eyes centred on (cx, cy), `gap` apart (px). */
function face(cx, cy, gap, { width = 640, height = 480, dz = 0 } = {}) {
  const lm = Array.from({ length: 478 }, () => ({ x: 0, y: 0, z: 0 }))
  const at = (i, x, z = 0) => { lm[i] = { x: x / width, y: cy / height, z: z / width } }
  // Viewer's left eye is on image-right (unmirrored); corners 10px either side of each centre.
  at(33, cx + gap / 2 + 10, dz); at(133, cx + gap / 2 - 10, dz)
  at(362, cx - gap / 2 + 10, -dz); at(263, cx - gap / 2 - 10, -dz)
  return lm
}

{
  const focal = 320 / Math.tan(Math.PI / 6) // 640px wide, 60° fov
  const centred = poseFromLandmarks(face(320, 240, 100), { width: 640, height: 480, fov: 60, ipd: 63 })
  ok(near(centred.z, focal * 63 / 100) && near(centred.x, 0) && near(centred.y, 0), 'pose: distance from eye spacing; centred → x = y = 0')

  const closer = poseFromLandmarks(face(320, 240, 200), { width: 640, height: 480 })
  ok(near(closer.z, centred.z / 2), 'pose: twice the spacing → half the distance')

  const left = poseFromLandmarks(face(200, 240, 100), { width: 640, height: 480 })
  ok(left.x > 0, 'pose: image-left is the viewer\'s right (unmirrored camera)')
  const up = poseFromLandmarks(face(320, 100, 100), { width: 640, height: 480 })
  ok(up.y > 0, 'pose: image-top is up')

  const turned = poseFromLandmarks(face(320, 240, 80, { dz: 30 }), { width: 640, height: 480 })
  ok(near(turned.z, centred.z, 1e-3), 'pose: a turned head (depth term) doesn\'t read as a farther one')
}

// ── One Euro ─────────────────────────────────────────────────────────────────

{
  const f = new OneEuro({ minCutoff: 1, beta: 0 })
  ok(f.filter(10, 0) === 10, 'one euro: first sample passes through')
  const v = f.filter(20, 1 / 60)
  ok(v > 10 && v < 20, 'one euro: a jump is smoothed')

  // Jitter around a constant settles near it.
  const g = new OneEuro({ minCutoff: 1, beta: 0 })
  let out = 0
  for (let i = 0; i < 300; i++) out = g.filter(5 + (i % 2 ? 1 : -1), i / 60)
  ok(Math.abs(out - 5) < 0.2, 'one euro: alternating jitter is suppressed')

  // Higher beta tracks a fast ramp more closely.
  const lag = beta => {
    const h = new OneEuro({ minCutoff: 1, beta })
    let y = 0
    for (let i = 0; i < 60; i++) y = h.filter(i * 10, i / 60)
    return 590 - y
  }
  ok(lag(0.05) < lag(0), 'one euro: beta reduces lag on fast motion')
  ok(new OneEuro().filter(3, 0) === 3 && (() => { const r = new OneEuro(); r.filter(1, 0); r.reset(); return r.filter(9, 1) === 9 })(), 'one euro: reset() restarts')
}

// ── HeadTracker (manual source) ──────────────────────────────────────────────

{
  const head = new HeadTracker({ source: 'manual', screenHeight: 200, smoothing: { minCutoff: 1000, beta: 0 } })
  await head.start()
  ok(head.running && head.source === 'manual', 'tracker: manual source starts with no camera')
  ok(head.offset.x === 0 && head.neutral === null, 'tracker: zero offset before neutral is fixed')

  let t = 0
  for (let i = 0; i < 10; i++) head.update({ x: 50, y: 0, z: 600 }, t += 16)
  ok(head.neutral && near(head.neutral.x, 50, 0.5), 'tracker: neutral fixed after the filter settles')

  for (let i = 0; i < 20; i++) head.update({ x: 150, y: -100, z: 500 }, t += 16)
  const o = head.offset
  ok(near(o.x, 1, 0.02) && near(o.y, -1, 0.02) && near(o.z, -1, 0.02), 'tracker: offset in screen half-heights from neutral')

  head.recenter()
  ok(near(head.offset.x, 0) && near(head.offset.z, 0), 'tracker: recenter() zeroes the offset')

  let poses = 0
  head.on('pose', () => poses++)
  head.update({ x: 0, y: 0, z: 600 }, t += 16)
  ok(poses === 1 && head.tracking, 'tracker: update() emits pose and marks tracking')

  head.destroy()
  let threw = false
  try { await head.start() } catch { threw = true }
  ok(threw, 'tracker: start() after destroy() throws')
}

{
  // The pointer source needs a pointer; without a fallback a missing camera rejects.
  const noCam = new HeadTracker({ fallback: null })
  let err = null
  try { await noCam.start() } catch (e) { err = e }
  ok(err && /camera/.test(err.message), 'tracker: no camera + no fallback rejects with a reason')

  const pointer = { u: 1, v: 0.5, inside: true }
  const fb = new HeadTracker({ pointer })
  let fellBack = false
  fb.on('fallback', () => { fellBack = true })
  globalThis.requestAnimationFrame ??= () => 0
  globalThis.cancelAnimationFrame ??= () => {}
  await fb.start()
  ok(fellBack && fb.source === 'pointer' && fb.neutral.z === 600, 'tracker: falls back to the pointer when the webcam can\'t start')
  fb.destroy()
}

console.log('')
if (failed) { console.error(`${failed} test(s) failed.`); process.exit(1) }
console.log('head: all tests passed.')
