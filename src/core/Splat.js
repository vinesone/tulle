import { Emitter } from './Emitter.js'
import { Scope }   from './Scope.js'
import { windowCamera } from './camera.js'
import { parseSplatFile, toSplatData, packSplats, sortSplats, boundsOf, PACK_WIDTH } from './splatData.js'

/**
 * Splat — a 3D Gaussian Splatting scene as a source.
 *
 * A Splat renders a captured (or generated) gaussian scene into its own surface
 * and hands that surface over via `texSource`, the way Draw hands over its
 * canvas. So the core learns nothing about 3D: a splat scene blurs, blends,
 * grades, and sits in a layout box like any other source.
 *
 *   const scene = tulle.splat('garden.ply')
 *   scene.on('ready', ({ count }) => console.log(count, 'splats'))
 *
 *   const head = tulle.head()          // webcam head tracking
 *   await head.start()
 *   scene.track(head)                  // look around by moving your head
 *
 *   tulle.composite([{ source: scene }]).post(['grade', 'grain']).play()
 *
 * The camera is a *window* camera (see camera.js): the plane through the
 * camera's target is pinned to the screen and the eye moves with your head, so
 * the scene reads as depth behind glass rather than a view swinging about.
 *
 * Rendering is the standard 3DGS rasteriser: each gaussian is projected to a 2D
 * ellipse in the vertex shader (EWA splatting), drawn as an instanced quad, and
 * blended back to front. The back-to-front order comes from a counting sort that
 * runs in a Web Worker, so moving your head never stalls the frame; a
 * deterministic export (renderAt/record) sorts synchronously instead — seekTo()
 * arms that — so every exported frame is exact.
 */

const VERT = /* glsl */`#version 300 es
  precision highp float;
  precision highp int;
  uniform highp usampler2D u_data;
  uniform mat4 u_view;
  uniform mat4 u_proj;
  uniform vec2 u_viewport;
  uniform vec2 u_focal;
  in vec2 a_corner;
  in uint a_index;
  out vec4 vColor;
  out vec2 vPos;

  void main() {
    ivec2 texel = ivec2(int(a_index & 1023u) << 1, int(a_index >> 10));
    uvec4 t0 = texelFetch(u_data, texel, 0);
    vec4 cam  = u_view * vec4(uintBitsToFloat(t0.xyz), 1.0);
    vec4 clip = u_proj * cam;

    // Cull behind the near plane, and well outside the frustum.
    float bound = 1.2 * clip.w;
    if (clip.z < -clip.w || clip.x < -bound || clip.x > bound || clip.y < -bound || clip.y > bound) {
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      return;
    }

    uvec4 t1 = texelFetch(u_data, texel + ivec2(1, 0), 0);
    vec2 c0 = unpackHalf2x16(t1.x), c1 = unpackHalf2x16(t1.y), c2 = unpackHalf2x16(t1.z);
    mat3 sigma = 0.25 * mat3(c0.x, c0.y, c1.x,  c0.y, c1.y, c2.x,  c1.x, c2.x, c2.y);

    // Jacobian of the perspective divide, in pixels. An off-axis frustum's skew
    // terms are constant, so they drop out of the derivative.
    float z = cam.z;
    mat3 J = mat3(
      u_focal.x / z, 0.0, 0.0,
      0.0, u_focal.y / z, 0.0,
      -(u_focal.x * cam.x) / (z * z), -(u_focal.y * cam.y) / (z * z), 0.0);
    mat3 T = J * mat3(u_view);
    mat3 cov = T * sigma * transpose(T);

    // Low-pass: no splat smaller than about a pixel, so distant ones don't alias.
    float a = cov[0][0] + 0.3, b = cov[0][1], d = cov[1][1] + 0.3;
    float mid = 0.5 * (a + d);
    float radius = length(vec2(0.5 * (a - d), b));
    float l1 = mid + radius, l2 = mid - radius;
    if (l2 <= 0.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }

    vec2 dir = vec2(b, l1 - a);
    dir = dot(dir, dir) < 1e-12 ? vec2(1.0, 0.0) : normalize(dir);
    vec2 major = min(sqrt(2.0 * l1), 1024.0) * dir;
    vec2 minor = min(sqrt(2.0 * l2), 1024.0) * vec2(dir.y, -dir.x);

    vColor = vec4(t0.w & 0xffu, (t0.w >> 8) & 0xffu, (t0.w >> 16) & 0xffu, t0.w >> 24) / 255.0;
    vPos = a_corner;
    vec2 center = clip.xy / clip.w;
    gl_Position = vec4(center + (a_corner.x * major + a_corner.y * minor) * 2.0 / u_viewport, 0.0, 1.0);
  }
`

