/**
 * animate — value-of-time helpers.
 *
 * Tulle's core already accepts a param that is a *function of the frame context*
 * (see Effect.#pushUniforms and Tulle's layout solver): it is resolved fresh every
 * frame. That single rule is the whole animation feature — the core never learns
 * what a keyframe is. This module is the userland layer built on it: easing curves,
 * a keyframe track, and a sine oscillator, each of which just returns such a
 * function.
 *
 *   import { keyframes, wave } from 'tulle'
 *
 *   tulle.set('blur', { radius: keyframes([{ t: 0, v: 0 }, { t: 1.5, v: 20, ease: 'outCubic' }]) })
 *   tulle.layout(block([ box(title, { offset: { top: wave({ from: -8, to: 8, hz: 0.5 }) } }) ]))
 *
 * Everything here is a **pure function of time** (it reads `ctx.time`, never a wall
 * clock or an integrated delta), so it renders identically in a live preview and a
 * deterministic renderAt() export. That is deliberate: an easing curve is fine, a
 * delta-integrating spring is not, because delta differs between preview and export.
 */

/** Linear interpolation. Works on numbers and equal-length arrays (component-wise). */
export function lerp(a, b, t) {
  if (Array.isArray(a) && Array.isArray(b)) return a.map((av, i) => av + (b[i] - av) * t)
  return a + (b - a) * t
}

/**
 * Easing curves: each maps progress 0..1 to eased 0..1, with f(0)=0 and f(1)=1.
 * `in` accelerates, `out` decelerates, `inOut` does both.
 */
export const easings = {
  linear: t => t,

  inQuad:    t => t * t,
  outQuad:   t => 1 - (1 - t) * (1 - t),
  inOutQuad: t => t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2,

  inCubic:    t => t * t * t,
  outCubic:   t => 1 - (1 - t) ** 3,
  inOutCubic: t => t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2,

  inQuart:    t => t ** 4,
  outQuart:   t => 1 - (1 - t) ** 4,
  inOutQuart: t => t < 0.5 ? 8 * t ** 4 : 1 - (-2 * t + 2) ** 4 / 2,

  inSine:    t => 1 - Math.cos((t * Math.PI) / 2),
  outSine:   t => Math.sin((t * Math.PI) / 2),
  inOutSine: t => -(Math.cos(Math.PI * t) - 1) / 2,

  inExpo:    t => (t === 0 ? 0 : 2 ** (10 * t - 10)),
  outExpo:   t => (t === 1 ? 1 : 1 - 2 ** (-10 * t)),
  inOutExpo: t => t === 0 ? 0 : t === 1 ? 1
    : t < 0.5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2,

  // Overshoot-and-settle. Handy for a bit of life on entrances.
  outBack: t => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2 },
  inBack:  t => { const c1 = 1.70158, c3 = c1 + 1; return c3 * t * t * t - c1 * t * t },
}

/** Resolve an ease given by name, by function, or absent (→ linear). */
function resolveEase(ease) {
  if (typeof ease === 'function') return ease
  if (typeof ease === 'string' && easings[ease]) return easings[ease]
  return easings.linear
}

const wrap = (n, m) => ((n % m) + m) % m

/**
 * A keyframe track: returns a function of the frame context that interpolates
 * between the frames by time. Each frame is `{ t, v, ease? }` where `t` is seconds,
 * `v` is a number or an array, and `ease` (a name or a function) shapes the segment
 * *ending* at that frame. Before the first frame it holds the first value; after the
 * last it holds the last (or wraps, with `loop`).
 *
 *   const track = keyframes([{ t: 0, v: 0 }, { t: 1.5, v: 20, ease: 'outCubic' }])
 *   tulle.set('blur', { radius: track })
 *
 * @param {Array<{ t: number, v: number|number[], ease?: string|Function }>} frames
 * @param {{ by?: string, loop?: boolean }} [options] — `by` picks the context field
 *   to read (default 'time'); `loop` repeats the track over its own span.
 * @returns {(ctx: object) => number|number[]}
 */
export function keyframes(frames, { by = 'time', loop = false } = {}) {
  if (!Array.isArray(frames) || frames.length === 0)
    throw new Error('keyframes: need at least one { t, v } frame.')

  const ks = [...frames].sort((a, b) => a.t - b.t)
  const first = ks[0], last = ks[ks.length - 1]
  const span = last.t - first.t

  return ctx => {
    let x = ctx && ctx[by] != null ? ctx[by] : 0
    if (loop && span > 0) x = first.t + wrap(x - first.t, span)
    if (x <= first.t) return first.v
    if (x >= last.t) return last.v

    let i = 1
    while (i < ks.length && ks[i].t <= x) i++
    const a = ks[i - 1], b = ks[i]
    const u = (x - a.t) / (b.t - a.t)
    return lerp(a.v, b.v, resolveEase(b.ease)(u))
  }
}

/**
 * A sine oscillator between `from` and `to`. Returns a function of the frame
 * context — a value that sways forever. Great for idle motion: a breathing scale,
 * a drifting offset.
 *
 *   box(title, { offset: { top: wave({ from: -8, to: 8, hz: 0.5 }) } })
 *
 * @param {{ from?: number, to?: number, hz?: number, phase?: number, by?: string }} [options]
 *   `hz` is cycles per second; `phase` is 0..1 of a cycle.
 * @returns {(ctx: object) => number}
 */
export function wave({ from = 0, to = 1, hz = 1, phase = 0, by = 'time' } = {}) {
  return ctx => {
    const t = ctx && ctx[by] != null ? ctx[by] : 0
    const s = (Math.sin(2 * Math.PI * (hz * t + phase)) + 1) / 2
    return lerp(from, to, s)
  }
}
