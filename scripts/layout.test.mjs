/**
 * Layout tests — pure flow solving and the design→clip mapping, no GPU.
 *
 * solveLayout takes a measure(source) function, so we feed fake sources with known
 * sizes and assert exact rects. rectToMatrix / fitRect are checked as plain maths.
 * Same discipline as Text's layoutLines and Clip's dueCues tests.
 *
 *   npm test
 */
import { box, inline, block, solveLayout, rectToMatrix, fitRect, coverUV } from '../src/core/Layout.js'

let failed = 0
const ok = (cond, msg) => { if (cond) console.log(`ok    ${msg}`); else { console.error(`FAIL  ${msg}`); failed++ } }
const near = (a, b) => Math.abs(a - b) < 1e-4
const rect = (r, x, y, w, h, msg) =>
  ok(r && near(r.x, x) && near(r.y, y) && near(r.w, w) && near(r.h, h),
     `${msg} — got ${r ? `(${r.x},${r.y},${r.w},${r.h})` : 'undefined'}, want (${x},${y},${w},${h})`)

/** A fake source of a fixed intrinsic size. */
const src = (width, height) => ({ width, height })
/** Sizes come straight off the fake source. */
const measure = s => ({ width: s.width || 0, height: s.height || 0 })
const solve = (root, w = 100, h = 100) => solveLayout(root, { width: w, height: h }, measure).rects
const solveScroll = (root, scroll, w = 100, h = 100) => solveLayout(root, { width: w, height: h }, measure, {}, scroll).rects

// ── Inline flow: boxes pack left to right ────────────────────────────────────
{
  const r = solve(inline([box(src(20, 20)), box(src(30, 10))]))
  rect(r[0], 0, 0, 20, 20, 'inline: first box at origin')
  rect(r[1], 20, 0, 30, 10, 'inline: second box to the right')
}

// ── Inline wrap: overflow drops to the next line ─────────────────────────────
{
  // inner width 40: 30 fits; 30 + 20 = 50 > 40, so the 20 wraps below.
  const r = solve(inline([box(src(30, 12)), box(src(20, 8))]), 40, 100)
  rect(r[0], 0, 0, 30, 12, 'wrap: first box on line one')
  rect(r[1], 0, 12, 20, 8, 'wrap: second box drops to line two')
}

// ── Block: children stack vertically ─────────────────────────────────────────
{
  const r = solve(block([box(src(20, 20)), box(src(30, 10))]))
  rect(r[0], 0, 0, 20, 20, 'block: first stacked at top')
  rect(r[1], 0, 20, 30, 10, 'block: second below the first')
}

// ── A block child breaks the inline line ─────────────────────────────────────
{
  const r = solve(inline([box(src(20, 20)), block([box(src(10, 10))]), box(src(15, 15))]))
  rect(r[0], 0, 0, 20, 20, 'break: inline box on line one')
  rect(r[1], 0, 20, 10, 10, 'break: block child on its own line')
  rect(r[2], 0, 30, 15, 15, 'break: following box resumes after the block')
}

// ── Padding and gap ──────────────────────────────────────────────────────────
{
  const r = solve(block([box(src(20, 20)), box(src(20, 20))], { padding: 10, gap: 5 }))
  rect(r[0], 10, 10, 20, 20, 'padding: first inset by padding')
  rect(r[1], 10, 35, 20, 20, 'gap: second below first + gap')
}

// ── A leaf wider than the frame scales down, keeping aspect ──────────────────
{
  const r = solve(inline([box(src(200, 100))]), 100, 100)
  rect(r[0], 0, 0, 100, 50, 'oversize: scaled to fit width, aspect kept')
}

// ── Relative: shifts the box but siblings keep its slot ──────────────────────
{
  const r = solve(inline([
    box(src(20, 20), { position: 'relative', offset: { left: 5, top: 3 } }),
    box(src(20, 20)),
  ]))
  rect(r[0], 5, 3, 20, 20, 'relative: box nudged by offset')
  rect(r[1], 20, 0, 20, 20, 'relative: sibling still reserves the original slot')
}

// ── Absolute: out of flow, pinned to the frame (root CB) ─────────────────────
{
  const r = solve(inline([
    box(src(20, 20)),
    box(src(10, 10), { position: 'absolute', offset: { right: 0, bottom: 0 } }),
  ]), 100, 100)
  rect(r[0], 0, 0, 20, 20, 'absolute: flow sibling unaffected')
  rect(r[1], 90, 90, 10, 10, 'absolute: pinned to bottom-right of the frame')
}