const FRAG = /* glsl */`#version 300 es
  precision highp float;
  in vec4 vColor;
  in vec2 vPos;
  out vec4 fragColor;

  void main() {
    float A = -dot(vPos, vPos);
    if (A < -4.0) discard;
    float alpha = exp(A) * vColor.a;
    fragColor = vec4(vColor.rgb * alpha, alpha); // premultiplied, like every Tulle buffer
  }
`

/** The sort, shipped to a worker as its own source text — one implementation, two threads. */
const WORKER_SRC = `${sortSplats}
let positions = null, count = 0
onmessage = ({ data }) => {
  if (data.positions) { positions = data.positions; count = data.count; return }
  const order = sortSplats(positions, count, data.view)
  postMessage({ order, id: data.id, gen: data.gen }, [order.buffer])
}`

export class Splat extends Emitter {
  #canvas
  #gl
  #scope = new Scope()
  #res = null          // GL objects, rebuilt after a context restore
  #lost = false

  #data = null         // SplatData — kept so a restored context can re-upload
  #packed = null
  #bounds = null
  #gen = 0             // bumps on every load, so stale sorts are dropped

  #camera = null       // object, function of the frame, or null (auto-fit)
  #head = null
  #parallax
  #background

  #worker = null
  #sortMode
  #sortBusy = false
  #sortPending = null  // newest view waiting for the worker
  #sortedKey = null    // depth row of the view the current order was made for
  #syncNext = false
  #sortId = 0

  #orderId = 0        // id of the sort the GPU order came from; older replies are stale
  #options
  #latched = new Map()
  #destroyed = false

