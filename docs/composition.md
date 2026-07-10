# Composition, Layout, and Animation

**Status:** design proposal. Nothing here is implemented.
**Audience:** whoever builds the next layer of Tulle — probably you, in a month, having forgotten why.

---

## The problem

Tulle today is a **pipeline**: one source, a linear chain of effects, one canvas.

```
source ──► blur ──► grain ──► aberration ──► canvas
```

A video editor is not a pipeline. It is a **tree evaluated over time**:

```
                    ┌─ title card ──► fade(t) ─┐
composite ◄─ over ──┤                          ├──► grade ──► canvas
                    └─ clip A ──► blur ────────┘
```

Three capabilities are missing, and they are separable. Build them in this order, because each one is useless without the previous:

1. **Composition** — more than one input, combined by a blend.
2. **Layout** — *where* each input lands in the frame.
3. **Time** — parameters that are functions of `t`, not constants.

The rest of this document proposes each, and — more importantly — argues about what *not* to do.

---

## Part 1: Composition

### The constraint that shapes everything

Today `Renderer.run()` ping-pongs between exactly two framebuffers. Pass `i` writes `fbo[i % 2]` and reads what pass `i-1` wrote. This is optimal for a **chain** and useless for a **tree**, because a tree node needs *two* inputs alive at once, and a ping-pong pair has no spare slot to hold a sibling's result while you evaluate the other branch.

This is the single most important fact in this document. Everything below follows from it.

### Proposal: a node graph with a pooled framebuffer allocator

Replace the ping-pong pair with a **pool**. Evaluate the tree depth-first; each node acquires a framebuffer, writes into it, and releases it once every consumer has read it. The pool reuses released buffers, so peak memory tracks the *widest* point of the tree, not its node count.

```js
const composition = tulle.composite([
  { source: clipA, effects: ['blur'] },
  { source: title, effects: [], blend: 'over', opacity: 0.8 },
])
```

Evaluation:

```
acquire(fboA)  eval clipA -> blur      -> fboA
acquire(fboB)  eval title              -> fboB
acquire(fboC)  blend(over, fboA, fboB) -> fboC
release(fboA); release(fboB)
present(fboC)
```

Peak: three buffers. A ping-pong pair could never have held `fboA` and `fboB` simultaneously.

### Refcounting is the whole trick

A node's buffer may be read by more than one consumer (a blurred clip used both as a background and as a glow source). Release on *last* read, not first:

```js
class FramebufferPool {
  acquire(w, h) { /* reuse a free buffer of matching size, else allocate */ }
  retain(buf)   { buf.refs++ }
  release(buf)  { if (--buf.refs === 0) this.#free.push(buf) }
}
```

Get this wrong in the direction of releasing too early and you get a node reading a buffer another node has already overwritten — which renders *plausibly*, with subtly wrong pixels, on some GPUs and not others. That is the worst class of bug this project can have. **Assert `refs > 0` on every read, in development.**

### Blend modes belong in a shader, not in `gl.blendFunc`

Tempting: `gl.enable(gl.BLEND)` and let fixed-function hardware do `over`. Don't.

- Fixed-function blending cannot express `multiply`, `screen`, `overlay`, or any of the separable Porter-Duff modes an editor needs.
- It forces you to reason about whether your textures are premultiplied at every hop.
- It couples compositing to draw order, which a tree does not have.

Instead, a `Blend` is an `Effect` with two source uniforms:

```glsl
uniform sampler2D u_source;   // the layer below
uniform sampler2D u_layer;    // the layer above
uniform float     u_opacity;
```

This is a real change to `Effect`: `draw()` currently binds exactly one texture. It needs to bind *n*. Generalize the signature to accept an array of input textures, with `u_source` remaining an alias for input 0 so every existing effect keeps working.

### Premultiplied alpha, decided once

Compositing `over` with straight (non-premultiplied) alpha requires a divide, and the divide is undefined where `alpha == 0`. Every renderer that fudges this ends up with dark halos around anti-aliased edges.

**Decide now: all intermediate framebuffers hold premultiplied alpha.** Convert on the way in, convert on the way out.

```glsl
// over, premultiplied. no divide, no halo.
fragColor = layer + source * (1.0 - layer.a);
```

The cost is one multiply on upload and one divide at present time. The benefit is that every blend mode becomes a one-liner and edge artifacts stop being a category of bug. Note that `Renderer.#upload` already sets `UNPACK_FLIP_Y_WEBGL`; add `UNPACK_PREMULTIPLY_ALPHA_WEBGL` in the same place.

---

## Part 2: Layout

### Do not invent a layout engine

The instinct is to give every layer `{ x, y, width, height, rotation }`. Resist for one release. Those five numbers are a 2D affine transform wearing a costume, and they will grow anchor points, then skew, then aspect-fit modes, then a parent-child hierarchy, and now you have written a scene graph.

Ship a `mat3` per layer, and give it a builder:

```js
{ source: title, transform: Transform.translate(0.1, 0.2).scale(0.5).rotate(0.1) }
```

Everything an editor's inspector panel needs is a function that produces a `mat3`. The renderer stays a renderer.

### It costs one uniform and one line of vertex shader

The fullscreen quad in `Effect.js` bakes its vertices into a constant array indexed by `gl_VertexID`. A layer's quad is that same quad, transformed:

```glsl
uniform mat3 u_transform;   // identity for a fullscreen pass

void main() {
  vec3 p = u_transform * vec3(POSITIONS[gl_VertexID], 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
  vUv = UVS[gl_VertexID];
}
```

