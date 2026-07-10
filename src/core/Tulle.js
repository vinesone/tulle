import { Renderer } from './Renderer.js'
import { registry } from './registry.js'
import { Emitter }  from './Emitter.js'
import { Scope }    from './Scope.js'
import { Pointer }  from './Pointer.js'

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

  #pipeline = []   // [{ name, params }] — descriptors
  #passes   = null // compiled Effect instances; null means stale

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
   */
  constructor(canvas, { pointer = true, autoDestroy = true } = {}) {
    const gl = canvas.getContext('webgl2')
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
      this.#invalidate()      // programs are dead — force a recompile
      this.#renderer.reset()  // textures and framebuffers are dead too
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

  // ── Introspection ─────────────────────────────────────────────────────────

  get canvas()    { return this.#canvas }
  get pointer()   { return this.#pointer }
  get running()   { return this.#running }
  get destroyed() { return this.#destroyed }

  /** Names currently in the pipeline, in order. */
  get pipeline()  { return this.#pipeline.map(step => step.name) }

  /** @returns {FrameContext} */
  get frame() {
    return {
      time:    this.#timeOverride ?? this.#time,
      delta:   this.#delta,
      frame:   this.#frame,
      pointer: this.#pointer,
    }
  }

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
    this.#pipeline = steps.map(step =>
      typeof step === 'string' ? { name: step, params: {} } : { params: {}, ...step }
    )
    this.#invalidate()
    return this
  }

  /**
   * Update params on a live pipeline step. No recompile — safe in a render loop.
   * @param {string} name — must already be in the pipeline
   * @param {object} params
   */
  set(name, params) {
    const step = this.#pipeline.find(s => s.name === name)
    if (!step) throw new Error(
      `Tulle.set: "${name}" is not in the current pipeline (${this.pipeline.join(', ') || 'empty'}).`
    )
    Object.assign(step.params, params)
    this.#passes?.find(pass => pass.name === name)?.setParams(params)
    return this
  }

  // ── Render ────────────────────────────────────────────────────────────────

  /**
   * Run the pipeline once and draw to the canvas.
   * @param {HTMLVideoElement|HTMLImageElement|HTMLCanvasElement|ImageBitmap|ImageData} source
   */
  render(source) {
    this.#assertAlive('render')

    if (this.#pipeline.length === 0)
      throw new Error('Tulle.render: no pipeline. Call .apply() or .chain() first.')

    // Keep the clock moving for callers who render outside start().
    if (!this.#running) this.#time = (performance.now() - this.#origin) / 1000

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
    this.#scope.dispose()         // pointer listeners, context listeners, renderer
    this.#emitter.clear()
    this.#pipeline = []
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
    this.#passes = this.#pipeline.map(({ name, params }) => {
      const EffectClass = registry.get(name)
      if (!EffectClass) throw new Error(
        `Tulle: unknown effect "${name}". Register it first: Tulle.register("${name}", YourEffect)`
      )
      const pass = new EffectClass(this.#renderer.gl, params)
      pass.name = name // so set() can reach this pass without a recompile
      return pass
    })
  }
}
