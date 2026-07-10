/**
 * Renderer — owns the GPU-side plumbing: the source texture, the ping-pong
 * framebuffer pair, and the pass loop. Tulle never exposes this class.
 */
export class Renderer {
  /** @type {WebGL2RenderingContext} */
  gl

  // Ping-pong pair — reused every frame, reallocated on resize.
  #fboA = null; #texA = null
  #fboB = null; #texB = null
  #fboWidth = 0; #fboHeight = 0

  // Source texture — overwritten each run().
  #sourceTex = null

  /** @param {WebGL2RenderingContext} gl */
  constructor(gl) {
    this.gl = gl
    this.#sourceTex = this.#makeTexture()
  }

  /**
   * Run the pipeline and composite to canvas.
   *
   * @param {HTMLVideoElement|HTMLImageElement|HTMLCanvasElement|ImageBitmap|ImageData} source
   * @param {import('./Effect.js').Effect[]} passes
   * @param {import('./Tulle.js').FrameContext} ctx
   */
  run(source, passes, ctx) {
    const gl = this.gl
    const w  = gl.drawingBufferWidth
    const h  = gl.drawingBufferHeight

    // Recreated lazily so run() survives a context restore.
    if (!this.#sourceTex) this.#sourceTex = this.#makeTexture()

    this.#upload(this.#sourceTex, source)

    // Each pass sees the size of the framebuffer it is drawing into.
    const frame = { ...ctx, width: w, height: h }

    // ── Fast path: single pass draws straight to the canvas ─────────────────
    if (passes.length === 1) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, w, h)
      passes[0].draw(this.#sourceTex, frame)
      return
    }

    // ── Multi-pass: ping-pong between two framebuffers ─────────────────────
    this.#ensureFBOs(w, h)

    const fbos = [this.#fboA, this.#fboB]
    const texs = [this.#texA, this.#texB]
    let readTex = this.#sourceTex

    for (let i = 0; i < passes.length; i++) {
      const isLast = i === passes.length - 1

      // Pass i writes fbo[i % 2] and reads what pass i-1 wrote. Never the same
      // texture, so there is no read/write aliasing.
      gl.bindFramebuffer(gl.FRAMEBUFFER, isLast ? null : fbos[i % 2])
      gl.viewport(0, 0, w, h)
      passes[i].draw(readTex, frame)

      if (!isLast) readTex = texs[i % 2]
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  /**
   * Drop every GPU object and rebuild the source texture.
   * Called after `webglcontextrestored`, when all previous handles are dead.
   */
  reset() {
    this.#teardownFBOs()
    this.#sourceTex = this.#makeTexture()
  }

  /** Release all GPU resources. Idempotent. */
  destroy() {
    const gl = this.gl
    if (this.#sourceTex) { gl.deleteTexture(this.#sourceTex); this.#sourceTex = null }
    this.#teardownFBOs()
  }

  /**
   * Upload any image-like source into a texture.
   *
   * Image sources have row 0 at the TOP; our UVs are y-up (uv == (pos+1)/2, the
   * same layout an FBO texture has). Flip on upload so both agree — otherwise
   * every source renders upside down.
   */
  #upload(tex, source) {
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.bindTexture(gl.TEXTURE_2D, null)
  }

  /** Allocate or reallocate the ping-pong pair when the canvas size changes. */
  #ensureFBOs(w, h) {
    if (this.#fboWidth === w && this.#fboHeight === h && this.#fboA) return
    this.#teardownFBOs()
    ;[this.#fboA, this.#texA] = this.#makeFBO(w, h)
    ;[this.#fboB, this.#texB] = this.#makeFBO(w, h)
    this.#fboWidth  = w
    this.#fboHeight = h
  }

  /** @returns {[WebGLFramebuffer, WebGLTexture]} */
  #makeFBO(w, h) {
    const gl  = this.gl
    const tex = this.#makeTexture()

    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)

    const fbo = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
    if (status !== gl.FRAMEBUFFER_COMPLETE)
      throw new Error(`Tulle: framebuffer incomplete — 0x${status.toString(16)}`)

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.bindTexture(gl.TEXTURE_2D, null)

    return [fbo, tex]
  }

  /** Shared texture defaults — no mipmaps, clamp to edge. */
  #makeTexture() {
    const gl  = this.gl
    const tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.bindTexture(gl.TEXTURE_2D, null)
    return tex
  }

  #teardownFBOs() {
    const gl = this.gl
    if (this.#fboA) { gl.deleteFramebuffer(this.#fboA); this.#fboA = null }
    if (this.#fboB) { gl.deleteFramebuffer(this.#fboB); this.#fboB = null }
    if (this.#texA) { gl.deleteTexture(this.#texA);     this.#texA = null }
    if (this.#texB) { gl.deleteTexture(this.#texB);     this.#texB = null }
    this.#fboWidth = this.#fboHeight = 0
  }
}
