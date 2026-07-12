[← Tulle](../README.md)

# Rendering

Transparency, deterministic frame-exact rendering, and what owns the lifecycle.

## Transparency

The canvas is transparent by default, so a source with alpha lets the page show
through, and every built-in effect preserves it. Pass `{ alpha: false }` for an
opaque canvas.

## Deterministic rendering

`renderAt()` pins the clock, so the same time always produces the same pixels.
This is the basis for frame-exact export:

```js
for (let i = 0; i < frames; i++) tulle.renderAt(i / 30, video)
```

Nothing in the library reads the wall clock — [Clip cues](sources.md#video-clips),
[Draw painters](sources.md#drawing), and every
[animation helper](animation.md) are driven by the render loop, so a live
preview and an offline export produce identical frames. `tulle.record()`
renders a composition straight to a WebM `Blob` (requires WebCodecs); see the
[export example](https://vinesone.github.io/tulle/).

## Lifecycle

`destroy()` exists and is idempotent, but you rarely need it:

- `start(fn)` owns `requestAnimationFrame` and advances the clock.
- The loop destroys the instance once the canvas has been in the DOM and is
  removed. Pass `{ autoDestroy: false }` if you detach and re-attach the canvas.
- A lost WebGL context stops the loop and emits `contextlost`; on
  `contextrestored`, shaders and buffers are rebuilt automatically.
