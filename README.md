# Tulle

Web Library (GL) - That provides a modern api to use Effect Shaders, without the need to write shaders.
All while being open for extension with custom shaders. 

**[Live examples →](https://vinesone.github.io/tulle/)**

Tulle runs a chain of WebGL2 post-processing effects over an image, a canvas, or
a video — and cleans up after itself. No build step, no dependencies, no
`gl.` calls in your code.

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

Prefer the lean path? Import from `tulle`, register only what you use, and drive
the loop yourself:

```js
import { Tulle } from 'tulle'
import { Blur } from 'tulle/effects/focus/Blur'

Tulle.register('blur', Blur)
const tulle = new Tulle(document.querySelector('canvas'))
tulle.chain(['blur']).start(() => tulle.render(video))
```

## Effects

Effects are grouped by family under `src/effects/` — `color/`, `focus/`,
`film/`, `distort/`, `stylize/`, `blend/`.

| Family | Name | Params |
|---|---|---|
| color | `grade` | `exposure`, `contrast`, `saturation` |
| color | `invert` | `amount` |
| color | `lut` | `lut` (texture), `size`, `amount` |
| color | `duotone` | `dark`, `light`, `amount` |
| focus | `blur` | `radius` (px) |
| focus | `sharpen` | `amount`, `thickness` |
| film | `grain` | `amount`, `size`, `speed`, `colored` |
| film | `vignette` | `amount`, `radius`, `softness` |
| film | `chromatic-aberration` | `spread` |
| film | `scanlines` | `count`, `intensity`, `speed` |
| film | `vhs` | `tracking`, `bleed`, `noise`, `roll`, `wobble`, `desaturate` |
| distort | `pixelate` | `size` (px) |
| distort | `ripple` | `center`, `amplitude`, `frequency`, `speed`, `decay` |
| distort | `shatter` | `progress`, `hover`, `cells`, `blast`, `drip` |
| distort | `shockwave` | `speed`, `amplitude`, `width`, `decay`, `blasts` |
| stylize | `posterize` | `levels` |
| stylize | `threshold` | `level`, `softness`, `low`, `high` |
| stylize | `edge-detect` | `amount`, `thickness`, `color`, `background` |
| blend | `over` `add` `screen` | `opacity` |

Change a param without recompiling — safe every frame:

```js
tulle.set('blur', { radius: 12 })
```

### Animated params

Any param can be a **function of the frame context** instead of a value. It's
re-evaluated every frame, so animation needs no keyframe system in the core — a
track, an easing curve, or a spring is just a function you write:

```js
tulle.chain([
  { name: 'blur', params: { radius: ({ time }) => 12 + 8 * Math.sin(time * 2) } },
])

// reach for the pointer, the frame counter, delta — whatever the context carries
tulle.set('ripple', { center: ({ pointer }) => [pointer.u, pointer.v] })
```

The context is `{ time, delta, frame, pointer, width, height }`.

## Reacting to the pointer

Pointer state is tracked for you and reaches your shaders as uniforms, with no
wiring:

```glsl
uniform vec2  u_pointer;      // 0..1, bottom-left origin, matches vUv
uniform bool  u_pointerDown;
```

Or from JavaScript. `on()` returns its own unsubscribe function:

```js
const off = tulle.on('pointermove', p => tulle.set('blur', { radius: p.u * 20 }))
```

Events: `pointermove` `pointerdown` `pointerup` `pointerenter` `pointerleave`
`click` `wheel` `frame` `start` `stop` `destroy` `contextlost` `contextrestored`

## Writing an effect

Declare uniform types. Tulle binds them; you never touch WebGL.

```js
import { Effect, Tulle } from 'tulle'

class Vignette extends Effect {
  static fragSrc = `#version 300 es
    precision highp float;
    in vec2 vUv;
    uniform sampler2D u_source;
    uniform float amount;
    out vec4 fragColor;

    void main() {
      float d = distance(vUv, vec2(0.5));
      fragColor = texture(u_source, vUv) * (1.0 - d * amount);
    }
  `
  static defaults = { amount: 1.0 }
  static uniforms = { amount: 'float' }
}

Tulle.register('vignette', Vignette)
```

Every shader can read these, bound automatically if you declare them:

| Uniform | Type | Meaning |
|---|---|---|
| `u_source` | `sampler2D` | previous pass, or the input |
| `u_resolution` | `vec2` | output size in pixels |
| `u_time` | `float` | seconds since the instance began |
| `u_delta` | `float` | seconds since the last frame |
| `u_pointer` | `vec2` | pointer, `0..1`, bottom-left origin |
| `u_pointerDown` | `bool` | any button held |

Omit `static uniforms` and Tulle infers the type from the default value.

## Compositing layers

Beyond a single source, `composite()` stacks layers — each with its own source,
effect chain, and blend mode — then `post()` runs a chain over the whole frame.

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

## Colour lookup tables

The `lut` effect grades through a 3D LUT. An effect can declare a `'sampler2D'`
param and Tulle uploads any image-like value into its own texture unit — LUTs,
masks, displacement maps. `makeLut()` builds one from a colour function:

```js
import { makeLut } from 'tulle/effects'

const warm = makeLut(32, (r, g, b) => [r * 1.15 + 0.04, g, b * 0.85])
tulle.chain([{ name: 'lut', params: { lut: warm } }])
```

### Loading a `.cube` (Premiere Pro / DaVinci Resolve)

Grades exported as `.cube` 3D LUTs from Premiere or Resolve load directly.
`lutFromCube()` parses the text and packs it into a LUT canvas; pass its
`cubeSize` to the effect (LUTs are commonly 33³):

```js
import { lutFromCube } from 'tulle/effects'

const text  = await fetch('teal-orange.cube').then(r => r.text())
const grade = lutFromCube(text)      // or from a file input: await file.text()

tulle.chain([{ name: 'lut', params: { lut: grade, size: grade.cubeSize } }])
```

`parseCube(text)` is also exported if you want the raw `{ size, data }`. The
playground has a drop-in `.cube` loader.

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

## Lifecycle

`destroy()` exists and is idempotent, but you rarely need it:

- `start(fn)` owns `requestAnimationFrame` and advances the clock.
- The loop destroys the instance once the canvas has been in the DOM and is
  removed. Pass `{ autoDestroy: false }` if you detach and re-attach the canvas.
- A lost WebGL context stops the loop and emits `contextlost`; on
  `contextrestored`, shaders and buffers are rebuilt automatically.

## Examples

Live at **[vinesone.github.io/tulle](https://vinesone.github.io/tulle/)**, or run
them locally:

```bash
npm run dev     # http://localhost:8080/examples/
```

- **playground** — build an effect chain live: swap effects with dropdowns,
  reorder, tune sliders, switch source (pattern / text / video), load presets.
- **VHS** — a generated Outrun scene + OSD, composited and run through a layered
  analog chain with the `vhs` effect. Whack the VCR.
- **explode** — click to melt and explode the text, click again to reassemble.
- **custom effect** — write your own: a fragment shader plus a defaults object.

## License

MIT
