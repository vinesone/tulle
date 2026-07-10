/**
 * Effect — base class for all Tulle effects.
 *
 * Subclass it, write a fragment shader, declare your params:
 *
 *   export class Vignette extends Effect {
 *     static fragSrc = `#version 300 es ...`
 *     static defaults = { amount: 0.5, colored: false }
 *
 *     // Optional. Declare uniform types instead of writing WebGL calls.
 *     // Omit entirely and Tulle infers the type from the default value.
 *     static uniforms = { amount: 'float', colored: 'bool' }
 *   }
 *
 *   Tulle.register('vignette', Vignette)
 *
 * Every fragment shader may read these, all bound for you if declared:
 *
 *   uniform sampler2D u_source;       the previous pass, or the input image
 *   uniform vec2      u_resolution;   output size in pixels
 *   uniform float     u_time;         seconds since the Tulle instance began
 *   uniform float     u_delta;        seconds since the previous frame
 *   uniform vec2      u_pointer;      0..1, bottom-left origin
 *   uniform bool      u_pointerDown;
 */

/**
 * One fullscreen quad — reused across all effects. Two triangles covering clip
 * space, with no vertex buffer: the shader reads gl_VertexID.
 *
 * UVs follow the framebuffer convention (uv == (pos + 1) / 2), so uv.y == 0 is
 * the BOTTOM row. Renderer compensates on source upload by flipping y.
 *
 * Exported so a custom effect can supply its own vertex stage and still reuse
 * the standard quad.
 */
export const FULLSCREEN_VERT = /* glsl */`#version 300 es
  precision highp float;

  const vec2 POSITIONS[4] = vec2[4](
    vec2(-1.0,  1.0),
    vec2(-1.0, -1.0),
    vec2( 1.0,  1.0),
    vec2( 1.0, -1.0)
  );
  const vec2 UVS[4] = vec2[4](
    vec2(0.0, 1.0),
    vec2(0.0, 0.0),
    vec2(1.0, 1.0),
    vec2(1.0, 0.0)
  );

  out vec2 vUv;

  void main() {
    vUv         = UVS[gl_VertexID];
    gl_Position = vec4(POSITIONS[gl_VertexID], 0.0, 1.0);
  }
`

/**
 * Uniform setters by declared type name. This table is the reason effect
 * authors never touch a WebGL call: they write `spread: 'float'`, not
 * `(gl, loc, v) => gl.uniform1f(loc, v)`.
 */
const BINDERS = {
  float: (gl, loc, v) => gl.uniform1f(loc, v),
  int:   (gl, loc, v) => gl.uniform1i(loc, v | 0),
  bool:  (gl, loc, v) => gl.uniform1i(loc, v ? 1 : 0),
  vec2:  (gl, loc, v) => gl.uniform2fv(loc, v),
  vec3:  (gl, loc, v) => gl.uniform3fv(loc, v),
  vec4:  (gl, loc, v) => gl.uniform4fv(loc, v),
  mat3:  (gl, loc, v) => gl.uniformMatrix3fv(loc, false, v),
  mat4:  (gl, loc, v) => gl.uniformMatrix4fv(loc, false, v),
}

/**
 * Uniforms Tulle supplies to every effect, bound from the frame context.
 * u_source is input 0; u_layer is input 1, used by blends that read two layers.
 */
const AUTO_UNIFORMS = ['u_source', 'u_layer', 'u_resolution', 'u_time', 'u_delta', 'u_pointer', 'u_pointerDown']

export class Effect {
  /** @type {string} Vertex source. Defaults to the built-in fullscreen quad. */
  static vertSrc = FULLSCREEN_VERT

  /** @type {string} Required — GLSL fragment shader source. */
  static fragSrc = null

  /** @type {object} Default param values. Also used to infer uniform types. */
  static defaults = {}

  /**
   * Optional uniform type declarations: `{ spread: 'float' }`.
   * A raw `(gl, location, value) => void` function is accepted as an escape
   * hatch for types this table doesn't cover.
   * @type {Record<string, keyof BINDERS | Function>}
   */
  static uniforms = {}

  /** @type {WebGL2RenderingContext} */
  gl

  /**
   * The name this Effect lives under in the pipeline.
   * Assigned by Tulle when it instantiates from the registry.
   * @type {string}
   */
  name = '(unnamed)'

  #program
  #vao

  /** @type {Map<string, WebGLUniformLocation|null>} memoised; null means "not in shader" */
  #locations = new Map()

  /** @type {Record<string, WebGLUniformLocation|null>} */
  #auto = {}

  /** @type {object} live params — defaults merged with caller values */
  #params

  #destroyed = false

  /**
   * @param {WebGL2RenderingContext} gl
   * @param {object} [params]
   */
  constructor(gl, params = {}) {
    const ctor = /** @type {typeof Effect} */ (this.constructor)

    if (!ctor.fragSrc)
      throw new Error(`${ctor.name}: static fragSrc is required.`)

    this.gl       = gl
    this.#params  = { ...ctor.defaults, ...params }
    this.#program = compileProgram(gl, ctor.vertSrc, ctor.fragSrc)
    this.#vao     = makeVAO(gl)

    for (const key of AUTO_UNIFORMS)
      this.#auto[key] = gl.getUniformLocation(this.#program, key)
  }

