/**
 * Transform matrix tests — pure maths, fully checkable without a GPU.
 *
 * Verifies the column-major layout the uniform expects, and that a transformed
 * point lands where the arranger intends. A point p is transformed as
 * matrix · vec3(p, 1); we replicate that here and check the xy.
 *
 *   npm test
 */
import { Transform, toMatrix, IDENTITY } from '../src/core/Transform.js'

let failed = 0
const near = (a, b) => Math.abs(a - b) < 1e-6
const eqPt = (got, want, msg) => {
  if (near(got[0], want[0]) && near(got[1], want[1])) { console.log(`ok    ${msg}`); return }
  console.error(`FAIL  ${msg} — got (${got}), want (${want})`); failed++
}
const ok = (cond, msg) => { if (cond) console.log(`ok    ${msg}`); else { console.error(`FAIL  ${msg}`); failed++ } }

/** Apply a column-major 3×3 to a 2D point: index = col*3 + row. */
function apply(m, x, y) {
  return [
    m[0] * x + m[3] * y + m[6],
    m[1] * x + m[4] * y + m[7],
  ]
}

// ── Identity leaves points where they are ────────────────────────────────────
{
  const m = Transform.identity().matrix()
  eqPt(apply(m, 0.4, -0.7), [0.4, -0.7], 'identity: point unchanged')
  ok(m.length === 9, 'identity: nine elements')
}

// ── Translate shifts ─────────────────────────────────────────────────────────
{
  const m = Transform.identity().translate(0.5, -0.25).matrix()
  eqPt(apply(m, 0, 0), [0.5, -0.25], 'translate: origin moves to (tx,ty)')
  eqPt(apply(m, 0.1, 0.1), [0.6, -0.15], 'translate: adds to any point')
}

// ── Scale shrinks about the centre ───────────────────────────────────────────
{
  const m = Transform.identity().scale(0.5).matrix()
  eqPt(apply(m, 1, 1), [0.5, 0.5], 'scale: corner pulled halfway to centre')
  eqPt(apply(m, 0, 0), [0, 0], 'scale: centre is a fixed point')
}

// ── Compose reads outermost-last: translate THEN scale means scale first ─────
{
  // A fullscreen quad corner (1,1), scaled to 0.5 then parked at (0.5,0.5):
  // scale → (0.5,0.5), translate → (1.0, 1.0). The inset's far corner.
  const m = Transform.identity().translate(0.5, 0.5).scale(0.5).matrix()
  eqPt(apply(m, 1, 1), [1.0, 1.0], 'compose: scaled inset lands in the corner')
  eqPt(apply(m, 0, 0), [0.5, 0.5], 'compose: inset centre sits at the translation')
}

// ── 90° rotation sends +x to +y ──────────────────────────────────────────────
{
  const m = Transform.identity().rotate(Math.PI / 2).matrix()
  eqPt(apply(m, 1, 0), [0, 1], 'rotate: +x maps to +y at 90°')
}

// ── toMatrix coerces the accepted shapes ─────────────────────────────────────
{
  ok(toMatrix(null) === null, 'toMatrix: null passes through')
  ok(toMatrix(Transform.identity()) instanceof Float32Array, 'toMatrix: Transform → matrix')
  ok(toMatrix([1, 0, 0, 0, 1, 0, 0, 0, 1]).length === 9, 'toMatrix: array → matrix')
  let threw = false
  try { toMatrix([1, 2, 3]) } catch { threw = true }
  ok(threw, 'toMatrix: a wrong-length array throws')
  ok(IDENTITY.length === 9, 'IDENTITY has nine elements')
}

console.log('')
if (failed) { console.error(`${failed} test(s) failed.`); process.exit(1) }
console.log('Transform: all matrix tests passed.')
