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

## Gaussian splats

`tulle.splat()` renders a **3D Gaussian Splatting** scene — a `.ply` from 3DGS
training (INRIA's reference code, Postshot, Polycam, Luma, …) or a compact
`.splat` — as a source. Like everything else on this page it is just a source:
it blends, takes effects and post chains, and sits in a layout box.

```js
const scene = tulle.splat('garden.ply')
scene.on('progress', ({ loaded, total }) => bar(loaded / total))
scene.on('ready', ({ count, bounds }) => console.log(count, 'splats'))

tulle.composite([{ source: scene }]).post(['grade', 'grain']).play()
```

`src` is a URL, the file's bytes (`ArrayBuffer`, a `File` from an
`<input type=file>`), or **SplatData** you build yourself — typed arrays of
`positions` (plus optional `colors`, `scales`, `rotations`), so you can generate
a scene in code. `scene.load(src)` swaps scenes in place.

**The camera** is `{ position, target, up, fov }` — or a function of the frame
returning one, for a move that renders identically under export. Omit it and
`fit()` frames the scene from its bounds when it loads. Captured scenes come out
of COLMAP **y-down**, so `fit()` uses `up: [0, -1, 0]`; a viewpoint close to the
capture's own cameras always looks best, since splats are only trained to look
right from where they were photographed. `scene.look({ position })` nudges the
current camera.

### From a photo

A single image becomes a splat scene with `imageToSplat()`: depth is estimated
in the browser (Depth Anything V2 via transformers.js, fetched from a CDN the
first time — a one-off 27 MB, then cached — and run in a Web Worker so the page
keeps rendering), and each pixel is lifted onto its camera ray as a gaussian.

```js
const { data, camera } = await imageToSplat(file, {
  onProgress: ({ stage, loaded, total }) => …,   // 'model' download, 'depth', 'build'
})
scene.camera = camera      // the photo's own framing, median depth on the glass
await scene.load(data)
scene.track(head)          // and now lean around it

const bytes = encodeSplat(data)   // a .splat file, loadable by other viewers too
```

It's a 2.5D "3D photo": convincing for the kind of movement a head makes, with
what the camera never saw filled in by a coarse background plate rather than
left as holes. `far` (default 3) sets how deep the scene feels; `fov` (default
50) is the field of view the photo is assumed to have; `maxSize` (default 640)
the resolution, one splat per pixel. Bring your own depth — a phone's depth map,
another model — with `depth: { data, width, height }` (disparity, larger =
nearer), or skip it with `depth: 'flat'`. To self-host the model, set
`model: { env: { remoteHost, … } }` (see `DEPTH_DEFAULTS`).

Only the base colour of each splat is used; view-dependent colour (higher-order
spherical harmonics) is dropped, which costs a little sheen on shiny surfaces.

## Head tracking

`tulle.head()` tracks where the viewer's eyes are, and a Splat that tracks it
renders through a **window camera**: the plane through the camera's `target` is
pinned to the edges of the screen and only your eye moves. Lean right and
things behind that plane follow you while things in front of it slide the other
way — the screen reads as a pane of glass with the scene behind it, not a view
swinging around.

```js
const head = tulle.head()      // webcam, falling back to the pointer
await head.start()             // the camera permission prompt appears here
scene.track(head)

scene.parallax = 1.5           // exaggerate (0 freezes the view)
head.recenter()                // "where I'm sitting now is straight on"
```

**Sources.** `'webcam'` (default) finds your eyes with MediaPipe's
FaceLandmarker, fetched from a CDN the first time you call `start()` — Tulle
itself has no dependencies, and nothing is downloaded unless you ask for the
webcam. Distance comes from the spacing of your eyes, so there's no calibration
step. If the camera is denied or missing it falls back to `'pointer'` and emits
`fallback`; pass `{ fallback: null }` to get a rejection instead. `'pointer'`
uses the mouse as your head — handy in development. `'manual'` samples nothing:
feed it poses with `head.update({ x, y, z })` (mm from the camera) from WebXR, a
different tracker, or a recorded path.

**Output.** `head.offset` is the eye's offset from neutral in screen
half-heights (`x` right, `y` up, `z` away from the screen) — exactly what
`windowCamera()` takes, so anything with an `offset` works with `track()`.
`head.pose` is the smoothed raw position in mm. Raw samples pass through a One
Euro filter (`smoothing: { minCutoff, beta }`): steady when you hold still,
no lag when you move. Neutral is fixed once tracking settles; when the face is
lost the view eases back to it.

**Tuning.** `screenHeight` (mm, default 190 — a laptop) sets how far a
"half-screen" of head movement is; `cameraFov` (default 60°) and `ipd`
(default 63 mm) refine the distance estimate. Events: `start`, `pose`, `found`,
`lost`, `fallback`, `error`, `stop`. `head.video` is the camera feed, for a
preview. The webcam needs a secure context — `https://` or `localhost`.

Head tracking is live input, like the pointer: it never drives a
[deterministic export](rendering.md#deterministic-rendering). A Splat itself is
export-safe — `record()` sorts each frame exactly — so for a head-coupled move
in a video, record the poses and replay them through a `'manual'` tracker.
