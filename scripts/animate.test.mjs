/**
 * animate tests — pure value-of-time helpers, no GPU.
 *
 * keyframes / wave / easings return plain functions of a frame context, so they
 * are testable by calling them with { time }. Same discipline as the other pure
 * cores (layoutLines, dueCues, solveLayout).
 *
 *   npm test
 */
import {
  keyframes, wave, easings, lerp,
  tween, fadeIn, fadeOut, slideFrom, slideTo, scaleFrom, rotateTo, scrollRange,
} from '../src/core/animate.js'

let failed = 0
const near = (a, b) => Math.abs(a - b) < 1e-6
const ok = (cond, msg) => { if (cond) console.log(`ok    ${msg}`); else { console.error(`FAIL  ${msg}`); failed++ } }
const eqN = (got, want, msg) => ok(near(got, want), `${msg} — got ${got}, want ${want}`)

// ── lerp ─────────────────────────────────────────────────────────────────────
eqN(lerp(0, 10, 0.5), 5, 'lerp: midpoint')
ok(JSON.stringify(lerp([0, 0], [10, 20], 0.5)) === '[5,10]', 'lerp: arrays component-wise')

// ── easings hit their endpoints and stay monotone-ish ────────────────────────
for (const [name, fn] of Object.entries(easings)) {
  ok(near(fn(0), 0), `ease ${name}: f(0) = 0`)
  ok(near(fn(1), 1), `ease ${name}: f(1) = 1`)
}
ok(easings.outQuad(0.5) > 0.5, 'outQuad: decelerates (ahead at the midpoint)')
ok(easings.inQuad(0.5)  < 0.5, 'inQuad: accelerates (behind at the midpoint)')

// ── keyframes: hold, interpolate, clamp ──────────────────────────────────────
{
  const t = keyframes([{ t: 0, v: 0 }, { t: 2, v: 20 }])
  eqN(t({ time: -1 }), 0,  'keyframes: holds first value before the start')
  eqN(t({ time: 0 }),  0,  'keyframes: at first frame')
  eqN(t({ time: 1 }),  10, 'keyframes: linear midpoint')
  eqN(t({ time: 2 }),  20, 'keyframes: at last frame')
  eqN(t({ time: 5 }),  20, 'keyframes: clamps to last value after the end')
}

// ── keyframes: the ease shapes the segment ending at that frame ──────────────
{
  const t = keyframes([{ t: 0, v: 0 }, { t: 1, v: 10, ease: 'outQuad' }])
  ok(t({ time: 0.5 }) > 5, 'keyframes: outQuad segment is ahead of linear at the midpoint')
}

// ── keyframes: multi-segment picks the right pair ────────────────────────────
{
  const t = keyframes([{ t: 0, v: 0 }, { t: 1, v: 10 }, { t: 2, v: 0 }])
  eqN(t({ time: 0.5 }), 5, 'keyframes: first segment')
  eqN(t({ time: 1.5 }), 5, 'keyframes: second segment descends')
}

// ── keyframes: array values interpolate ──────────────────────────────────────
{
  const t = keyframes([{ t: 0, v: [0, 0] }, { t: 1, v: [10, 20] }])
  ok(JSON.stringify(t({ time: 0.5 })) === '[5,10]', 'keyframes: interpolates vectors')
}

// ── keyframes: loop wraps over the span ──────────────────────────────────────
{
  const t = keyframes([{ t: 0, v: 0 }, { t: 2, v: 20 }], { loop: true })
  eqN(t({ time: 1 }), 10, 'keyframes loop: within the first span')
  eqN(t({ time: 3 }), 10, 'keyframes loop: wraps (3 → 1)')
}

// ── keyframes: needs at least one frame ──────────────────────────────────────
{
  let threw = false
  try { keyframes([]) } catch { threw = true }
  ok(threw, 'keyframes: empty frames throw')
}

// ── wave: oscillates between from and to ─────────────────────────────────────
{
  const w = wave({ from: 0, to: 10, hz: 1 })
  eqN(w({ time: 0 }),    5,  'wave: starts mid-swing (sin 0)')
  eqN(w({ time: 0.25 }), 10, 'wave: peak at a quarter cycle')
  eqN(w({ time: 0.75 }), 0,  'wave: trough at three-quarters')
}

