/**
 * FramebufferPool — a reusable set of offscreen render targets.
 *
 * A linear chain only ever needs two framebuffers (ping-pong), but a composition
 * *tree* needs several alive at once: a blend node reads two inputs, and one
 * node's output may feed more than one consumer. A fixed pair cannot express
 * that. The pool replaces the pair with allocate-on-demand buffers that are
 * returned to a free list once every consumer has read them, so peak memory
 * tracks the widest point of the tree rather than its node count.
 *
 * Refcounting is the whole trick, and the whole danger. A buffer released one
 * read too early gets handed to another node and overwritten while something
 * still expects to read it — which renders *plausibly*, with subtly wrong pixels,
 * on some GPUs and not others. So `release()` refuses to go below zero, and
 * `assertLive()` (used by the Renderer before it reads a buffer) refuses to read
 * a freed one. Both throw rather than corrupt.
 *
 * This class is internal; Tulle never exposes it.
 */
export class FramebufferPool {
  /** @type {WebGL2RenderingContext} */
  #gl

  /** Buffers available for reuse, each { fbo, tex, w, h, refs }. */
  #free = []

  /** Buffers currently checked out (refs > 0). Held only so dispose() finds them. */
  #live = new Set()

  /** @param {WebGL2RenderingContext} gl */
  constructor(gl) { this.#gl = gl }

  /**
   * Check out a buffer of exactly w×h with a refcount of 1. Reuses a matching
   * free buffer when one exists, otherwise allocates. Buffers of a *different*
   * size in the free list are dead weight after a resize, so a miss also drops
   * them — the canvas rarely holds two sizes at once.
   *
   * @returns {{ fbo: WebGLFramebuffer, tex: WebGLTexture, w: number, h: number, refs: number }}
   */
  acquire(w, h) {
    const i = this.#free.findIndex(b => b.w === w && b.h === h)

    let buf
    if (i !== -1) {
      buf = this.#free.splice(i, 1)[0]
    } else {
      this.#pruneStale(w, h)
      buf = this.#make(w, h)
    }

    buf.refs = 1
    this.#live.add(buf)
    return buf
  }

  /** Add a reader. A buffer feeding N consumers should be retained N-1 times. */
  retain(buf) {
    this.#assertOwned(buf)
    buf.refs++
    return buf
  }

  /** Drop a reader. On the last release the buffer returns to the free list. */
  release(buf) {
    this.#assertOwned(buf)
    if (buf.refs <= 0)
      throw new Error('FramebufferPool: release() below zero — a buffer was released more times than retained.')

    if (--buf.refs === 0) {
      this.#live.delete(buf)
      this.#free.push(buf)
    }
  }

  /**
   * Guard a read. The Renderer calls this before binding a buffer's texture as
   * input, so a use-after-free surfaces as a thrown error at the read site
   * instead of as wrong pixels somewhere downstream.
   */
  assertLive(buf) {
    if (!buf || buf.refs <= 0)
      throw new Error('FramebufferPool: read of a buffer that is not checked out (refs <= 0).')
    return buf
  }

  /** Live buffers checked out right now — for tests and leak assertions. */
  get liveCount() { return this.#live.size }

  /** Free buffers waiting for reuse — for tests. */
  get freeCount() { return this.#free.length }

  /** Delete every GPU object. Idempotent. */
  dispose() {
    const gl = this.#gl
    for (const buf of this.#free) { gl.deleteFramebuffer(buf.fbo); gl.deleteTexture(buf.tex) }
    for (const buf of this.#live) { gl.deleteFramebuffer(buf.fbo); gl.deleteTexture(buf.tex) }
    this.#free = []
    this.#live.clear()
  }

  // ── Private ────────────────────────────────────────────────────────────────

  #assertOwned(buf) {
    if (!buf || (!this.#live.has(buf) && !this.#free.includes(buf)))
      throw new Error('FramebufferPool: buffer does not belong to this pool.')
  }

  /** Delete free buffers whose size no longer matches — post-resize garbage. */
  #pruneStale(w, h) {
    const gl = this.#gl
    this.#free = this.#free.filter(buf => {
      if (buf.w === w && buf.h === h) return true
      gl.deleteFramebuffer(buf.fbo)
      gl.deleteTexture(buf.tex)
      return false
    })
  }

  #make(w, h) {
    const gl  = this.#gl
    const tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    const fbo = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
    if (status !== gl.FRAMEBUFFER_COMPLETE)
      throw new Error(`FramebufferPool: framebuffer incomplete — 0x${status.toString(16)}`)

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.bindTexture(gl.TEXTURE_2D, null)

    return { fbo, tex, w, h, refs: 0 }
  }
}