  /** A detached copy of the live params. */
  get params() { return { ...this.#params } }

  /**
   * Merge new values into live params and push them to the GPU.
   * No recompile — safe to call every frame.
   * @param {object} next
   */
  setParams(next) {
    Object.assign(this.#params, next)
    this.#pushUniforms()
  }

  /**
   * Bind this effect's program and draw a fullscreen quad.
   * Renderer calls this once the destination framebuffer is bound.
   *
   * @param {WebGLTexture|WebGLTexture[]} inputs — one texture, or an array. The
   *   first is bound to u_source, the second (if any) to u_layer. A single
   *   texture behaves exactly as before, so existing effects are untouched.
   * @param {import('./Tulle.js').FrameContext & {width: number, height: number}} ctx
   */
  draw(inputs, ctx) {
    const { gl } = this
    const auto = this.#auto
    const texes = Array.isArray(inputs) ? inputs : [inputs]

    gl.useProgram(this.#program)
    gl.bindVertexArray(this.#vao)

    if (auto.u_source !== null && texes[0]) {
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, texes[0])
      gl.uniform1i(auto.u_source, 0)
    }
    if (auto.u_layer !== null && texes[1]) {
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, texes[1])
      gl.uniform1i(auto.u_layer, 1)
    }
    if (auto.u_resolution !== null) gl.uniform2f(auto.u_resolution, ctx.width, ctx.height)
    if (auto.u_time       !== null) gl.uniform1f(auto.u_time,  ctx.time)
    if (auto.u_delta      !== null) gl.uniform1f(auto.u_delta, ctx.delta)

    if (auto.u_pointer !== null) {
      const p = ctx.pointer
      gl.uniform2f(auto.u_pointer, p ? p.u : 0, p ? p.v : 0)
    }
    if (auto.u_pointerDown !== null) gl.uniform1i(auto.u_pointerDown, ctx.pointer?.down ? 1 : 0)

    this.#pushUniforms()
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.bindVertexArray(null)
  }

  /** Release GPU resources. Idempotent. */
  destroy() {
    if (this.#destroyed) return
    this.#destroyed = true
    this.gl.deleteProgram(this.#program)
    this.gl.deleteVertexArray(this.#vao)
    this.#locations.clear()
  }

  /**
   * Memoised uniform lookup. Caches misses too, so a param that isn't a uniform
   * costs one lookup for the life of the Effect rather than one per frame.
   */
  #loc(key) {
    if (!this.#locations.has(key))
      this.#locations.set(key, this.gl.getUniformLocation(this.#program, key))
    return this.#locations.get(key)
  }

  #pushUniforms() {
    const { gl } = this
    const declared = /** @type {typeof Effect} */ (this.constructor).uniforms

    gl.useProgram(this.#program)

    for (const [key, value] of Object.entries(this.#params)) {
      const loc = this.#loc(key)
      if (loc === null) continue

      const decl = declared[key]

      if (typeof decl === 'function') decl(gl, loc, value)      // escape hatch
      else if (decl && BINDERS[decl]) BINDERS[decl](gl, loc, value)
      else inferUniform(gl, loc, value, key)
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function compileProgram(gl, vertSrc, fragSrc) {
  const vert = compileShader(gl, gl.VERTEX_SHADER,   vertSrc)
  const frag = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc)

  const prog = gl.createProgram()
  gl.attachShader(prog, vert)
  gl.attachShader(prog, frag)
  gl.linkProgram(prog)

  // Safe to delete once attached and linked — the program holds a reference.
  gl.deleteShader(vert)
  gl.deleteShader(frag)

  if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
    throw new Error(`Tulle: shader link failed — ${gl.getProgramInfoLog(prog)}`)

  return prog
}

function compileShader(gl, type, src) {
  const shader = gl.createShader(type)
  gl.shaderSource(shader, src)
  gl.compileShader(shader)

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const label = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment'
    throw new Error(`Tulle: ${label} shader compile error — ${gl.getShaderInfoLog(shader)}`)
  }
  return shader
}

function makeVAO(gl) {
  // The fullscreen vertex shader reads gl_VertexID, so there are no attributes.
  // WebGL2 still requires a bound VAO for the draw call.
  const vao = gl.createVertexArray()
  gl.bindVertexArray(vao)
  gl.bindVertexArray(null)
  return vao
}

/** Fallback when a param has no declared type: guess from the JS value. */
function inferUniform(gl, loc, value, key) {
  if (typeof value === 'number') {
    gl.uniform1f(loc, value)
  } else if (typeof value === 'boolean') {
    gl.uniform1i(loc, value ? 1 : 0)
  } else if (Array.isArray(value) || value instanceof Float32Array) {
    switch (value.length) {
      case 2: gl.uniform2fv(loc, value); break
      case 3: gl.uniform3fv(loc, value); break
      case 4: gl.uniform4fv(loc, value); break
      default:
        console.warn(`Tulle: "${key}" is an array of length ${value.length}; declare it in static uniforms.`)
    }
  } else {
    console.warn(`Tulle: cannot infer a uniform type for "${key}" (${typeof value}). Declare it in static uniforms.`)
  }
}
