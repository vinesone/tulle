/**
 * Renderer.composite() discipline tests.
 *
 * No GPU here, so the Renderer runs against a permissive fake WebGL2 context
 * that mints and counts handles. Two things are being checked:
 *
 *   1. Pool discipline — if composite() double-released a buffer or read a freed
 *      one, the pool's own guards (release-below-zero, assertLive) would throw.
 *      A clean multi-layer run is the evidence.
 *   2. Multi-input wiring — blends must receive two textures, effects one.
 *
 * Real GLSL compilation and pixel output are NOT covered; those need a browser.
 *
 *   npm test
 */
import { Renderer } from '../src/core/Renderer.js'

const FRAMEBUFFER_COMPLETE = 1

/** A permissive gl stub: real behaviour where it matters, no-ops elsewhere. */
function fakeGL() {
  const live = { fbo: new Set(), tex: new Set() }
  let id = 0
  const real = {
    drawingBufferWidth: 320, drawingBufferHeight: 240,
    FRAMEBUFFER_COMPLETE,
    // Shader/program compile path — always "succeeds".
    createShader: () => ({}), shaderSource() {}, compileShader() {},
    getShaderParameter: () => true, getProgramParameter: () => true,
    getShaderInfoLog: () => '', getProgramInfoLog: () => '',
    createProgram: () => ({}), attachShader() {}, linkProgram() {},
    deleteShader() {}, deleteProgram() {},
    createVertexArray: () => ({}), bindVertexArray() {}, deleteVertexArray() {},
    getUniformLocation: () => ({}),        // non-null so every binding path runs
    // Tracked GPU objects.
    createTexture()      { const h = `t${id++}`; live.tex.add(h); return h },
    createFramebuffer()  { const h = `f${id++}`; live.fbo.add(h); return h },
    deleteTexture(h)     { live.tex.delete(h) },
    deleteFramebuffer(h) { live.fbo.delete(h) },
    checkFramebufferStatus: () => FRAMEBUFFER_COMPLETE,
    live,
  }
  // Unknown methods → no-ops; unknown constants → a number.
  return new Proxy(real, {
    get(t, p) {
      if (p in t) return t[p]
      return typeof p === 'string' && p === p.toUpperCase() ? 1 : () => {}
    },
  })
}

let failed = 0
const eq = (got, want, msg) => {
  if (got === want) { console.log(`ok    ${msg}`); return }
  console.error(`FAIL  ${msg} — got ${got}, want ${want}`); failed++
}
const ok = msg => console.log(`ok    ${msg}`)
const no = (msg, err) => { console.error(`FAIL  ${msg} — ${err.message}`); failed++ }

/** A fake pass/blend that records the shape of the inputs it was drawn with. */
const recorder = (log, label) => ({
  draw(inputs) { log.push({ label, inputs: Array.isArray(inputs) ? inputs.length : 1 }) },
})

const ctx = { time: 0, delta: 0, frame: 0, pointer: null }

// ── Three layers composite cleanly and wire inputs correctly ──────────────────
{
  const gl = fakeGL()
  const renderer = new Renderer(gl)
  const log = []

  const layers = [
    { source: {}, passes: [recorder(log, 'base.a'), recorder(log, 'base.b')], blend: null },
    { source: {}, passes: [],                                                 blend: recorder(log, 'blend.over') },
    { source: {}, passes: [recorder(log, 'top.c')],                           blend: recorder(log, 'blend.screen') },
  ]

  try {
    renderer.composite(layers, [], ctx)
    ok('three layers: composite ran without a pool-guard throw')
  } catch (err) {
    no('three layers: composite ran without a pool-guard throw', err)
  }

  const blends = log.filter(e => e.label.startsWith('blend'))
  const effects = log.filter(e => !e.label.startsWith('blend'))
  eq(blends.length, 2, 'three layers: two blends ran (one per non-base layer)')
  eq(blends.every(e => e.inputs === 2), true, 'blend received two textures (base + layer)')
  eq(effects.every(e => e.inputs === 1), true, 'each effect received one texture')

  renderer.destroy()
  eq(gl.live.fbo.size, 0, 'three layers: no framebuffer leaked after destroy')
  eq(gl.live.tex.size, 0, 'three layers: no texture leaked after destroy')
}