// ── Absolute pins to the nearest positioned ancestor, not the frame ──────────
{
  const r = solve(
    block([
      block([box(src(10, 10), { position: 'absolute', offset: { left: 0, top: 0 } })],
            { position: 'relative', padding: 25 }),
    ]),
    100, 100,
  )
  // The relative block sizes to its padding (50×50) at origin; the absolute pins to it.
  rect(r[0], 0, 0, 10, 10, 'nested absolute: pinned to the positioned ancestor origin')
}

// ── A pending (zero-size) source yields no rect ──────────────────────────────
{
  const r = solve(inline([box(src(0, 0)), box(src(10, 10))]))
  ok(!r[0] || r[0].w === 0, 'pending: zero-size box has no positive rect')
  rect(r[1], 0, 0, 10, 10, 'pending: a ready sibling still lays out at origin')
}

// ── rectToMatrix: full-frame rect is identity in clip space ──────────────────
{
  const m = rectToMatrix({ x: 0, y: 0, w: 100, h: 100 }, { width: 100, height: 100 })
  // scale 1, translate 0 → identity.
  ok(near(m[0], 1) && near(m[4], 1) && near(m[6], 0) && near(m[7], 0), 'matrix: full frame → identity')
}
{
  // Top-left quarter: centre design (25,25) → clip (-0.5, +0.5), scale 0.5.
  const m = rectToMatrix({ x: 0, y: 0, w: 50, h: 50 }, { width: 100, height: 100 })
  ok(near(m[0], 0.5) && near(m[4], 0.5), 'matrix: half-size scale')
  ok(near(m[6], -0.5) && near(m[7], 0.5), 'matrix: top-left quarter centre maps up-left (y flipped)')
}

// ── rectToMatrix: paint-time rotate/scale about the box centre ───────────────
const apply = (m, x, y) => [m[0] * x + m[3] * y + m[6], m[1] * x + m[4] * y + m[7]]
{
  // scale 0.5 about the centre: same centre, quarter size.
  const m = rectToMatrix({ x: 0, y: 0, w: 50, h: 50 }, { width: 100, height: 100 }, 0, 0.5)
  ok(near(m[0], 0.25) && near(m[4], 0.25), 'matrix scale: shrinks about the centre')
  ok(near(m[6], -0.5) && near(m[7], 0.5), 'matrix scale: centre stays put')
}
{
  // per-axis scale: [2, 1] doubles width only.
  const m = rectToMatrix({ x: 0, y: 0, w: 50, h: 50 }, { width: 100, height: 100 }, 0, [2, 1])
  ok(near(m[0], 1) && near(m[4], 0.5), 'matrix scale: [sx, sy] per axis')
}
{
  // 90° CCW about the centre of a centred square box: the quad's +x corner lands up.
  const m = rectToMatrix({ x: 25, y: 25, w: 50, h: 50 }, { width: 100, height: 100 }, Math.PI / 2)
  const [px, py] = apply(m, 1, 0)
  ok(near(px, 0) && near(py, 0.5), 'matrix rotate: 90° sends +x to +y (counter-clockwise)')
}
{
  // Non-square frame: rotation composes in pixel space, so the box keeps its shape —
  // a square's rotated +x extent lands at 25px up = 0.5 clip on a 100px-tall frame.
  const m = rectToMatrix({ x: 75, y: 25, w: 50, h: 50 }, { width: 200, height: 100 }, Math.PI / 2)
  const [px, py] = apply(m, 1, 0)
  ok(near(px, 0) && near(py, 0.5), 'matrix rotate: conformal on a non-square frame')
}
{
  // rotate 0 / scale 1 is exactly the fast path.
  const a = rectToMatrix({ x: 10, y: 20, w: 30, h: 40 }, { width: 100, height: 100 })
  const b = rectToMatrix({ x: 10, y: 20, w: 30, h: 40 }, { width: 100, height: 100 }, 0, 1)
  ok([...a].every((v, i) => near(v, b[i])), 'matrix: defaults match the untransformed path')
}

// ── fitRect: contain letterboxes, fill stretches, cover keeps the box ────────
{
  // A 2:1 source in a 1:1 box, contain → full width, half height, centred vertically.
  const f = fitRect({ x: 0, y: 0, w: 100, h: 100 }, 2, 'contain')
  rect(f, 0, 25, 100, 50, 'fit: contain letterboxes a wide source')
  const g = fitRect({ x: 0, y: 0, w: 100, h: 100 }, 2, 'fill')
  rect(g, 0, 0, 100, 100, 'fit: fill uses the whole box')
  const c = fitRect({ x: 0, y: 0, w: 100, h: 100 }, 2, 'cover')
  rect(c, 0, 0, 100, 100, 'fit: cover keeps the whole box (crop is via UV)')
}

