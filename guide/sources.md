[← Tulle](../README.md)

# Sources

Anything image-like is a source: an image, a canvas, a video, ImageBitmap,
ImageData — plus Tulle's own primitives, each a source with a lifecycle. They
all drop into a chain, a composite layer, or a layout box the same way.

## Video clips

`tulle.clip()` wraps a `<video>` into a **source with a lifecycle**. It drops
into any layer — blur it, blend it, place it with a `Transform` or a layout box
— and replaces the half-dozen quirky native media events with a small, clean
vocabulary:

```js
const clip = tulle.clip('film.mp4', { autoplay: true, loop: true })

clip.on('ready', ({ width, height, duration }) => layout())  // first decodable frame
clip.on('end',   () => showOutro())
clip.at('1:30',  () => showLowerThird())   // one-shot timeline cue
clip.every(5,    t  => pulse())            // every 5 seconds of playback

tulle.composite([{ source: clip }]).play()
```

Pass a URL (Tulle creates and owns the element) or an existing
`HTMLVideoElement` (adopted). Options: `muted` (default `true` — required for
unattended autoplay), `autoplay`, `loop`, `playsInline` (default `true`),
`crossOrigin` (**set `'anonymous'` for cross-origin video**, or the texture
upload taints the canvas and throws), `preload`.

**Transport** — `play()` (returns the browser's play promise), `pause()`,
`seek(t)`, `seekTo(t)` (resolves once the frame at `t` is decoded — what export
needs), `rate(x)`, `volume(v)`, `mute()`, `unmute()`. Times are seconds or
`"mm:ss"` strings (`'1:30'`, `'1:23.5'`). `whenReady()` is readiness as a
promise. Intrinsic `width` / `height` / `aspect` / `duration` are how a clip
tells [layout](compositing.md#flow-layout) how big it is.

**Events** — `load`, `ready`, `play`, `pause`, `time` (per rendered frame, not
`timeupdate`'s ~4 Hz), `end`, `loop` (looping clips never fire native `ended`;
Tulle detects the wrap), `waiting`, `error`, `unload`. `load` and `ready` are
**latched**: subscribe after they happened and the handler still fires, so
`clip.on('ready', …)` works even for a cached video.

**Cues** — `at(time, fn)` fires once when playback crosses `time`; `every(n,
fn)` fires each interval. Both return an unsubscribe function, like `on()`.
Cues are driven by the render loop against the *film's* position, not the wall
clock — a seek or a scrub re-arms them instead of dumping a burst of callbacks,
and they fire identically in a live preview and a deterministic `renderAt()`
export.

`tulle.clip()` ties the clip's teardown to the Tulle instance; `new Clip(...)`
(exported from `tulle`) is the standalone form you dispose yourself.

## Text

Type is a layer source. `Text` typesets a styled block into a frame-sized canvas,
so it composites, blends, takes effects, and moves with a `Transform` like any
other layer — the core never learns what a glyph is.

```js
const title = tulle.text('Hello', { size: 96, weight: 700, color: '#ff5470' })

tulle.composite([
  { source: video },
  { source: title, blend: 'over', effects: ['blur'] },
])

title.set('Goodbye')                 // re-typeset; next frame shows it
title.update({ color: '#ffffff' })   // restyle live
```

`tulle.text(str, options)` sizes the block to the canvas so it lands undistorted;
`new Text(str, { width, height, ... })` is the standalone form. Options: `font`,
`size`, `weight`, `italic`, `color`, `lineHeight`, `letterSpacing`, `align`,
`vAlign`, `padding`, `maxWidth` (wraps), `background`, `shadow`, `stroke`. Text is
re-rasterised only when it changes, and it's DPR-aware for crisp glyphs.

## Drawing

Canvas 2D is already a complete drawing API, and any canvas is already a source
— so Tulle doesn't invent shapes. What it adds is the lifecycle: `tulle.draw()`
makes a surface your callback repaints **once per rendered frame**, driven by
the render loop (never its own clock), so it animates live and renders
identically under a deterministic export:

```js
const scene = tulle.draw((ctx, { time, width, height }) => {
  ctx.clearRect(0, 0, width, height)
  ctx.beginPath()
  ctx.arc(width / 2, height / 2, 80 + Math.sin(time * 2) * 30, 0, 7)
  ctx.fill()
})

tulle.layout(block([scene, title]))
```

The callback gets the 2D context and the frame context (plus the surface's
`width`/`height`). `scene.set(fn)` swaps the painter live; `new Draw(fn, {
width, height })` is the standalone form.

For the everyday backdrop there's `gradient()` — a linear-gradient canvas that
**dithers itself**, because plain canvas gradients band visibly on dark scenes
at 8 bits per channel:

```js
const sky = tulle.gradient([[0, '#0b1026'], [1, '#05060f']], { angle: 115 })
box(sky, { fit: 'cover' })

tulle.gradient(['#ff5470', '#8367c7', '#4cc9f0'])   // bare colors spread evenly
```

`angle` is in degrees — 0 sweeps left→right, 90 (the default) top→bottom. The
standalone form takes explicit `{ width, height }`.
