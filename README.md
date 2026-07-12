# Tulle

A WebGL2 effects and compositing library — a modern API for shader effects over
video, canvas, and images, with no shaders to write. Open for extension with
your own.

**[Live examples →](https://vinesone.github.io/tulle/)**

No build step, no dependencies, no `gl.` calls in your code — and everything
cleans up after itself.

```bash
npm install tulle
```

## Quick start

```js
import { Tulle } from 'tulle/ready'   // batteries in: all effects pre-registered

Tulle.mount('#app', { width: 1280, height: 720 })
     .chain(['blur', 'grain'])
     .play(video)
```

That's the whole lifecycle. `mount()` creates the canvas, `play()` owns the
render loop, and when the canvas leaves the DOM every shader program, texture,
framebuffer, and event listener is released. You never call `destroy()`.
(Prefer to register only the effects you use and drive the loop yourself? See
[the lean path](guide/effects.md#registering-only-what-you-use).)

## Guide

- **[Effects](guide/effects.md)** — the built-in catalog, live params, the
  pointer, and writing your own effect from a fragment shader.
- **[Colour grading & LUTs](guide/color-grading.md)** — grade through 3D LUTs,
  including `.cube` files exported from **Premiere Pro / DaVinci Resolve**.
- **[Animation](guide/animation.md)** — params as functions of time, entrance
  tweens (`fadeIn`, `slideFrom`, …), keyframe tracks, scroll reveals.
- **[Compositing](guide/compositing.md)** — layers with blend modes,
  transforms, CSS-like flow layout, and scrolling compositions.
- **[Sources](guide/sources.md)** — video clips with lifecycle events and
  timeline cues, typeset text, canvas drawing, dithered gradients.
- **[Rendering](guide/rendering.md)** — transparency, deterministic
  frame-exact rendering and WebM export, lifecycle.

## The effects

`grade` · `invert` · `lut` · `duotone` · `blur` · `sharpen` · `grain` ·
`vignette` · `chromatic-aberration` · `scanlines` · `vhs` · `pixelate` ·
`ripple` · `shatter` · `shockwave` · `posterize` · `threshold` · `edge-detect`
— plus the `over` / `add` / `screen` blends. Params and families in the
[catalog](guide/effects.md); every param updates live, no recompile:

```js
tulle.set('blur', { radius: 12 })                                  // a value
tulle.set('blur', { radius: ({ time }) => 12 + 8 * Math.sin(time) }) // or a function of time
```

## Examples

Live at **[vinesone.github.io/tulle](https://vinesone.github.io/tulle/)**, or run
them locally:

```bash
npm run dev     # http://localhost:8080/examples/
```

- **the web is video** — the fullscreen showcase: one `tulle.layout()` scroll
  composition, real footage via `tulle.clip()`, kinetic type, scroll-linked
  post effects.
- **playground** — build an effect chain live: swap effects with dropdowns,
  reorder, tune sliders, switch source (pattern / text / video), load presets.
- **layout** — the flow engine: boxes pack inline and wrap, blocks stack,
  relative/absolute/fixed positioning, animated offsets.
- **scroll** — a scrolling composition: content pans with the wheel, fixed
  boxes stay pinned, params as functions of `scrollY`.
- **VHS** — a generated Outrun scene + OSD, composited and run through a layered
  analog chain with the `vhs` effect. Whack the VCR.
- **explode** — click to melt and explode the text, click again to reassemble.
- **export** — deterministic frame-exact rendering out to a WebM file.
- **custom effect** — write your own: a fragment shader plus a defaults object.

## License

MIT
