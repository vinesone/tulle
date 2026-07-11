/**
 * Clip cue tests — pure crossing logic, no video, no DOM, no GPU.
 *
 * dueCues and parseTime are the only parts of Clip with real branching (forward
 * play, one-shots, repeating cues, seeks, loop wraps). Everything else is thin
 * glue over the <video> element, which needs a browser. We test the core here the
 * way Text tests layoutLines.
 *
 *   npm test
 */
import { dueCues, parseTime } from '../src/core/Clip.js'

let failed = 0
const eq = (got, want, msg) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { console.log(`ok    ${msg}`); return }
  console.error(`FAIL  ${msg} — got ${g}, want ${w}`); failed++
}
const ok = (cond, msg) => { if (cond) console.log(`ok    ${msg}`); else { console.error(`FAIL  ${msg}`); failed++ } }

/** Collect the times fired when advancing across [prev, curr]. */
const fires = (cues, prev, curr, continuous = true) =>
  dueCues(cues, prev, curr, continuous).map(f => f.time)

const oneShot = at => ({ at, handler: () => {}, fired: false })
const repeat  = every => ({ every, handler: () => {} })

// ── parseTime ────────────────────────────────────────────────────────────────
eq(parseTime(90),        90,   'parseTime: number passes through')
eq(parseTime('90'),      90,   'parseTime: bare seconds string')
eq(parseTime('1:30'),    90,   'parseTime: mm:ss')
eq(parseTime('0:08'),    8,    'parseTime: leading-zero mm:ss')
eq(parseTime('1:23.5'),  83.5, 'parseTime: fractional seconds')
eq(parseTime('1:02:03'), 3723, 'parseTime: h:mm:ss')
{
  let threw = false
  try { parseTime('1:xx') } catch { threw = true }
  ok(threw, 'parseTime: garbage throws')
}

// ── One-shot: forward crossing ───────────────────────────────────────────────
{
  const cue = oneShot(2.5)
  eq(fires([cue], 2.0, 3.0), [2.5], 'one-shot fires when crossed')
  ok(cue.fired === true, 'one-shot marks itself fired')
  eq(fires([cue], 3.0, 4.0), [], 'a fired one-shot does not re-fire')
}
eq(fires([oneShot(2.5)], 0.0, 2.0), [], 'one-shot silent before its mark')
eq(fires([oneShot(2.5)], 3.0, 4.0), [], 'one-shot silent after its mark (armed past it)')

// ── Multiple one-shots in a single step fire in time order ────────────────────
eq(fires([oneShot(3), oneShot(1), oneShot(2)], 0, 5), [1, 2, 3], 'crossed one-shots fire ascending')

// ── The boundary is (prev, curr] ──────────────────────────────────────────────
eq(fires([oneShot(2)], 2, 3), [], 'mark exactly at prev does not fire (already passed)')
eq(fires([oneShot(3)], 2, 3), [3], 'mark exactly at curr fires')

// ── Repeating: every boundary in the interval ─────────────────────────────────
eq(fires([repeat(1)], 0,   3.2), [1, 2, 3],  'every: each boundary in (0, 3.2]')
eq(fires([repeat(1)], 3.2, 3.9), [],         'every: none when no boundary is crossed')
eq(fires([repeat(0.5)], 0, 1.0), [0.5, 1.0], 'every: sub-second interval')

// ── Seek / discontinuity: nothing fires, one-shots re-arm by position ─────────
{
  const ahead = oneShot(8), behind = oneShot(0.5) // relative to the new playhead at 1
  ahead.fired = true; behind.fired = true         // pretend both already consumed
  eq(fires([ahead, behind], 5, 1, false), [], 'seek fires nothing')
  ok(ahead.fired === false, 'seek re-arms a one-shot now ahead of the playhead')
  ok(behind.fired === true, 'seek leaves a one-shot behind the playhead consumed')
}

// ── Backward move (e.g. loop wrap) is non-continuous: no fire, re-arm ─────────
{
  const cue = oneShot(1); cue.fired = true
  eq(fires([cue], 9.9, 0.05, false), [], 'loop wrap fires nothing on the wrap step')
  ok(cue.fired === false, 'loop wrap re-arms cues ahead of the new position')
}

console.log('')
if (failed) { console.error(`${failed} test(s) failed.`); process.exit(1) }
console.log('Clip: all cue tests passed.')
