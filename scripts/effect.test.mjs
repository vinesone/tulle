/**
 * Effect sampler-uniform tests.
 *
 * The LUT/mask capability — a 'sampler2D' param uploaded to its own texture unit
 * — is pure bookkeeping over gl calls, so it runs against a fake context. What
 * matters and is checked: a sampler texture is created, an image-like value is
 * uploaded once and re-uploaded only when it changes, the raw upload does NOT
 * flip or premultiply, scalar params still bind, and destroy() frees the texture.
 *
 * Shader correctness (does the LUT actually grade?) needs a browser.
 *
 *   npm test
 */
import { Effect } from '../src/core/Effect.js'

function fakeGL() {
  const live = { tex: new Set() }
  const calls = { texImage2D: [], pixelStorei: [], uniform1i: [] }
  let id = 0
  const real = {
    UNPACK_FLIP_Y_WEBGL: 'FLIP', UNPACK_PREMULTIPLY_ALPHA_WEBGL: 'PREMUL',
    TEXTURE0: 1000,
    createShader: () => ({}), shaderSource() {}, compileShader() {},
    getShaderParameter: () => true, getProgramParameter: () => true,
    getShaderInfoLog: () => '', getProgramInfoLog: () => '',
    createProgram: () => ({}), attachShader() {}, linkProgram() {},
    deleteShader() {}, deleteProgram() {},
    createVertexArray: () => ({}), bindVertexArray() {}, deleteVertexArray() {},
    getUniformLocation: (_p, name) => ({ name }),  // non-null, carries its name
    createTexture()  { const h = `t${id++}`; live.tex.add(h); return h },
    deleteTexture(h) { live.tex.delete(h) },
    texImage2D(...a) { calls.texImage2D.push(a) },
    pixelStorei(k, v) { calls.pixelStorei.push([k, v]) },
    uniform1i(loc, v) { calls.uniform1i.push([loc?.name, v]) },
    texParameteri() {}, bindTexture() {}, useProgram() {}, activeTexture() {},
    uniform1f() {}, uniform2f() {}, drawArrays() {},
    live, calls,
  }
  return new Proxy(real, {
    get(t, p) { return p in t ? t[p] : (typeof p === 'string' && p === p.toUpperCase() ? p : () => {}) },
  })
}

class Sampled extends Effect {
  static fragSrc = '#version 300 es\nvoid main(){}'
  static defaults = { amount: 1, lut: null }
  static uniforms = { amount: 'float', lut: 'sampler2D' }
}

let failed = 0
const eq = (got, want, msg) => {
  if (got === want) { console.log(`ok    ${msg}`); return }
  console.error(`FAIL  ${msg} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); failed++
}
const ok = (cond, msg) => { if (cond) console.log(`ok    ${msg}`); else { console.error(`FAIL  ${msg}`); failed++ } }

const frame = { width: 4, height: 4, time: 0, delta: 0, pointer: null }
const lutA = { A: 1 }   // stand-ins for image-like values (identity-compared)
const lutB = { B: 1 }

// ── A sampler param gets its own texture and unit past source/layer ──────────
{
  const gl = fakeGL()
  const fx = new Sampled(gl)
  // One texture for the sampler, seeded with a 1×1 fallback (one texImage2D).
  eq(gl.live.tex.size, 1, 'construct: one sampler texture created')
  eq(gl.calls.texImage2D.length, 1, 'construct: fallback texel uploaded once')

  fx.setParams({ lut: lutA })
  fx.draw(['sourceTex'], frame)

  // The lut uploaded on draw, and its uniform bound to unit 2 (0=source,1=layer).
  const lutBind = gl.calls.uniform1i.find(([name]) => name === 'lut')
  eq(lutBind?.[1], 2, 'draw: lut sampler bound to unit 2')
  ok(gl.calls.texImage2D.length === 2, 'draw: lut uploaded once')

  // Raw upload — flip and premultiply both turned OFF for LUT data.
  const flip = gl.calls.pixelStorei.filter(([k]) => k === 'FLIP').pop()
  const premul = gl.calls.pixelStorei.filter(([k]) => k === 'PREMUL').pop()
  eq(flip?.[1], false, 'upload: Y-flip disabled for LUT data')
  eq(premul?.[1], false, 'upload: premultiply disabled for LUT data')

  // Re-draw with the same value: no re-upload.
  fx.draw(['sourceTex'], frame)
  eq(gl.calls.texImage2D.length, 2, 'redraw same lut: not re-uploaded')

  // A different value re-uploads.
  fx.setParams({ lut: lutB })
  fx.draw(['sourceTex'], frame)
  eq(gl.calls.texImage2D.length, 3, 'new lut: re-uploaded once')

  fx.destroy()
  eq(gl.live.tex.size, 0, 'destroy: sampler texture freed')
}

console.log('')
if (failed) { console.error(`${failed} test(s) failed.`); process.exit(1) }
console.log('Effect samplers: all tests passed.')