`FULLSCREEN_VERT` is already exported for exactly this kind of reuse. Effects that don't set `u_transform` get identity and behave as they do today, so this is a non-breaking change.

### Resolution independence is a trap you can avoid cheaply

A 4K export must produce the same *composition* as a 720p preview, not the same pixel offsets. Layer transforms must therefore be in **normalized space** (`0..1`), never pixels. The one place pixels are legitimate is a shader that needs `u_resolution` to compute a texel — `Blur` already does this correctly, which is why `radius: 6` means "6 pixels" at any canvas size.

This implies a real decision about `Blur`: at 4K, a 6-pixel blur is visually *narrower* than a 6-pixel blur at 720p. Either blur radius becomes normalized too, or an editor must scale it by resolution on export. **Normalize it.** Pixel-denominated parameters do not survive contact with an export pipeline.

---

## Part 3: Animation

### The insight: `renderAt()` already exists

`Tulle.renderAt(time, source)` pins the clock, renders one frame, and restores it. It is three lines, and it is the entire foundation of offline export, because it makes rendering a **pure function of time**:

```js
for (let frame = 0; frame < totalFrames; frame++) {
  tulle.renderAt(frame / fps, source)
  encoder.encode(new VideoFrame(canvas, { timestamp: frame * 1e6 / fps }))
}
```

Nothing else in the library is allowed to read the wall clock. `Grain` reads `u_time`, which is supplied from the frame context, which `renderAt` controls. Keep it that way. **The moment one effect calls `performance.now()` directly, deterministic export dies**, and it dies silently — the preview looks right and the export shimmers.

### Animated parameters are just functions of time

Do not build a keyframe system in the renderer. Build the smallest thing that a keyframe system can be *built on*: a parameter may be a number, or a function of the frame context.

```js
tulle.chain([
  { name: 'blur',  params: { radius: t => 20 * Math.sin(t) } },
  { name: 'grain', params: { amount: 0.05 } },
])
```

`Tulle.set()` already pushes params to a live pass without recompiling. Extend `#pushUniforms` to call any param that is a function, passing the frame context. That is the whole feature, in about six lines.

Then a keyframe track is a userland function, and so is an easing curve, and so is a spring:

```js
const track = keyframes([{ t: 0, v: 0 }, { t: 1.5, v: 20, ease: 'outCubic' }])
tulle.set('blur', { radius: track })
```

Nothing in the core knows what a keyframe is. This is the correct amount of knowledge for it to have.

### Time is not the frame counter

An export at 30fps and a preview at 144Hz must agree. Therefore:

- Effects read `u_time` (seconds). ✅ Already true.
- Effects must never read `u_delta` to *integrate* state, because delta differs between preview and export. `Grain` correctly derives its noise from `u_time` alone, so it is reproducible.
- Any future effect with feedback (motion trails, temporal AA) breaks this rule by nature. Such effects need an explicit `seed`/`history` input, and an export path that walks frames in order. Flag them as `static temporal = true` and refuse to `renderAt()` them out of order rather than producing a wrong frame quietly.

---

## What this means for the current code

| Area | Change | Breaking? |
|---|---|---|
| `Renderer` | Ping-pong pair → refcounted framebuffer pool | Internal only |
| `Effect.draw()` | One input texture → array of inputs; `u_source` aliases input 0 | No |
| `Effect` vertex | Add `u_transform` (`mat3`), defaulting to identity | No |
| `Renderer.#upload` | Add `UNPACK_PREMULTIPLY_ALPHA_WEBGL` | Yes — changes output where alpha < 1 |
| Params | Allow `value \| (ctx) => value` | No |
| `Blur.radius` | Pixels → normalized | Yes |
| `Tulle` | Add `composite(layers)` alongside `chain(effects)` | No |

`chain()` becomes sugar for a degenerate composition: one layer, no blends. Keep it. It is the API that makes the simple case simple, and the simple case is most of them.

---

## Order of work

1. **Framebuffer pool + refcounting.** Invisible to users, unblocks everything. Ship `chain()` on top of it unchanged and verify pixel-identical output against the current ping-pong implementation — that regression test is the entire point.
2. **Multi-input `Effect.draw()`.** Then one blend mode (`over`), premultiplied. Two layers on screen.
3. **`u_transform`.** Layers land somewhere other than fullscreen.
4. **Function params.** Animation, in six lines, with no keyframe system.
5. **Offline export via `renderAt()`.** WebCodecs `VideoEncoder`, deterministic.

Step 1 has no user-visible payoff and will be tempting to skip. It is also the only step that gets structurally harder the longer you wait, because every effect written against the two-texture assumption is a migration.

---

## Open questions

- **Color space.** Everything is currently 8-bit sRGB in an `RGBA8` texture, and blending in sRGB is wrong (mid-grays go muddy). Correct is linear-light float intermediates (`RGBA16F`). This is a bigger, more valuable change than any effect. It also doubles memory. Not urgent for a shader toy; non-negotiable for an editor.
- **Video frame timing.** `HTMLVideoElement` decodes on its own schedule; `renderAt(t)` cannot make it seek synchronously. Offline export from video needs `requestVideoFrameCallback` or `WebCodecs.VideoDecoder`, not an `<video>` element.
- **Where does audio live?** Probably not in Tulle. But a timeline that cannot cut on a beat is not a video editor, and that means the *timeline* is a layer above Tulle, not inside it.