// ── A post chain runs over the composite and leaves nothing checked out ───────
{
  const gl = fakeGL()
  const renderer = new Renderer(gl)
  const log = []
  const layers = [
    { source: {}, passes: [], blend: null },
    { source: {}, passes: [], blend: recorder(log, 'blend') },
  ]
  const post = [recorder(log, 'post.a'), recorder(log, 'post.b')]

  try {
    renderer.composite(layers, post, ctx)
    ok('post chain: composite + post ran without a pool-guard throw')
  } catch (err) { no('post chain: composite + post ran without a pool-guard throw', err) }

  const postRuns = log.filter(e => e.label.startsWith('post'))
  eq(postRuns.length, 2, 'post chain: both post effects ran')
  eq(postRuns.every(e => e.inputs === 1), true, 'post chain: each post effect got one texture')

  renderer.destroy()
  eq(gl.live.fbo.size + gl.live.tex.size, 0, 'post chain: nothing leaked after destroy')
}

// ── A transformed layer takes an extra placement buffer, still leak-free ──────
{
  const gl = fakeGL()
  const renderer = new Renderer(gl)
  const log = []
  const layers = [
    { source: {}, passes: [], blend: null },
    // A placed layer: content rendered fullscreen, then blitted into a cleared
    // buffer at its transform. Extra acquire/clear/release — must stay balanced.
    { source: {}, passes: [recorder(log, 'top')], blend: recorder(log, 'blend'),
      transform: new Float32Array([0.5, 0, 0, 0, 0.5, 0, 0.5, 0.5, 1]) },
  ]
  try {
    renderer.composite(layers, [], ctx)
    ok('transformed layer: composite ran without a pool-guard throw')
  } catch (err) { no('transformed layer: composite ran without a pool-guard throw', err) }
  renderer.destroy()
  eq(gl.live.fbo.size + gl.live.tex.size, 0, 'transformed layer: nothing leaked')
}

// ── A single base layer just blits to canvas, no blend ───────────────────────
{
  const gl = fakeGL()
  const renderer = new Renderer(gl)
  const log = []
  try {
    renderer.composite([{ source: {}, passes: [recorder(log, "only")], blend: null }], [], ctx)
    ok('single layer: composite ran')
  } catch (err) { no('single layer: composite ran', err) }
  eq(log.length, 1, 'single layer: its one effect drew, no blend')
  renderer.destroy()
  eq(gl.live.fbo.size + gl.live.tex.size, 0, 'single layer: nothing leaked')
}

// ── An empty stack is a no-op, not a crash ───────────────────────────────────
{
  const gl = fakeGL()
  const renderer = new Renderer(gl)
  try { renderer.composite([], [], ctx); ok('empty stack: no-op, no throw') }
  catch (err) { no('empty stack: no-op, no throw', err) }
  renderer.destroy()
}

// ── Repeated frames don't leak (buffers are pooled and reused) ───────────────
{
  const gl = fakeGL()
  const renderer = new Renderer(gl)
  const layers = [
    { source: {}, passes: [], blend: null },
    { source: {}, passes: [], blend: { draw() {} } },
  ]
  for (let i = 0; i < 10; i++) renderer.composite(layers, [], ctx)
  // Peak allocation is small and bounded; it must not grow with frame count.
  const afterMany = gl.live.fbo.size
  for (let i = 0; i < 10; i++) renderer.composite(layers, [], ctx)
  eq(gl.live.fbo.size, afterMany, 'repeated frames: framebuffer count is stable, not growing')
  renderer.destroy()
  eq(gl.live.fbo.size, 0, 'repeated frames: clean after destroy')
}

console.log('')
if (failed) { console.error(`${failed} test(s) failed.`); process.exit(1) }
console.log('Renderer.composite: all discipline tests passed.')
