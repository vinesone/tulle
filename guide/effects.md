[← Tulle](../README.md)

# Effects

Tulle runs a chain of WebGL2 post-processing effects over any source. This page
is the built-in catalog, how to drive params, and how to write your own effect.
For grading through LUTs, see [Colour grading](color-grading.md); for animating
params, see [Animation](animation.md).

## The built-ins

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

Any param can also be a **function of the frame context**, re-evaluated every
frame — that's the whole animation system. See
[Animation](animation.md#animated-params).

## Registering only what you use

`tulle/ready` pre-registers everything. The lean path imports from `tulle`,
registers per effect, and drives the loop itself:

```js
import { Tulle } from 'tulle'
import { Blur } from 'tulle/effects/focus/Blur'

Tulle.register('blur', Blur)
const tulle = new Tulle(document.querySelector('canvas'))
tulle.chain(['blur']).start(() => tulle.render(video))
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
