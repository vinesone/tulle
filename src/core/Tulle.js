import { Renderer } from './Renderer.js'
import { registry } from './registry.js'
import { Emitter }  from './Emitter.js'
import { Scope }    from './Scope.js'
import { Pointer }  from './Pointer.js'
import { toMatrix } from './Transform.js'
import { Text }     from './Text.js'
import { Clip }     from './Clip.js'
import { coerceRoot, flattenLeaves, solveLayout, rectToMatrix, fitRect, coverUV, intrinsicSize, aspectOf, HIDDEN } from './Layout.js'
import { record as recordVideo, walkFrames } from './Recorder.js'

/**
 * @typedef {object} FrameContext
 * @property {number} time    seconds since this Tulle instance was created
 * @property {number} delta   seconds since the previous frame (clamped)
 * @property {number} frame   monotonically increasing frame counter
 * @property {import('./Pointer.js').Pointer|null} pointer
 */

/**
 * Tulle — shader effects for developers who don't want to write shaders.
 *
 * @example — one effect, one frame
 *   const tulle = new Tulle(canvas)
 *   tulle.apply('chromatic-aberration', { spread: 0.03 }).render(image)
 *
 * @example — a chain, animated, self-cleaning
 *   tulle.chain(['blur', 'grain']).start(() => tulle.render(video))
 *   // remove the canvas from the DOM and every GPU resource is freed.
 *
 * @example — reacting to the pointer
 *   tulle.on('pointermove', p => tulle.set('blur', { radius: p.u * 20 }))
 */
export class Tulle {
  #canvas
  #renderer
  #scope   = new Scope()
  #emitter = new Emitter()
  #pointer = null

  #mode = 'pipeline' // 'pipeline' (apply/chain) or 'composite'

  #pipeline = []   // [{ name, params }] — descriptors
  #passes   = null // compiled Effect instances; null means stale

  #layerDescriptors = [] // normalised layer descriptors for composite()
  #layers           = null // compiled layers; null means stale

  #postDescriptors = [] // [{ name, params }] — post chain over the composite
  #postPasses      = null // compiled; null means stale

  #layoutTree   = null  // the flow tree, re-solved each frame in composite mode
  #layoutFrame  = null  // { width, height } design-space frame
  #layoutOrder  = null  // flattened leaves, aligned with the composite layers

  #scrollX = 0
  #scrollY = 0
  #scrollMax = { x: 0, y: 0 } // content bounds from the last solve, for clamping
  #scrollMode = null          // null | 'x' | 'y' | 'both'
  #scrollTeardown = null      // removes the wheel listener

  #running   = false
  #raf       = null
  #origin    = 0   // performance.now() at construction
  #last      = 0
  #time      = 0
  #delta     = 0
  #frame     = 0
  #timeOverride = null