// ── tween: latches its start on first evaluation ─────────────────────────────
{
  const t = tween({ from: 0, to: 10, duration: 1, ease: 'linear' })
  eqN(t({ time: 5 }),   0,  'tween: first evaluation latches the start (value = from)')
  eqN(t({ time: 5.5 }), 5,  'tween: halfway through the duration')
  eqN(t({ time: 6 }),   10, 'tween: done at start + duration')
  eqN(t({ time: 9 }),   10, 'tween: clamps at to')
}

// ── tween: explicit start, delay, zero duration, default ease ────────────────
{
  const t = tween({ at: 2, duration: 1, ease: 'linear' })
  eqN(t({ time: 0 }),   0,   'tween at: holds from before the pinned start')
  eqN(t({ time: 2.5 }), 0.5, 'tween at: progresses from the pinned start')
}
{
  const t = tween({ at: 0, delay: 1, duration: 1, ease: 'linear' })
  eqN(t({ time: 0.5 }), 0,   'tween delay: holds through the delay')
  eqN(t({ time: 1.5 }), 0.5, 'tween delay: then progresses')
}
{
  const t = tween({ at: 1, duration: 0 })
  eqN(t({ time: 0.9 }), 0, 'tween duration 0: from before the start')
  eqN(t({ time: 1 }),   1, 'tween duration 0: jumps straight to to')
}
{
  const t = tween({ at: 0, duration: 1 }) // default ease is outCubic
  ok(t({ time: 0.5 }) > 0.5, 'tween: default outCubic is ahead at the midpoint')
}

// ── the named wrappers map intent onto from/to ───────────────────────────────
{
  const lin = { at: 0, duration: 1, ease: 'linear' }
  eqN(fadeIn(lin)({ time: 0 }),  0,  'fadeIn: starts transparent')
  eqN(fadeIn(lin)({ time: 1 }),  1,  'fadeIn: ends opaque')
  eqN(fadeOut(lin)({ time: 0 }), 1,  'fadeOut: starts opaque')
  eqN(fadeOut(lin)({ time: 1 }), 0,  'fadeOut: ends transparent')
  eqN(slideFrom(60, lin)({ time: 0.5 }), 30, 'slideFrom: halfway home')
  eqN(slideFrom(60, lin)({ time: 1 }),   0,  'slideFrom: settles at the flow position')
  eqN(slideTo(60, lin)({ time: 1 }),     60, 'slideTo: departs to the distance')
  eqN(scaleFrom(0.5, lin)({ time: 0.5 }), 0.75, 'scaleFrom: grows toward 1')
  eqN(rotateTo(Math.PI, lin)({ time: 1 }), Math.PI, 'rotateTo: reaches the angle')
}

// ── scrollRange: progress between two scroll offsets ─────────────────────────
{
  const r = scrollRange(100, 200)
  eqN(r({ scrollY: 50 }),  0,   'scrollRange: 0 before start')
  eqN(r({ scrollY: 150 }), 0.5, 'scrollRange: midpoint')
  eqN(r({ scrollY: 250 }), 1,   'scrollRange: 1 after end')
}
{
  const r = scrollRange(200, 100) // reversed: 1 → 0 as scroll grows
  eqN(r({ scrollY: 50 }),  1, 'scrollRange reversed: 1 before the (higher) start')
  eqN(r({ scrollY: 250 }), 0, 'scrollRange reversed: 0 after the (lower) end')
}
{
  const r = scrollRange(100, 100) // degenerate range → a step
  eqN(r({ scrollY: 99 }),  0, 'scrollRange step: 0 below')
  eqN(r({ scrollY: 100 }), 1, 'scrollRange step: 1 at the mark')
  const x = scrollRange(0, 100, { by: 'scrollX' })
  eqN(x({ scrollX: 50 }), 0.5, 'scrollRange: by scrollX')
}

console.log('')
if (failed) { console.error(`${failed} test(s) failed.`); process.exit(1) }
console.log('animate: all value-of-time tests passed.')
