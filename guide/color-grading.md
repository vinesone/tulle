[← Tulle](../README.md)

# Colour grading & LUTs

The `lut` effect grades through a 3D LUT — including grades exported straight
from **Premiere Pro or DaVinci Resolve** as `.cube` files.

## Colour lookup tables

An effect can declare a `'sampler2D'` param and Tulle uploads any image-like
value into its own texture unit — LUTs, masks, displacement maps. `makeLut()`
builds one from a colour function:

```js
import { makeLut } from 'tulle/effects'

const warm = makeLut(32, (r, g, b) => [r * 1.15 + 0.04, g, b * 0.85])
tulle.chain([{ name: 'lut', params: { lut: warm } }])
```

## Loading a `.cube` (Premiere Pro / DaVinci Resolve)

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
[playground](https://vinesone.github.io/tulle/) has a drop-in `.cube` loader.
