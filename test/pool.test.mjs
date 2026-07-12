/**
 * FramebufferPool bookkeeping tests.
 *
 * The pool's refcounting is pure logic over a handful of gl calls, so it can be
 * exercised without a GPU by handing it a fake context that just mints and
 * counts handles. This catches the class of bug composition.md flags as the
 * worst possible — a buffer reused while something still reads it — deterministic
 * where a real WebGL test would be flaky and headless-only.
 *
 *   npm test
 */
import { FramebufferPool } from '../src/core/FramebufferPool.js'

/** A gl stub: unique handles, live-object counts, constants the pool touches. */
function fakeGL() {
  let id = 0
  const live = { fbo: new Set(), tex: new Set() }
  return {
    live,
    FRAMEBUFFER: 1, COLOR_ATTACHMENT0: 2, TEXTURE_2D: 3, RGBA: 4, UNSIGNED_BYTE: 5,
    TEXTURE_MIN_FILTER: 6, TEXTURE_MAG_FILTER: 7, TEXTURE_WRAP_S: 8, TEXTURE_WRAP_T: 9,
    LINEAR: 10, CLAMP_TO_EDGE: 11, FRAMEBUFFER_COMPLETE: 12,
    createTexture()      { const h = `t${id++}`; live.tex.add(h); return h },
    createFramebuffer()  { const h = `f${id++}`; live.fbo.add(h); return h },
    deleteTexture(h)     { live.tex.delete(h) },
    deleteFramebuffer(h) { live.fbo.delete(h) },
    bindTexture() {}, bindFramebuffer() {}, texImage2D() {}, texParameteri() {},
    framebufferTexture2D() {}, checkFramebufferStatus() { return 12 },
  }
}

let failed = 0
const eq = (got, want, msg) => {
  if (got === want) { console.log(`ok    ${msg}`); return }
  console.error(`FAIL  ${msg} — got ${got}, want ${want}`); failed++
}
const throws = (fn, msg) => {
  try { fn(); console.error(`FAIL  ${msg} — expected a throw`); failed++ }
  catch { console.log(`ok    ${msg}`) }
}

// ── A linear chain caps at two buffers and reuses them, exactly like ping-pong ─
{
  const gl = fakeGL()
  const pool = new FramebufferPool(gl)

  // Simulate the Renderer's pass loop for a 6-pass chain: acquire output before
  // releasing input, so two buffers coexist at each crossover and then alternate.
  // A 2-buffer cap that never grows is the ping-pong equivalence we must keep.
  const handles = new Set()
  let input = null
  for (let i = 0; i < 5; i++) {              // 5 intermediate passes (6th draws to canvas)
    const out = pool.acquire(64, 64)
    handles.add(out.fbo)
    if (input) pool.release(input)
    input = out
  }
  pool.release(input)

  eq(pool.liveCount, 0, 'chain: nothing left checked out')
  eq(gl.live.fbo.size, 2, 'chain: peak of exactly two framebuffers, never more')
  eq(gl.live.tex.size, 2, 'chain: peak of exactly two textures')
  eq(handles.size, 2, 'chain: five passes cycled through the same two buffers')
  eq(pool.freeCount, 2, 'chain: both buffers idle on the free list at the end')
}

// ── Two live buffers when a consumer holds both (the tree case) ───────────────
{
  const pool = new FramebufferPool(fakeGL())
  const a = pool.acquire(32, 32)
  const b = pool.acquire(32, 32)            // b must not reuse a — a is still live
  eq(pool.liveCount, 2, 'tree: two buffers coexist')
  eq(a === b, false, 'tree: acquire did not hand back a live buffer')
  pool.release(a); pool.release(b)
  eq(pool.freeCount, 2, 'tree: both return to the free list')
}

// ── Refcount: release on LAST reader, not first ──────────────────────────────
{
  const pool = new FramebufferPool(fakeGL())
  const buf = pool.acquire(8, 8)
  pool.retain(buf)                          // two consumers now
  pool.release(buf)
  eq(pool.liveCount, 1, 'refcount: still live after first of two releases')
  pool.assertLive(buf)                      // must not throw
  pool.release(buf)
  eq(pool.liveCount, 0, 'refcount: freed after the last release')
  throws(() => pool.assertLive(buf), 'refcount: reading a freed buffer throws')
  throws(() => pool.release(buf), 'refcount: releasing below zero throws')
}

// ── Resize prunes stale free buffers instead of reusing a wrong size ─────────
{
  const gl = fakeGL()
  const pool = new FramebufferPool(gl)
  pool.release(pool.acquire(10, 10))        // one 10×10 buffer on the free list
  const big = pool.acquire(20, 20)          // size miss → prune the 10×10, allocate 20×20
  eq(pool.freeCount, 0, 'resize: stale buffer pruned from free list')
  eq(gl.live.fbo.size, 1, 'resize: stale framebuffer actually deleted')
  eq(big.w, 20, 'resize: new buffer has the requested size')
}

// ── dispose() deletes everything, live or free ───────────────────────────────
{
  const gl = fakeGL()
  const pool = new FramebufferPool(gl)
  const live = pool.acquire(16, 16)
  pool.release(pool.acquire(16, 16))        // one free
  pool.dispose()
  eq(gl.live.fbo.size, 0, 'dispose: no framebuffers leak')
  eq(gl.live.tex.size, 0, 'dispose: no textures leak')
  eq(pool.liveCount + pool.freeCount, 0, 'dispose: pool is empty')
}

console.log('')
if (failed) { console.error(`${failed} test(s) failed.`); process.exit(1) }
console.log('FramebufferPool: all bookkeeping tests passed.')
