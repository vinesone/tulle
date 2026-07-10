# Tulle

Shader effects for developers who don't want to write shaders.

Tulle runs a chain of WebGL2 post-processing effects over an image, a canvas, or
a video — and cleans up after itself. No build step, no dependencies, no
`gl.` calls in your code.

```bash
npm install tulle
```

## Quick start

```js
import { Tulle } from 'tulle'
import { registerBuiltins } from 'tulle/effects'

registerBuiltins(Tulle)

const tulle = new Tulle(canvas)

tulle.chain(['blur', 'grain'])
     .start(() => tulle.render(video))
```

That's the whole lifecycle. `start()` owns the render loop; when the canvas
leaves the DOM, every shader program, texture, framebuffer, and event listener is
released. You never call `destroy()`.

## Effects

| Name | Params |
|---|---|
| `blur` | `radius` (px) |
| `grain` | `amount`, `size`, `speed`, `colored` |
| `chromatic-aberration` | `spread` |
| `vignette` | `amount`, `radius`, `softness` |
| `grade` | `exposure`, `contrast`, `saturation` |
| `invert` | `amount` |

Change a param without recompiling — safe every frame:

```js
tulle.set('blur', { radius: 12 })
```

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
.start(() => tulle.render())   // each layer carries its own source
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

```bash
npm run dev     # http://localhost:8080/examples/
```

- **basic** — the three built-in effects, toggled and tuned live.
- **video** — a video element as the source, driven by `start()`.
- **pointer** — the same pointer state read from a shader and from JavaScript.
- **custom effect** — vignette and pixelate, defined in the page.
- **composite** — two layers, a blend mode, and a full-render post chain.
- **transparency** — alpha through the pipeline, over a checkerboard.
- **layout** — placed, animated picture-in-picture layers via `Transform`.

## License

MIT