  /**
   * @param {string | ArrayBuffer | Blob | object} src — a URL to a `.ply` or
   *   `.splat` file, its bytes, or SplatData (`{ positions, scales?, rotations?, colors? }`).
   * @param {object} options
   * @param {number} options.width — surface size in px (`tulle.splat()` fills these in).
   * @param {number} options.height
   * @param {object | ((frame: object) => object)} [options.camera] — `{ position,
   *   target, up, fov, near, far }`, or a function of the frame returning one.
   *   Omit it to frame the scene automatically once it loads.
   * @param {{ offset: { x: number, y: number, z: number } }} [options.head] — a HeadTracker.
   * @param {number} [options.parallax=1] — how strongly the head moves the eye.
   * @param {number[] | null} [options.background] — `[r, g, b, a]` 0..1, or null for transparent.
   * @param {'worker' | 'sync'} [options.sort='worker']
   * @param {number} [options.pointSize=0.01] — std-dev for splats with no scale.
   * @param {RequestInit} [options.fetch] — passed to fetch() for a URL.
   */
  constructor(src, options = {}) {
    super()
    const { width, height } = options
    if (!(width > 0) || !(height > 0))
      throw new Error('Splat: options.width and options.height are required (px).')

    this.#camera     = options.camera ?? null
    this.#head       = options.head ?? null
    this.#parallax   = options.parallax ?? 1
    this.#background = options.background ?? null
    this.#sortMode   = options.sort ?? 'worker'
    this.#options    = options

    this.#canvas = makeCanvas(width, height)
    const gl = this.#canvas.getContext('webgl2', {
      alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
    })
    if (!gl) throw new Error('Splat: WebGL2 is not supported in this browser.')
    this.#gl = gl
    this.#initGL()

    this.#scope.listen(this.#canvas, 'webglcontextlost', event => { event.preventDefault(); this.#lost = true })
    this.#scope.listen(this.#canvas, 'webglcontextrestored', () => {
      this.#lost = false
      this.#initGL()
      if (this.#packed) this.#upload()
    })

    if (src != null) this.load(src).catch(() => {}) // surfaced via 'error'
  }

  // ── Source contract ─────────────────────────────────────────────────────────

  /** The rendered surface, a valid texImage2D input. */
  get texSource() { return this.#canvas }
  /** Escape hatch to the raw surface. */
  get canvas() { return this.#canvas }
  /** Intrinsic width in px — how layout measures this source. */
  get width()  { return this.#canvas.width }
  get height() { return this.#canvas.height }

  // ── State ───────────────────────────────────────────────────────────────────

  /** Number of splats loaded; 0 before 'ready'. */
  get count()  { return this.#data?.count ?? 0 }
  /** Robust bounds of the loaded scene: `{ min, max, center, radius }`. */
  get bounds() { return this.#bounds }
  /** Has 'ready' fired for the current scene. */
  get ready()  { return this.#latched.has('ready') }

  /** The camera: an object, a function of the frame, or null (auto-framed). */
  get camera() { return this.#camera }
  set camera(camera) { this.#camera = camera }

  get parallax() { return this.#parallax }
  set parallax(value) { this.#parallax = value }

  get head() { return this.#head }

  // ── Control ─────────────────────────────────────────────────────────────────

  /**
   * Couple the view to a head tracker — or anything with an `offset` of
   * `{ x, y, z }` in screen half-heights. Pass null to detach.
   */
  track(head) {
    this.#head = head
    return this
  }

  /** Merge into the current camera, e.g. `scene.look({ position: [0, 0, -3] })`. */
  look(camera) {
    const base = typeof this.#camera === 'function' ? {} : (this.#camera ?? this.#fitted())
    this.#camera = { ...base, ...camera }
    return this
  }

  /**
   * Frame the scene: look at the centre of its bounds from `distance` radii back
   * along +z — the direction most capture tools (COLMAP-derived) face. y-down,
   * as those tools are; pass a camera of your own for anything else.
   */
  fit({ distance = 1.6, fov = 50 } = {}) {
    this.#camera = this.#fitted(distance, fov)
    return this
  }

  /** Resize the surface. */
  resize(width, height) {
    this.#canvas.width  = Math.max(1, Math.round(width))
    this.#canvas.height = Math.max(1, Math.round(height))
    return this
  }

  /**
   * Replace the scene. Resolves with the Splat once the new data is on the GPU.
   * @param {string | ArrayBuffer | Blob | object} src
   * @returns {Promise<Splat>}
   */
  async load(src) {
    this.#assertAlive('load')
    const gen = ++this.#gen
    this.#latched.delete('ready')
    this.#latched.delete('error')
    this.#latched.set('load', undefined)
    this.emit('load')

    try {
      let data
      const opts = this.#options
      if (typeof src === 'string') data = parseSplatFile(await this.#fetch(src, gen), opts)
      else if (src instanceof ArrayBuffer) data = parseSplatFile(src, opts)
      else if (ArrayBuffer.isView(src)) data = parseSplatFile(src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength), opts)
      else if (typeof Blob !== 'undefined' && src instanceof Blob) data = parseSplatFile(await src.arrayBuffer(), opts)
      else data = toSplatData(src, opts)

      if (gen !== this.#gen || this.#destroyed) return this // superseded

      const max = this.#gl.getParameter(this.#gl.MAX_TEXTURE_SIZE) * (PACK_WIDTH / 2)
      if (data.count > max) throw new Error(`Splat: ${data.count} splats exceeds this GPU's limit of ${max}.`)

      this.#data   = data
      this.#bounds = boundsOf(data.positions, data.count)
      this.#packed = packSplats(data)
      this.#upload()
      this.#sortedKey = null
      this.#sortBusy = false
      this.#sortPending = null
      this.#syncNext = true // a new scene's first frame is sorted here, never drawn unordered
      this.#initWorker()

      const payload = { count: data.count, bounds: this.#bounds }
      this.#latched.set('ready', payload)
      this.emit('ready', payload)
      return this
    } catch (err) {
      if (gen === this.#gen && !this.#destroyed) {
        this.#latched.set('error', err)
        this.emit('error', err)
      }
      throw err
    }
  }

  /** Resolves once the scene is ready; rejects if it fails to load. */
  whenReady() {
    if (this.ready) return Promise.resolve(this)
    if (this.#latched.has('error')) return Promise.reject(this.#latched.get('error'))
    return new Promise((resolve, reject) => {
      const offs = [
        this.on('ready', () => { offs.forEach(off => off()); resolve(this) }),
        this.on('error', err => { offs.forEach(off => off()); reject(err) }),
      ]
    })
  }

  /**
   * Deterministic-export hook (record/frames call it before each frame): wait for
   * the scene, and sort the next frame synchronously so it is exact rather than
   * using whatever order the worker last returned.
   */
  seekTo(_time) {
    this.#syncNext = true
    return this.whenReady()
  }

  // ── Frame tick ──────────────────────────────────────────────────────────────

  /**
   * Render the scene for this frame. Called once per rendered frame by Tulle.
   * @param {import('./Tulle.js').FrameContext} [frame]
   */
  advance(frame = {}) {
    if (this.#destroyed || this.#lost) return
    const gl = this.#gl
    const w = this.#canvas.width, h = this.#canvas.height
    gl.viewport(0, 0, w, h)
    const bg = this.#background
    gl.clearColor(bg ? bg[0] * bg[3] : 0, bg ? bg[1] * bg[3] : 0, bg ? bg[2] * bg[3] : 0, bg ? bg[3] : 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    if (!this.#data || !this.#res) return

    let camera = typeof this.#camera === 'function' ? this.#camera(frame) : this.#camera
    if (!camera) {
      camera = this.#fitted()
      if (this.#camera == null) this.#camera = camera // freeze the auto-framing
    }
    const { view, proj } = windowCamera({ ...camera, aspect: w / h }, this.#head?.offset, this.#parallax)

    this.#sort(view)
    this.#draw(view, proj, w, h)
  }

  // ── Teardown ────────────────────────────────────────────────────────────────

  /** Free the GPU objects, the worker, and the surface. Idempotent. */
  destroy() {
    if (this.#destroyed) return
    this.#destroyed = true
    this.emit('unload')
    this.#worker?.terminate()
    this.#worker = null
    this.#freeGL()
    this.#gl.getExtension('WEBGL_lose_context')?.loseContext()
    this.#scope.dispose()
    this.#canvas.width = this.#canvas.height = 1
    this.#data = this.#packed = null
    this.clear()
  }

  // ── Events (latch-and-replay, as Clip) ──────────────────────────────────────

  on(type, handler) {
    const off = super.on(type, handler)
    if (this.#latched.has(type)) {
      const payload = this.#latched.get(type)
      queueMicrotask(() => { if (!this.#destroyed) handler(payload) })
    }
    return off
  }

  // ── Private: loading ────────────────────────────────────────────────────────

  async #fetch(url, gen) {
    const res = await fetch(url, this.#options.fetch)
    if (!res.ok) throw new Error(`Splat: ${url} — HTTP ${res.status}.`)
    const total = Number(res.headers.get('content-length')) || 0
    if (!res.body || !total) return res.arrayBuffer()

    // Stream so a 50 MB capture can report progress.
    const bytes = new Uint8Array(total)
    const reader = res.body.getReader()
    let loaded = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (gen !== this.#gen) { reader.cancel(); break }
      if (loaded + value.length > total) return concatTail(bytes, loaded, value, reader)
      bytes.set(value, loaded)
      loaded += value.length
      this.emit('progress', { loaded, total })
    }
    return bytes.buffer.slice(0, loaded)
  }

  #fitted(distance = 1.6, fov = 50) {
    const { center, radius } = this.#bounds ?? { center: [0, 0, 0], radius: 1 }
    return {
      position: [center[0], center[1], center[2] - radius * distance],
      target: center,
      up: [0, -1, 0],
      fov,
    }
  }

  // ── Private: sorting ────────────────────────────────────────────────────────

  #initWorker() {
    this.#worker?.terminate()
    this.#worker = null
    if (this.#sortMode !== 'worker' || typeof Worker === 'undefined') return
    try {
      const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }))
      this.#worker = new Worker(url)
      URL.revokeObjectURL(url)
    } catch {
      return // a CSP that forbids blob: workers — sort on this thread instead
    }
    this.#worker.onmessage = ({ data }) => {
      if (data.gen !== this.#gen || this.#destroyed) return
      this.#sortBusy = false
      if (data.id > this.#orderId) { this.#orderId = data.id; this.#setOrder(data.order) }
      if (this.#sortPending) { const view = this.#sortPending; this.#sortPending = null; this.#post(view) }
    }
    this.#worker.onerror = () => { this.#worker?.terminate(); this.#worker = null; this.#sortBusy = false }
    this.#worker.postMessage({ positions: this.#data.positions.slice(), count: this.#data.count })
  }

  /** Re-sort if the view's depth axis moved since the current order was made. */
  #sort(view) {
    const key = [view[2], view[6], view[10], view[14]]
    const force = this.#syncNext
    this.#syncNext = false
    if (!force && this.#sortedKey && !moved(key, this.#sortedKey, this.#bounds.radius)) return

    this.#sortedKey = key
    if (force || !this.#worker) {
      this.#orderId = ++this.#sortId
      this.#setOrder(sortSplats(this.#data.positions, this.#data.count, view))
    } else if (this.#sortBusy) {
      this.#sortPending = view
    } else {
      this.#post(view)
    }
  }

  #post(view) {
    this.#sortBusy = true
    this.#worker.postMessage({ view: Float32Array.from(view), id: ++this.#sortId, gen: this.#gen })
  }

  #setOrder(order) {
    const gl = this.#gl
    if (!this.#res || this.#lost) return
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#res.order)
    gl.bufferData(gl.ARRAY_BUFFER, order, gl.DYNAMIC_DRAW)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
  }

  // ── Private: GL ─────────────────────────────────────────────────────────────

  #initGL() {
    const gl = this.#gl
    const program = linkProgram(gl, VERT, FRAG)
    const vao = gl.createVertexArray()
    gl.bindVertexArray(vao)

    const quad = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, quad)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-2, -2, 2, -2, -2, 2, 2, 2]), gl.STATIC_DRAW)
    const corner = gl.getAttribLocation(program, 'a_corner')
    gl.enableVertexAttribArray(corner)
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0)

    const order = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, order)
    const index = gl.getAttribLocation(program, 'a_index')
    gl.enableVertexAttribArray(index)
    gl.vertexAttribIPointer(index, 1, gl.UNSIGNED_INT, 0, 0)
    gl.vertexAttribDivisor(index, 1)

    gl.bindVertexArray(null)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)

    const tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.bindTexture(gl.TEXTURE_2D, null)

    const loc = name => gl.getUniformLocation(program, name)
    this.#res = {
      program, vao, quad, order, tex,
      u: { data: loc('u_data'), view: loc('u_view'), proj: loc('u_proj'), viewport: loc('u_viewport'), focal: loc('u_focal') },
    }
  }

  #upload() {
    const gl = this.#gl
    const { data, width, height } = this.#packed
    gl.bindTexture(gl.TEXTURE_2D, this.#res.tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, width, height, 0, gl.RGBA_INTEGER, gl.UNSIGNED_INT, data)
    gl.bindTexture(gl.TEXTURE_2D, null)
    // Identity order until the first sort lands.
    const identity = new Uint32Array(this.#data.count)
    for (let i = 0; i < identity.length; i++) identity[i] = i
    this.#setOrder(identity)
  }

  #draw(view, proj, w, h) {
    const gl = this.#gl
    const { program, vao, tex, u } = this.#res
    gl.useProgram(program)
    gl.bindVertexArray(vao)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.uniform1i(u.data, 0)
    gl.uniformMatrix4fv(u.view, false, view)
    gl.uniformMatrix4fv(u.proj, false, proj)
    gl.uniform2f(u.viewport, w, h)
    gl.uniform2f(u.focal, proj[0] * w / 2, proj[5] * h / 2)

    // Back-to-front "over" on premultiplied colour.
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.#data.count)
    gl.disable(gl.BLEND)
    gl.bindVertexArray(null)
    gl.bindTexture(gl.TEXTURE_2D, null)
  }

  #freeGL() {
    const gl = this.#gl, res = this.#res
    if (!res) return
    gl.deleteProgram(res.program)
    gl.deleteVertexArray(res.vao)
    gl.deleteBuffer(res.quad)
    gl.deleteBuffer(res.order)
    gl.deleteTexture(res.tex)
    this.#res = null
  }

  #assertAlive(method) {
    if (this.#destroyed) throw new Error(`Splat.${method}: this Splat has been destroyed.`)
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Has the view's depth axis changed enough to need a re-sort? */
function moved(a, b, radius) {
  return Math.abs(a[0] - b[0]) > 1e-4 || Math.abs(a[1] - b[1]) > 1e-4 ||
         Math.abs(a[2] - b[2]) > 1e-4 || Math.abs(a[3] - b[3]) > 1e-4 * radius
}

/** A server that under-reported content-length: finish the read into a growable list. */
async function concatTail(head, loaded, first, reader) {
  const chunks = [head.subarray(0, loaded), first]
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let at = 0
  for (const c of chunks) { out.set(c, at); at += c.length }
  return out.buffer
}

function linkProgram(gl, vert, frag) {
  const compile = (type, src) => {
    const shader = gl.createShader(type)
    gl.shaderSource(shader, src)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader)
      gl.deleteShader(shader)
      throw new Error(`Splat: shader compile failed —\n${log}`)
    }
    return shader
  }
  const vs = compile(gl.VERTEX_SHADER, vert)
  const fs = compile(gl.FRAGMENT_SHADER, frag)
  const program = gl.createProgram()
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error(`Splat: program link failed —\n${gl.getProgramInfoLog(program)}`)
  return program
}

function makeCanvas(width, height) {
  if (typeof document === 'undefined' || !document.createElement)
    throw new Error('Tulle: no document to create a canvas in.')
  const canvas = document.createElement('canvas')
  canvas.width  = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  return canvas
}
