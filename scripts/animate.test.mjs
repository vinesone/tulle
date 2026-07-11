/**
 * animate tests — pure value-of-time helpers, no GPU.
 *
 * keyframes / wave / easings return plain functions of a frame context, so they
 * are testable by calling them with { time }. Same discipline as the other pure
 * cores (layoutLines, dueCues, solveLayout).
 *
 *   npm test
 */
import { keyframes, wave, easings, lerp } from '../src/core/animate.js'

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

console.log('')
if (failed) { console.error(`${failed} test(s) failed.`); process.exit(1) }
console.log('animate: all value-of-time tests passed.')
