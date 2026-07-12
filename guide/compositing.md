[← Tulle](../README.md)

# Compositing

Beyond a single source: layers with their own effect chains and blend modes,
transforms to place them, a CSS-like flow layout to arrange many, and scrolling
compositions.

## Compositing layers

`composite()` stacks layers — each with its own source, effect chain, and blend
mode — then `post()` runs a chain over the whole frame.

```js
tulle.composite([
  { source: clip,  effects: ['blur'] },
  { source: title, blend: 'screen', opacity: 0.8 },
])
.post(['grade', 'vignette'])
.play()   // composite mode: each layer carries its own source
```

Blend modes: `over` `add` `screen`. In this mode `set()` drives the post chain;
`setLayer(i, params)` and `setLayerEffect(i, name, params)` update a layer live.

## Placing layers

A layer with a `transform` lands somewhere other than fullscreen — the basis of
a compositor. `Transform` builds the matrix in clip space (centre origin,
resolution-independent), and `setLayerTransform()` updates it live for animation
or dragging.

```js
import { Transform } from 'tulle'

tulle.composite([
  { source: background },
  { source: clip, transform: Transform.identity().translate(0.5, 0.5).scale(0.4) },
])

tulle.setLayerTransform(1, Transform.identity().scale(0.4).rotate(angle))
```

## Flow layout

Hand-placing transforms doesn't scale past a few layers. `tulle.layout()` takes
a tree of boxes and solves where each one lands, CSS-style — then feeds the
result into the same composite path, one transform per box. The renderer never
learns what "inline" means.

```js
import { box, block, inline } from 'tulle'   // also on 'tulle/ready'

tulle.layout(
  block([
    tulle.clip('film.mp4'),               // a raw source becomes an inline box
    box(title, { blend: 'screen' }),
    block([box(a), box(b)], { gap: 24 }),  // a block breaks the line and stacks
  ], { gap: 24, padding: 40 })
)
```

The model is deliberately CSS-shaped, because that mental model is universal:

- `inline([...])` flows children left-to-right and **wraps**; `block([...])`
  stacks them top-to-bottom. Containers nest freely.
- `box(source, opts)` is a leaf. A bare source is coerced to an inline box.
- Boxes are sized explicitly (`width`/`height` — give one and the other follows
  the source's aspect) or intrinsically from the source, shrunk to fit the
  available width.

Layout is solved in **design-space pixels** (top-left origin, like Text) and
re-solved every frame — so it reacts live to a video's size arriving, a resize,
or an animated option. A [Clip](sources.md#video-clips) that isn't `ready` yet
measures 0×0 and is hidden, then takes its place the moment its dimensions are
known.

Container options: `gap`, `padding`, `width`, `height`, `align`
(`start | center | end`, cross-axis), `justify`
(`start | center | end | between`, main axis), `display` (override
inline/block).

Box options: `width`, `height`, `margin` (number or per-side), `fit`
(`contain` letterboxes — the default; `cover` centre-crops; `fill` stretches),
plus the layer options you already know — `effects`, `blend`, `opacity`.

Two paint-time transforms round it out: `rotate` (radians, counter-clockwise)
and `scale` (a factor, or `[sx, sy]`) apply about the box centre **after**
layout, CSS-transform style — the box keeps its flow slot, only the paint
moves. They're what
[`scaleFrom` / `rotateFrom`](animation.md#tweens-and-scroll-reveals) animate.

Positioning works like CSS too: `position: 'static'` (flow, the default),
`'relative'` (nudge from the flow slot via `offset: { left, top, right,
bottom }`; siblings keep the original space), `'absolute'` (out of flow, pinned
to the nearest positioned ancestor), and `'fixed'` (pinned to the viewport —
it ignores [scroll](#scrolling)).

And because layout options ride the same frame-context contract as effect
params, **any size or offset can be a function of time** — that's animation and
scroll-linked motion with no extra machinery:

```js
box(title, {
  position: 'absolute', width: W, height: 90,
  offset: { top: ctx => 40 + Math.sin(ctx.time * 1.2) * 14 },
  opacity: ctx => 1 - ctx.scrollY / 600,
})
```

## Scrolling

Content bigger than the frame can scroll — the viewport pans over the
composition, not the DOM:

```js
tulle.layout(tree, { scroll: 'y' })   // true → 'y'; also 'x' | 'both'

tulle.scrollTo(0, 1200)               // absolute, clamped to the content
tulle.scrollBy(0, dy)                 // relative — wire it to touch, keys, anything
```

With `scroll` enabled the mouse wheel just works, `position: 'fixed'` boxes
stay pinned (a HUD, a progress bar), and `scrollX` / `scrollY` /
`tulle.scrollMax` let any param be a function of scroll position. The
[scroll example](https://vinesone.github.io/tulle/) is built entirely on this.
