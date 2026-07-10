import { FramebufferPool } from './FramebufferPool.js'

/**
 * Renderer — owns the GPU-side plumbing: the source texture, the framebuffer
 * pool, and the pass loop. Tulle never exposes this class.
 *
 * A linear chain acquires one intermediate buffer per pass and releases the
 * previous one as soon as it has been read, so at most two buffers are ever live
 * at once — pixel-identical to the ping-pong pair this replaced. The pool exists
 * so a future composition tree can hold more than two buffers alive when it must.
 */
export class Renderer {
  /** @type {WebGL2RenderingContext} */
  gl

  /** @type {FramebufferPool} */
  #pool

  // Source texture — overwritten each run().
  #sourceTex = null

  /** @param {WebGL2RenderingContext} gl */
  constructor(gl) {
    this.gl = gl
    this.#pool = new FramebufferPool(gl)
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

    // ── Multi-pass: acquire → draw → release the consumed input ─────────────
    // `input` is the pool buffer feeding the current pass, or null while the
    // source texture is the input. Each pass acquires its output *before*
    // releasing its input, so acquire never hands back the buffer being read —
    // the same no-aliasing guarantee the ping-pong pair gave.
    let readTex = this.#sourceTex
    let input   = null

    for (let i = 0; i < passes.length; i++) {
      const isLast = i === passes.length - 1

      let output = null
      if (isLast) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      } else {
        output = this.#pool.acquire(w, h)
        gl.bindFramebuffer(gl.FRAMEBUFFER, output.fbo)
      }

      gl.viewport(0, 0, w, h)
      if (input) this.#pool.assertLive(input) // read guard: catch use-after-free
      passes[i].draw(readTex, frame)

      // The input has now been consumed; hand it back for reuse.
      if (input) this.#pool.release(input)

      if (!isLast) {
        readTex = output.tex
        input   = output
      }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  /**
   * Drop every GPU object and rebuild the source texture.
   * Called after `webglcontextrestored`, when all previous handles are dead.
   */
  reset() {
    this.#pool.dispose()
    this.#sourceTex = this.#makeTexture()
  }

  /** Release all GPU resources. Idempotent. */
  destroy() {
    const gl = this.gl
    if (this.#sourceTex) { gl.deleteTexture(this.#sourceTex); this.#sourceTex = null }
    this.#pool.dispose()
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
}