  #destroyed     = false
  #autoDestroy
  #everConnected = false

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} [options]
   * @param {boolean} [options.pointer=true] — track pointer, emit pointer events,
   *   and expose u_pointer / u_pointerDown to every shader.
   * @param {boolean} [options.autoDestroy=true] — free everything once the canvas
   *   has been in the DOM and is then removed. Requires a running loop; set false
   *   if you deliberately detach and re-attach the canvas.
   * @param {boolean} [options.alpha=true] — keep the canvas backing store
   *   transparent, so a source with alpha lets the page behind it show through.
   *   Set false for an opaque canvas (a small perf win, no blending with the page).
   */
  constructor(canvas, { pointer = true, autoDestroy = true, alpha = true } = {}) {
    // Tulle's intermediate buffers are premultiplied, so the canvas must be too
    // — otherwise the browser double-applies alpha when compositing the page.
    const gl = canvas.getContext('webgl2', { alpha, premultipliedAlpha: true })
    if (!gl) throw new Error('Tulle: WebGL2 is not supported in this browser.')

    this.#canvas      = canvas
    this.#autoDestroy = autoDestroy
    this.#origin      = performance.now()
    this.#last        = this.#origin

    this.#renderer = new Renderer(gl)
    this.#scope.own(this.#renderer)

    if (pointer)
      this.#pointer = new Pointer(canvas, this.#scope, (type, payload) => this.#emitter.emit(type, payload))

    // A lost context invalidates every handle we hold. Stop, and rebuild on restore.
    this.#scope.listen(canvas, 'webglcontextlost', event => {
      event.preventDefault() // without this the context is never restored
      this.stop()
      this.#emitter.emit('contextlost')
    })
    this.#scope.listen(canvas, 'webglcontextrestored', () => {
      this.#invalidate()       // pipeline programs are dead — force a recompile
      this.#invalidateLayers() // composite programs too
      this.#invalidatePost()   // and the post chain
      this.#renderer.reset()   // textures and framebuffers are dead too
      this.#emitter.emit('contextrestored')
    })
  }

  // ── Registry ──────────────────────────────────────────────────────────────

  /**
   * Register an effect globally.
   * @param {string} name
   * @param {typeof import('./Effect.js').Effect} EffectClass
   */
  static register(name, EffectClass) {
    registry.set(name, EffectClass)
    return Tulle
  }

  /** Names of every registered effect. */
  static get registered() { return [...registry.keys()] }

  /**
   * Create a canvas and a Tulle for it in one call — go from an empty container
   * to running with no HTML. `target` is a CSS selector or an element: a canvas
   * is used as-is, anything else gets a fresh canvas appended to it.
   *
   *   const tulle = Tulle.mount('#app', { width: 640, height: 420 })
   *   tulle.chain(['blur']).play(video)
   *
   * @param {string | Element} target
   * @param {TulleOptions & { width?: number, height?: number }} [options]
   * @returns {Tulle}
   */
  static mount(target, { width, height, ...options } = {}) {
    const el = typeof target === 'string' ? document.querySelector(target) : target
    if (!el) throw new Error(`Tulle.mount: no element matches ${JSON.stringify(target)}.`)

    let canvas
    if (el.tagName === 'CANVAS') {
      canvas = el
    } else {
      canvas = document.createElement('canvas')
      el.appendChild(canvas)
    }
    if (width  != null) canvas.width  = width
    if (height != null) canvas.height = height

    return new Tulle(canvas, options)
  }

  // ── Introspection ─────────────────────────────────────────────────────────

  get canvas()    { return this.#canvas }
  get pointer()   { return this.#pointer }
  get running()   { return this.#running }
  get destroyed() { return this.#destroyed }

  /** Names currently in the pipeline, in order. */
  get pipeline()  { return this.#pipeline.map(step => step.name) }

  /** The sources currently composited, in layer order. Used by offline export to seek clips. */
  get sources()   { return this.#layerDescriptors.map(desc => desc.source) }

  /** @returns {FrameContext} */
  get frame() {
    return {
      time:    this.#timeOverride ?? this.#time,
      delta:   this.#delta,
      frame:   this.#frame,
      pointer: this.#pointer,
      scrollX: this.#scrollX,
      scrollY: this.#scrollY,
    }
  }

  /** Current scroll offset in design px. */
  get scrollX() { return this.#scrollX }
  get scrollY() { return this.#scrollY }
  /** Max scroll on each axis (content size − viewport), from the last solved frame. */
  get scrollMax() { return { ...this.#scrollMax } }

  // ── Events ────────────────────────────────────────────────────────────────

  /**
   * Subscribe. Returns an unsubscribe function.
   *
   * Pointer: `pointermove` `pointerdown` `pointerup` `pointerenter`
   *          `pointerleave` `click` `wheel`
   * Lifecycle: `start` `stop` `frame` `destroy` `contextlost` `contextrestored`
   *
   * @param {string} type
   * @param {Function} handler
   * @returns {() => void}
   */
  on(type, handler) { return this.#emitter.on(type, handler) }

  /** @param {string} type @param {Function} handler @returns {() => void} */
  once(type, handler) { return this.#emitter.once(type, handler) }

  /** @param {string} type @param {Function} [handler] */
  off(type, handler) { this.#emitter.off(type, handler); return this }

  // ── Pipeline ──────────────────────────────────────────────────────────────

  /**
   * Single-effect pipeline.
   * @param {string} name
   * @param {object} [params]
   */
  apply(name, params = {}) {
    this.#mode = 'pipeline'
    this.#pipeline = [{ name, params }]
    this.#invalidate()
    return this
  }

  /**
   * Multi-effect pipeline, applied left to right.
   * Each step is a name, or `{ name, params }`.
   * @param {Array<string|{ name: string, params?: object }>} steps
   */
  chain(steps) {
    this.#mode = 'pipeline'
    this.#pipeline = steps.map(step =>
      typeof step === 'string' ? { name: step, params: {} } : { params: {}, ...step }
    )
    this.#invalidate()
    return this
  }

  /**
   * Composite a stack of layers, each with its own source, effect chain, and
   * blend. Layers combine bottom to top; the first is the base and its blend is
   * ignored. In this mode render() ignores its argument — every layer carries
   * its own source, re-read each frame, so live video composites work.
   *
   *   tulle.composite([
   *     { source: clip,  effects: ['blur'] },
   *     { source: title, blend: 'screen', opacity: 0.8 },
   *   ]).start(() => tulle.render())
   *
   * @param {Array<{
   *   source: ImageSource,
   *   effects?: Array<string|{ name: string, params?: object }>,
   *   blend?: string,
   *   opacity?: number,
   * }>} layers
   */
  composite(layers) {
    this.#mode = 'composite'
    this.#layoutTree = null // a hand-built composite is not a layout
    this.#setScroll(null)   // …and carries no scroll
    this.#layerDescriptors = layers.map(normalizeLayer)
    this.#invalidateLayers()
    return this
  }

  /**
   * Arrange sources with a flow layout. Boxes pack inline (left-to-right, wrapping)
   * until wrapped in a block(), which stacks its children and breaks the line;
   * position them with `relative`/`absolute`. Layout is solved in design-space
   * pixels and re-solved every frame, so it reacts to a Clip's size becoming known
   * and to animated offsets — the renderer only ever sees the resulting transforms.
   *
   *   import { block, box } from 'tulle'
   *   tulle.layout(
   *     block([ tulle.clip('film.mp4'), box(title, { blend: 'screen' }) ], { gap: 24 })
   *   ).play()
   *
   * Builds on composite(): each leaf is a layer, in document (paint) order. Effects,
   * blend, and opacity travel on each box's options. The design frame defaults to
   * the canvas size.
   *
   * When `scroll` is set, content taller/wider than the frame can be scrolled — the
   * viewport pans over it (mouse wheel, or scrollTo/scrollBy), and a `position:
   * 'fixed'` box stays pinned. `scrollY` / `scrollX` are on the frame context too, so
   * a param can be a function of scroll (scroll-linked animation).
   *
   * @param {import('./Layout.js').LayoutNode | Array | *} node — a node, an array
   *   (an inline root), or a bare source.
   * @param {{ width?: number, height?: number, scroll?: boolean | 'x' | 'y' | 'both' }} [options]
   */
  layout(node, { width, height, scroll = false } = {}) {
    this.#layoutFrame = { width: width ?? this.#canvas.width, height: height ?? this.#canvas.height }
    const tree  = coerceRoot(node)
    const order = flattenLeaves(tree)
    // Build the composite once (compiles effects/blends); transforms are updated
    // live each frame by #applyLayout, so no recompile on movement.
    this.composite(order.map(leaf => ({
      source:  leaf.source,
      effects: leaf.effects,
      blend:   leaf.blend,
      // A function opacity animates; seed it with 1 and resolve it each frame.
      opacity: typeof leaf.opacity === 'function' ? 1 : leaf.opacity,
    })))
    this.#layoutTree  = tree
    this.#layoutOrder = order
    this.#setScroll(scroll === true ? 'y' : scroll || null)
    return this
  }

  /**
   * Scroll to an absolute offset in design px (clamped to the content). In a layout
   * with `scroll` enabled.
   * @param {number} [x] @param {number} [y]
   */
  scrollTo(x = this.#scrollX, y = this.#scrollY) {
    this.#scrollX = Math.max(0, Math.min(x, this.#scrollMax.x))
    this.#scrollY = Math.max(0, Math.min(y, this.#scrollMax.y))
    if (!this.#running && this.#layoutTree) this.render()
    return this
  }

  /** Scroll by a delta in design px, clamped. @param {number} dx @param {number} dy */
  scrollBy(dx = 0, dy = 0) { return this.scrollTo(this.#scrollX + dx, this.#scrollY + dy) }

  /**
   * Set the post-processing chain applied to the whole composited frame, after
   * all layers are combined and before it reaches the canvas. Only meaningful in
   * composite mode. Each step is a name or `{ name, params }`, as with chain().
   *
   *   tulle.composite(layers).post(['grade', 'vignette', 'grain'])
   *
   * In composite mode, set() targets this chain.
   * @param {Array<string|{ name: string, params?: object }>} steps
   */
  post(steps) {
    this.#postDescriptors = steps.map(step =>
      typeof step === 'string' ? { name: step, params: {} } : { params: {}, ...step }
    )
    this.#invalidatePost()
    return this
  }

  /**
   * Update params on a live pipeline step. No recompile — safe in a render loop.
   * @param {string} name — must already be in the pipeline
   * @param {object} params
   */
  set(name, params) {
    // In composite mode, set() drives the post chain — the pipeline is unused.
    if (this.#mode === 'composite') {
      const step = this.#postDescriptors.find(s => s.name === name)
      if (!step) throw new Error(
        `Tulle.set: "${name}" is not in the post chain (${this.#postDescriptors.map(s => s.name).join(', ') || 'empty'}). Use setLayer/setLayerEffect for per-layer params.`
      )
      Object.assign(step.params, params)
      this.#postPasses?.find(pass => pass.name === name)?.setParams(params)
      return this
    }

    const step = this.#pipeline.find(s => s.name === name)
    if (!step) throw new Error(
      `Tulle.set: "${name}" is not in the current pipeline (${this.pipeline.join(', ') || 'empty'}).`
    )
    Object.assign(step.params, params)
    this.#passes?.find(pass => pass.name === name)?.setParams(params)
    return this
  }

  /**
   * Update a composited layer's blend params (e.g. opacity). No recompile.
   * @param {number} index — layer position, 0 = base
   * @param {object} params — blend params, e.g. `{ opacity: 0.5 }`
   */
  setLayer(index, params) {
    const desc = this.#layerDescriptors[index]
    if (!desc) throw new Error(
      `Tulle.setLayer: no layer at index ${index} (have ${this.#layerDescriptors.length}).`
    )
    desc.blendParams = { ...desc.blendParams, ...params }
    this.#layers?.[index]?.blend?.setParams(params)
    return this
  }

  /**
   * Update a param on one effect within a composited layer. No recompile.
   * @param {number} index — layer position, 0 = base
   * @param {string} name — an effect in that layer's chain
   * @param {object} params
   */
  setLayerEffect(index, name, params) {
    const desc = this.#layerDescriptors[index]
    if (!desc) throw new Error(
      `Tulle.setLayerEffect: no layer at index ${index} (have ${this.#layerDescriptors.length}).`
    )
    const step = desc.effects.find(s => s.name === name)
    if (!step) throw new Error(
      `Tulle.setLayerEffect: layer ${index} has no effect "${name}".`
    )
    Object.assign(step.params, params)
    this.#layers?.[index]?.passes.find(pass => pass.name === name)?.setParams(params)
    return this
  }

  /**
   * Position a composited layer. No recompile — the renderer reads the transform
   * each frame, so this is safe to call in a loop for animation or dragging.
   * @param {number} index — layer position, 0 = base
   * @param {import('./Transform.js').Transform | Float32Array | number[] | null} transform
   */
  setLayerTransform(index, transform) {
    const desc = this.#layerDescriptors[index]
    if (!desc) throw new Error(
      `Tulle.setLayerTransform: no layer at index ${index} (have ${this.#layerDescriptors.length}).`
    )
    desc.transform = toMatrix(transform)
    if (this.#layers?.[index]) this.#layers[index].transform = desc.transform
    return this
  }

  /**
   * Set a layer's UV crop: `[offsetX, offsetY, scaleX, scaleY]` in 0..1, or null for
   * no crop. The layout engine uses this for `cover` fit; live, no recompile.
   * @param {number} index @param {Float32Array|number[]|null} uvRect
   */
  setLayerUV(index, uvRect) {
    const desc = this.#layerDescriptors[index]
    if (!desc) throw new Error(
      `Tulle.setLayerUV: no layer at index ${index} (have ${this.#layerDescriptors.length}).`
    )
    desc.uvRect = uvRect ? Float32Array.from(uvRect) : null
    if (this.#layers?.[index]) this.#layers[index].uvRect = desc.uvRect
    return this
  }

  /**
   * Create a text source sized to this canvas. Sugar for `new Text(...)` that
   * fills in the frame geometry, so the block lands undistorted when used as a
   * layer. Keep the returned Text to restyle it live with set()/update().
   *
   *   const title = tulle.text('Hello', { size: 72, color: '#ff5470' })
   *   tulle.composite([{ source: video }, { source: title }])
   *
   * @param {string} text
   * @param {Partial<import('./Text.js').TEXT_DEFAULTS>} [options]
   * @returns {Text}
   */
  text(text, options = {}) {
    return new Text(text, {
      width:  this.#canvas.width,
      height: this.#canvas.height,
      ...options,
    })
  }

  /**
   * Create a video Clip source, owned by this Tulle — it is destroyed when the
   * Tulle is (which the loop does automatically when the canvas leaves the DOM).
   * A Clip is a source with a lifecycle: subscribe to load/ready/play/end and set
   * timeline cues with at()/every(). Drop it straight into a layer.
   *
   *   const clip = tulle.clip('film.mp4', { autoplay: true })
   *   clip.on('ready', () => …)
   *   clip.at(2.5, () => …)
   *   tulle.composite([{ source: clip }]).play()
   *
   * Use `new Clip(...)` directly if you want to own its teardown yourself.
   *
   * @param {string | HTMLVideoElement} src
   * @param {import('../../types/index.js').ClipOptions} [options]
   * @returns {Clip}
   */
  clip(src, options = {}) {
    return this.#scope.own(new Clip(src, options))
  }

  // ── Render ────────────────────────────────────────────────────────────────

  /**
   * Run the pipeline once and draw to the canvas.
   * @param {HTMLVideoElement|HTMLImageElement|HTMLCanvasElement|ImageBitmap|ImageData} source
   */
  render(source) {
    this.#assertAlive('render')

    // Keep the clock moving for callers who render outside start().
    if (!this.#running) this.#time = (performance.now() - this.#origin) / 1000

    // Advance any source with a lifecycle (a Clip) once per frame, so its cues fire
    // and its 'time' event ticks. Deduped so a clip used in two layers advances once;
    // duck-typed so plain images/canvases/Text are simply skipped.
    const advanced = new Set()
    const tick = s => { if (s && !advanced.has(s)) { advanced.add(s); s.advance?.(this.frame) } }

    if (this.#mode === 'composite') {
      if (this.#layerDescriptors.length === 0)
        throw new Error('Tulle.render: no layers. Call .composite() first.')
      for (const desc of this.#layerDescriptors) tick(desc.source)
      if (this.#layoutTree) this.#applyLayout() // re-solve flow → per-layer transforms
      if (!this.#layers) this.#compileLayers()
      if (!this.#postPasses) this.#compilePost()
      this.#renderer.composite(this.#layers, this.#postPasses, this.frame)
      return this
    }

    if (this.#pipeline.length === 0)
      throw new Error('Tulle.render: no pipeline. Call .apply() or .chain() first.')

    tick(source)
    if (!this.#passes) this.#compile()
    this.#renderer.run(source, this.#passes, this.frame)
    return this
  }

  /**
   * Render one frame at an exact time, ignoring the wall clock. Deterministic:
   * the same time always yields the same pixels. This is what offline export
   * will be built on.
   *
   * @param {number} time — seconds
   * @param {*} source
   */
  renderAt(time, source) {
    this.#timeOverride = time
    try { return this.render(source) }
    finally { this.#timeOverride = null }
  }

  /**
   * Shorthand: set a single effect and render it.
   * @param {*} source @param {string} name @param {object} [params]
   */
  process(source, name, params = {}) {
    return this.apply(name, params).render(source)
  }

  /**
   * Render the composition to a WebM video, deterministically and offline. Walks
   * the timeline frame by frame — seeking every Clip to each exact time and waiting
   * — so a 30fps export matches a 144Hz preview. Requires WebCodecs. Stops the live
   * loop first; it does not resume it. Duration is inferred from the longest clip if
   * omitted. Meaningful in composite/layout mode, where layers carry their sources.
   *
   *   const blob = await tulle.record({ fps: 30, duration: 6, onProgress: p => bar(p) })
   *   const url = URL.createObjectURL(blob)
   *
   * @param {import('./Recorder.js').RecordOptions} [options]
   * @returns {Promise<Blob>} a video/webm blob
   */
  record(options) {
    this.#assertAlive('record')
    return recordVideo(this, options)
  }

  /**
   * Walk the timeline deterministically, calling `onFrame(canvas, meta)` per frame
   * after seeking sources and rendering. The building block under record() — use it
   * to export a frame sequence, feed a custom encoder, or grab thumbnails.
   *
   *   await tulle.frames({ fps: 12, duration: 4 }, async (canvas, { index }) => {
   *     saveThumbnail(canvas.toDataURL(), index)
   *   })
   *
   * @param {{ fps?: number, duration?: number, from?: number }} options
   * @param {(canvas: HTMLCanvasElement, meta: { index: number, time: number, timestamp: number }) => any} onFrame
   * @returns {Promise<number>} frames walked
   */
  frames(options, onFrame) {
    this.#assertAlive('frames')
    return walkFrames(this, options, onFrame)
  }

  /**
   * Take over the loop and render `source` every frame — the common case, with
   * no closure. `play(video)` re-reads the live element each frame; in composite
   * mode call `play()` with no argument (layers carry their own sources).
   *
   *   tulle.chain(['blur', 'grain']).play(video)
   *   tulle.composite(layers).play()
   *
   * @param {import('./Tulle.js').ImageSource | (() => any)} [source] — a source, or
   *   a function returning one, evaluated each frame.
   * @returns {() => void} stop
   */
  play(source) {
    const pick = typeof source === 'function' ? source : () => source
    return this.start(() => this.render(pick()))
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Take over the render loop. Tulle drives requestAnimationFrame, advances the
   * clock, and — once the canvas has been in the DOM and is then removed —
   * destroys itself. You do not have to call stop() or destroy().
   *
   *   tulle.start(({ time }) => tulle.render(video))
   *
   * @param {(ctx: FrameContext, tulle: Tulle) => void} [onFrame]
   * @returns {() => void} stop
   */
  start(onFrame) {
    this.#assertAlive('start')
    if (this.#running) return () => this.stop()

    this.#running = true
    this.#last    = performance.now()

    const tick = now => {
      if (!this.#running || this.#destroyed) return

      if (this.#autoDestroy && this.#orphaned()) { this.destroy(); return }

      this.#time  = (now - this.#origin) / 1000
      // Clamp: a backgrounded tab produces a multi-second delta that would make
      // anything integrating over dt jump.
      this.#delta = Math.min((now - this.#last) / 1000, 0.25)
      this.#last  = now
      this.#frame++

      const ctx = this.frame
      this.#emitter.emit('frame', ctx)

      try {
        onFrame?.(ctx, this)
      } catch (err) {
        // Don't let a throwing callback spin the loop forever throwing.
        this.stop()
        this.#emitter.emit('error', err)
        throw err
      }

      if (this.#running) this.#raf = requestAnimationFrame(tick)
    }

    this.#raf = requestAnimationFrame(tick)
    this.#emitter.emit('start')

    return () => this.stop()
  }

  /** Pause the loop. Resources stay alive; call start() again to resume. */
  stop() {
    if (!this.#running) return this
    this.#running = false
    if (this.#raf !== null) cancelAnimationFrame(this.#raf)
    this.#raf = null
    this.#emitter.emit('stop')
    return this
  }

  /**
   * Free everything: the loop, the GPU resources, the DOM listeners.
   * Idempotent, and called for you when the canvas leaves the DOM.
   */
  destroy() {
    if (this.#destroyed) return
    this.#destroyed = true

    this.stop()
    this.#emitter.emit('destroy') // fire while listeners are still attached
    this.#invalidate()
    this.#invalidateLayers()
    this.#invalidatePost()
    this.#scope.dispose()         // pointer listeners, context listeners, renderer
    this.#emitter.clear()
    this.#pipeline = []
    this.#layerDescriptors = []
    this.#postDescriptors = []
    this.#layoutTree = null
    this.#layoutOrder = null
    this.#setScroll(null)
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /**
   * True once the canvas has been connected and then removed. A canvas that was
   * never in the DOM (offscreen rendering) is never considered orphaned.
   */
  #orphaned() {
    const canvas = this.#canvas
    if (!('isConnected' in canvas)) return false // OffscreenCanvas
    if (canvas.isConnected) { this.#everConnected = true; return false }
    return this.#everConnected
  }

  #assertAlive(method) {
    if (this.#destroyed)
      throw new Error(`Tulle.${method}: this instance was destroyed.`)
  }

  #invalidate() {
    this.#passes?.forEach(pass => pass.destroy())
    this.#passes = null
  }

  #compile() {
    this.#passes = this.#pipeline.map(({ name, params }) => this.#instantiate(name, params))
  }

  /** Instantiate one registered effect, tagged with its name for set(). */
  #instantiate(name, params) {
    const EffectClass = registry.get(name)
    if (!EffectClass) throw new Error(
      `Tulle: unknown effect "${name}". Register it first: Tulle.register("${name}", YourEffect)`
    )
    const pass = new EffectClass(this.#renderer.gl, params)
    pass.name = name // so set() can reach this pass without a recompile
    return pass
  }

  #invalidateLayers() {
    this.#layers?.forEach(layer => {
      layer.passes.forEach(pass => pass.destroy())
      layer.blend?.destroy()
    })
    this.#layers = null
  }

  #compileLayers() {
    this.#layers = this.#layerDescriptors.map((desc, i) => ({
      source: desc.source,
      passes: desc.effects.map(step => this.#instantiate(step.name, step.params)),
      // The base layer has nothing beneath it, so it carries no blend.
      blend:  i === 0 ? null : this.#instantiate(desc.blend, desc.blendParams),
      // Read fresh each frame by the renderer, so setLayerTransform is live.
      transform: desc.transform,
      uvRect:    desc.uvRect,
    }))
  }

  /**
   * Enable/disable viewport scrolling for the current layout. Adds a non-passive
   * wheel listener (so it can preventDefault the page scroll); removes the previous
   * one. mode is 'x' | 'y' | 'both' | null.
   */
  #setScroll(mode) {
    if (this.#scrollTeardown) { this.#scrollTeardown(); this.#scrollTeardown = null }
    this.#scrollMode = mode
    if (!mode) { this.#scrollX = this.#scrollY = 0; this.#scrollMax = { x: 0, y: 0 }; return }

    const onWheel = event => {
      event.preventDefault() // this canvas owns the wheel now
      const dx = mode === 'x' || mode === 'both' ? event.deltaX : 0
      const dy = mode === 'y' || mode === 'both' ? event.deltaY : 0
      this.scrollBy(dx, dy)
    }
    this.#canvas.addEventListener('wheel', onWheel, { passive: false })
    this.#scrollTeardown = () => this.#canvas.removeEventListener('wheel', onWheel, { passive: false })
  }

  /**
   * Re-solve the flow tree and push a fresh transform to each layer. No recompile.
   * Passes the frame context to the solver, so a box's offset/size/opacity may be a
   * function of time — that is the whole layout-animation feature. Also feeds the
   * scroll offset and reads back the content bounds for clamping.
   */
  #applyLayout() {
    const ctx = this.frame
    const solved = solveLayout(this.#layoutTree, this.#layoutFrame, intrinsicSize, ctx,
      this.#scrollMode ? { x: this.#scrollX, y: this.#scrollY } : undefined)
    const { rects } = solved
    this.#scrollMax = solved.scrollMax
    // Re-clamp the stored scroll to the freshly measured content.
    this.#scrollX = Math.min(this.#scrollX, this.#scrollMax.x)
    this.#scrollY = Math.min(this.#scrollY, this.#scrollMax.y)
    for (let i = 0; i < rects.length; i++) {
      const leaf = this.#layoutOrder[i]
      if (typeof leaf.opacity === 'function') this.setLayer(i, { opacity: leaf.opacity(ctx) })
      const box = rects[i]
      if (!box || !(box.w > 0) || !(box.h > 0)) { this.setLayerTransform(i, HIDDEN); continue }
      const aspect = aspectOf(leaf.source)
      // contain/fill are geometry; cover keeps the full box and crops via UV.
      this.setLayerTransform(i, rectToMatrix(fitRect(box, aspect, leaf.fit), this.#layoutFrame))
      this.setLayerUV(i, leaf.fit === 'cover' ? coverUV(box, aspect) : null)
    }
  }

  #invalidatePost() {
    this.#postPasses?.forEach(pass => pass.destroy())
    this.#postPasses = null
  }

  #compilePost() {
    this.#postPasses = this.#postDescriptors.map(({ name, params }) => this.#instantiate(name, params))
  }
}

/** Normalise a layer descriptor: effects to {name,params}, blend to a name. */
function normalizeLayer(layer) {
  const effects = (layer.effects ?? []).map(step =>
    typeof step === 'string' ? { name: step, params: {} } : { params: {}, ...step }
  )
  return {
    source:      layer.source,
    effects,
    blend:       layer.blend ?? 'over',
    blendParams: { opacity: layer.opacity ?? 1, ...layer.blendParams },
    transform:   toMatrix(layer.transform),
    uvRect:      layer.uvRect ? Float32Array.from(layer.uvRect) : null,
  }
}