// ── coverUV: crops the overflowing axis, centred ─────────────────────────────
{
  const u = coverUV({ w: 100, h: 100 }, 2)   // wide source → trim width to half
  ok(near(u[0], 0.25) && near(u[1], 0) && near(u[2], 0.5) && near(u[3], 1), 'coverUV: wide source trims width')
  const v = coverUV({ w: 100, h: 100 }, 0.5) // tall source → trim height to half
  ok(near(v[0], 0) && near(v[1], 0.25) && near(v[2], 1) && near(v[3], 0.5), 'coverUV: tall source trims height')
  const w = coverUV({ w: 100, h: 100 }, 1)   // matching aspect → identity
  ok(near(w[0], 0) && near(w[2], 1) && near(w[3], 1), 'coverUV: matching aspect is identity')
}

// ── margin: adds space around a box in flow ──────────────────────────────────
{
  const r = solve(inline([box(src(20, 20), { margin: 10 }), box(src(20, 20))]))
  rect(r[0], 10, 10, 20, 20, 'margin: box inset by its own margin')
  // box0 occupies outer [0..40]; the unmargined sibling starts at 40, at the line top (y=0).
  rect(r[1], 40, 0, 20, 20, 'margin: sibling clears the full outer width (10+20+10)')
}
{
  const r = solve(block([box(src(20, 20), { margin: { top: 5, left: 8 } }), box(src(20, 20))]))
  rect(r[0], 8, 5, 20, 20, 'margin: per-side top/left')
  rect(r[1], 0, 25, 20, 20, 'margin: next child clears top margin + height (5+20)')
}

// ── align: cross-axis placement of items ─────────────────────────────────────
{
  const r = solve(inline([box(src(20, 40)), box(src(20, 20))], { align: 'center' }))
  rect(r[0], 0, 0, 20, 40, 'align: tall item sets the line height')
  rect(r[1], 20, 10, 20, 20, 'align center: short item centred in the line')
}
{
  const r = solve(block([box(src(20, 20))], { align: 'end', width: 100 }))
  rect(r[0], 80, 0, 20, 20, 'align end: child pushed to the far edge')
}

// ── justify: main-axis distribution ──────────────────────────────────────────
{
  const r = solve(inline([box(src(20, 20))], { justify: 'end' }), 100, 100)
  rect(r[0], 80, 0, 20, 20, 'justify end: item pushed to the line end')
}
{
  const r = solve(inline([box(src(20, 20)), box(src(20, 20))], { justify: 'between' }), 100, 100)
  rect(r[0], 0, 0, 20, 20, 'justify between: first item at the start')
  rect(r[1], 80, 0, 20, 20, 'justify between: last item at the end')
}

// ── scroll: content taller than the frame pans; clamps to bounds ─────────────
{
  const tree = block([box(src(100, 60)), box(src(100, 60))]) // content height 120 in a 100 frame
  const flat = solveLayout(tree, { width: 100, height: 100 }, measure, {}, { x: 0, y: 0 })
  ok(near(flat.content.height, 120), 'scroll: content height measured past the frame')
  ok(near(flat.scrollMax.y, 20), 'scroll: max scroll is content − viewport (120−100)')

  const r = solveScroll(tree, { y: 20 })
  rect(r[0], 0, -20, 100, 60, 'scroll: first box shifted up by the scroll')
  rect(r[1], 0, 40, 100, 60, 'scroll: second box follows')

  const clamped = solveLayout(tree, { width: 100, height: 100 }, measure, {}, { y: 999 })
  ok(near(clamped.scroll.y, 20), 'scroll: overshoot clamps to max')
}

// ── fixed: pinned to the viewport, unaffected by scroll ──────────────────────
{
  const tree = block([
    box(src(100, 60)),
    box(src(100, 60)),
    box(src(10, 10), { position: 'fixed', offset: { top: 0, left: 0 } }),
  ])
  const r = solveScroll(tree, { y: 20 })
  rect(r[0], 0, -20, 100, 60, 'fixed: flow content scrolls')
  rect(r[2], 0, 0, 10, 10, 'fixed: pinned box stays put while content scrolls')
}

console.log('')
if (failed) { console.error(`${failed} test(s) failed.`); process.exit(1) }
console.log('Layout: all flow tests passed.')
