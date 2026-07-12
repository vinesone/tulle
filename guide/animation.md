[← Tulle](../README.md)

# Animation

One rule powers all of it: **any param can be a function of the frame context**.
The helpers here just manufacture those functions — the core never learns what
a keyframe is.

## Animated params

Any effect param — and any [layout](compositing.md#flow-layout) size, offset,
opacity, rotation, or scale — can be a function instead of a value. It's
re-evaluated every frame, so animation needs no keyframe system in the core — a
track, an easing curve, or a spring is just a function you write:

```js
tulle.chain([
  { name: 'blur', params: { radius: ({ time }) => 12 + 8 * Math.sin(time * 2) } },
])

// reach for the pointer, the frame counter, delta — whatever the context carries
tulle.set('ripple', { center: ({ pointer }) => [pointer.u, pointer.v] })
```

The context is `{ time, delta, frame, pointer, scrollX, scrollY }`.

## Tweens and scroll reveals

The helpers in `tulle` are factories that *return* such functions —
`keyframes()` for tracks, `wave()` for idle sway, and a one-shot `tween()`
behind a named entrance/exit vocabulary:

```js
import { fadeIn, slideFrom, scaleFrom, rotateFrom, scrollRange } from 'tulle'

box(title, {
  opacity: fadeIn({ duration: 0.6, delay: 0.2 }),
  offset:  { top: slideFrom(60) },   // 60px below, sliding into place
  scale:   scaleFrom(0.85),          // growing into place, about the centre
  rotate:  rotateFrom(-0.1),         // radians, settling upright
})
```

`fadeIn` / `fadeOut` drive `opacity`; `slideFrom` / `slideTo` drive an `offset`
side; `scaleFrom` / `scaleTo` and `rotateFrom` / `rotateTo` drive the box
[`scale` and `rotate`](compositing.md#flow-layout) options. All take
`{ duration, delay, ease, at }`. A tween **starts the first frame it's
evaluated** — an entrance begins when its box first renders, live or under a
deterministic export — or pass `at` (seconds) to pin the start explicitly,
e.g. from a [Clip cue](sources.md#video-clips).

`scrollRange(start, end)` is the scroll-linked counterpart: 0 before `start`,
1 after `end`, eased in between. It's the primitive behind "reveal on scroll":

```js
box(title, { opacity: scrollRange(top - H * 0.9, top - H * 0.3, { ease: 'outCubic' }) })
```

## Tracks and oscillators

`keyframes()` interpolates a track of `{ t, v, ease? }` frames; `wave()` sways
between two values forever. Both read `ctx.time` (or another context field via
`by`), so they render identically live and under a deterministic export:

```js
import { keyframes, wave } from 'tulle'

tulle.set('blur', { radius: keyframes([{ t: 0, v: 0 }, { t: 1.5, v: 20, ease: 'outCubic' }]) })
box(title, { offset: { top: wave({ from: -8, to: 8, hz: 0.5 }) } })
```

Easing names (`linear`, `inQuad`…`outBack`) live on the exported `easings`
object; anywhere an `ease` option is accepted, a name or a custom
`t => t` curve works.
