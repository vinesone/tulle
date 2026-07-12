import { Transform } from './Transform.js'

/**
 * Layout — a flow engine that arranges sources into boxes and emits one transform
 * per box.
 *
 * The invariant from docs/composition.md, Part 2: **the renderer never learns what
 * "inline" means.** This module walks a tree of boxes, solves where each lands in a
 * design-space frame (pixels, top-left origin, y-down — like Text's design units),
 * and produces a clip-space `mat3` per leaf that drops straight into the existing
 * `u_transform` path via Tulle's composite layers. Nothing in Renderer or Effect
 * changes; layout is a pure function bolted on above them.
 *
 *   tulle.layout(
 *     block([
 *       clip(video),                       // inline box, flows and wraps
 *       text('Chapter One', { size: 72 }), // inline box, next to it or wrapped
 *       block([ box(a), box(b) ]),         // a block: breaks the line, stacks a/b
 *     ], { gap: 24, padding: 40 })
 *   )
 *
 * The model, deliberately CSS-shaped because that mental model is universal:
 * - a container arranges its children **inline** (left-to-right, wrapping) or as a
 *   **block** (stacked top-to-bottom);
 * - a block-level child breaks the surrounding inline line;
 * - `position` is `static` (flow), `relative` (nudge from the flow slot, siblings
 *   keep the original space), or `absolute` (out of flow, pinned to the nearest
 *   positioned ancestor).
 *
 * Scope of this first cut: inline wrap, block stack, padding, gap, nesting,
 * static/relative/absolute, explicit or intrinsic box sizes, and `contain`/`fill`
 * fit. `cover` fit needs UV cropping (a shader change) and is deferred — it falls
 * back to `contain` for now.
 *
 * The solver is pure (no DOM, no GPU): it takes a `measure(source)` function, so
 * the whole thing is unit-testable with fake sources, the way Text tests
 * layoutLines and Clip tests dueCues.
 */

const EPS = 1e-4

// ── Node builders ─────────────────────────────────────────────────────────────

/**
 * A leaf box wrapping a single source.
 * @param {*} source — anything usable as a layer source (Clip, Text, image, …)
 * @param {BoxOptions} [opts]
 */
export function box(source, opts = {}) {
  return { kind: 'box', source, opts }
}

/** A container whose children flow left-to-right and wrap. */
export function inline(children, opts = {}) {
  return container('inline', children, opts)
}

/** A container whose children stack top-to-bottom, breaking the surrounding line. */
export function block(children, opts = {}) {
  return container('block', children, opts)
}

function container(defaultDisplay, children, opts) {
  return {
    kind: 'container',
    display: opts.display ?? defaultDisplay,
    children: (children ?? []).map(coerce),
    opts,
  }
}

/** A raw source becomes an inline box; an existing node passes through. */
function coerce(child) {
  return child && child.kind ? child : box(child)
}

/** Normalise whatever tulle.layout() was given into a single root node. */
export function coerceRoot(node) {
  if (Array.isArray(node)) return inline(node)
  return coerce(node)
}

// ── Flatten: document-order leaves + subtree ranges ──────────────────────────

/**
 * Depth-first list of leaves in paint order, and — as a side effect — each node's
 * [_start, _end) leaf-index range, used to shift a `relative` subtree as a unit.
 * @param {LayoutNode} root
 * @returns {Array<{ source, effects, blend, opacity, fit, node }>}
 */
export function flattenLeaves(root) {
  const out = []
  walk(root, out)
  return out
}

function walk(node, out) {
  if (node.kind === 'box') {
    node._start = out.length
    const o = node.opts
    out.push({
      source:  node.source,
      effects: o.effects ?? [],
      blend:   o.blend ?? 'over',
      opacity: o.opacity ?? 1,
      fit:     o.fit ?? 'contain',
      // Paint-time transforms about the box centre, CSS-transform-like: they never
      // affect flow. Either may be a function of the frame context.
      rotate:  o.rotate ?? 0,
      scale:   o.scale ?? 1,
      // A fixed box is pinned to the viewport and does NOT move when the layout
      // scrolls — the compositor skips the scroll offset for it.
      fixed:   o.position === 'fixed',
      node,
    })
    node._end = out.length
    return
  }
  node._start = out.length
  for (const child of node.children) walk(child, out)
  node._end = out.length
}

// ── Measure ──────────────────────────────────────────────────────────────────

/** True if the child forces its own line inside an inline container. */
function isBlockLevel(child) {
  return child.opts?.display === 'block' ||
    (child.kind === 'container' && child.display === 'block')
}

/** Resolve a value that may be a function of the frame context (animation). */
function val(v, fctx) { return typeof v === 'function' ? v(fctx) : v }

/** Normalise a margin option (a number, or per-side) to { t, r, b, l }. */
function marginOf(node, fctx) {
  const m = val(node.opts?.margin, fctx)
  if (m == null) return { t: 0, r: 0, b: 0, l: 0 }
  if (typeof m === 'number') return { t: m, r: m, b: m, l: m }
  return { t: m.top ?? 0, r: m.right ?? 0, b: m.bottom ?? 0, l: m.left ?? 0 }
}

/** Offset of a smaller box within `free` slack, by cross-axis alignment. */
function alignOffset(free, align) {
  if (free <= 0) return 0
  if (align === 'center') return free / 2
  if (align === 'end')    return free
  return 0 // 'start'
}

/** Main-axis distribution of `free` slack across `n` items: leading offset + inter-item extra. */
function distribute(free, justify, n) {
  if (free <= 0) return { start: 0, extra: 0 }
  if (justify === 'center')  return { start: free / 2, extra: 0 }
  if (justify === 'end')     return { start: free, extra: 0 }
  if (justify === 'between') return { start: 0, extra: n > 1 ? free / (n - 1) : 0 }
  return { start: 0, extra: 0 } // 'start'
}

/**
 * The size a node needs, given the width available to it. Pure; `ms(source)`
 * returns a source's intrinsic `{ width, height }` in design px. `fctx` is the
 * frame context, so an explicit width/height may be a function of time.
 */
function measureNode(node, availW, ms, fctx) {
  if (node.kind === 'box') return measureBox(node, ms(node.source), availW, fctx)

  const o = node.opts, pad = o.padding ?? 0, gap = o.gap ?? 0
  const inner = Math.max(0, availW - 2 * pad)
  const m = (c, a) => measureNode(c, a, ms, fctx)

  if (node.display === 'block') {
    let cw = 0, ch = 0, n = 0
    for (const c of node.children) {
      if (isOutOfFlow(c)) continue
      const cs = m(c, inner), mg = marginOf(c, fctx)
      cw = Math.max(cw, cs.width + mg.l + mg.r); ch += cs.height + mg.t + mg.b; n++
    }
    if (n > 1) ch += gap * (n - 1)
    return { width: o.width ?? cw + 2 * pad, height: o.height ?? ch + 2 * pad }
  }

  const f = flowInline(node.children, inner, gap, m, fctx)
  return { width: o.width ?? f.width + 2 * pad, height: o.height ?? f.height + 2 * pad }
}

/** A leaf's size: explicit, else intrinsic, scaled down to fit the available width. */
function measureBox(node, is, availW, fctx) {
  const o = node.opts
  const ow = val(o.width, fctx), oh = val(o.height, fctx)
  let w = ow ?? is.width
  let h = oh ?? is.height
  // Derive a missing dimension from the source aspect when only one is given.
  if (ow != null && oh == null && is.width > 0) h = ow * (is.height / is.width)
  if (oh != null && ow == null && is.height > 0) w = oh * (is.width / is.height)
  if (!(w > 0) || !(h > 0)) return { width: 0, height: 0 } // pending (e.g. a Clip pre-ready)
  if (availW > 0 && w > availW) { h *= availW / w; w = availW } // shrink to fit, keep aspect
  return { width: w, height: h }
}

/**
 * Break inline children into lines within `inner` width. Each item carries its
 * content size, margin, and outer (margin-inclusive) extents; each line carries its
 * main (width) and cross (height) size. Shared by measure and place so they never
 * disagree about where a line wraps.
 */
function flowInline(children, inner, gap, m, fctx) {
  const lines = []
  let cur = { items: [], main: 0, cross: 0 }
  const flush = () => { if (cur.items.length) { lines.push(cur); cur = { items: [], main: 0, cross: 0 } } }

  for (const child of children) {
    if (isOutOfFlow(child)) continue // absolute/fixed leave the flow
    const size = m(child, inner), mg = marginOf(child, fctx)
    const outerW = size.width + mg.l + mg.r, outerH = size.height + mg.t + mg.b
    const item = { child, size, mg, outerW, outerH }

    if (isBlockLevel(child)) { // its own line, before and after
      flush()
      lines.push({ items: [item], main: outerW, cross: outerH })
      continue
    }
    const extended = cur.main === 0 ? outerW : cur.main + gap + outerW
    if (cur.main > 0 && extended > inner + EPS) { // wrap
      flush()
      cur.main = outerW; cur.cross = outerH; cur.items.push(item)
    } else {
      cur.main = extended; cur.cross = Math.max(cur.cross, outerH); cur.items.push(item)
    }
  }
  flush()

  let width = 0, height = 0
  for (const line of lines) width = Math.max(width, line.main)
  if (lines.length) height = lines.reduce((s, l) => s + l.cross, 0) + gap * (lines.length - 1)
  return { lines, width, height }
}

// ── Place ─────────────────────────────────────────────────────────────────────

function positionOf(node) { return node.opts?.position ?? 'static' }

/** absolute and fixed are both removed from flow; the difference is the CB and scroll. */
function isOutOfFlow(node) { const p = positionOf(node); return p === 'absolute' || p === 'fixed' }

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

/** Place a node's subtree at (x, y); writes leaf rects into sc.rects by index. */
function place(node, x, y, availW, sc, cb) {
  if (node.kind === 'box') {
    const sz = measureNode(node, availW, sc.ms, sc.fctx)
    sc.rects[node._start] = { x, y, w: sz.width, h: sz.height }
    return
  }

  const o = node.opts, pad = o.padding ?? 0, gap = o.gap ?? 0
  const inner = Math.max(0, availW - 2 * pad)
  const align = o.align ?? 'start', justify = o.justify ?? 'start'
  const m = (c, a) => measureNode(c, a, sc.ms, sc.fctx)

  // Out-of-flow children resolve later: absolute against this CB, fixed against the viewport.
  for (const child of node.children)
    if (isOutOfFlow(child)) sc.deferred.push({ node: child, cb: positionOf(child) === 'fixed' ? sc.root : cb })

  if (node.display === 'block') {
    // main axis = vertical, cross = horizontal
    const flow = node.children.filter(c => !isOutOfFlow(c))
    const items = flow.map(child => {
      const cs = m(child, inner), mg = marginOf(child, sc.fctx)
      return { child, cs, mg, outerH: cs.height + mg.t + mg.b }
    })
    let contentH = items.reduce((s, it) => s + it.outerH, 0)
    if (items.length > 1) contentH += gap * (items.length - 1)
    const innerH = o.height != null ? val(o.height, sc.fctx) - 2 * pad : contentH
    const { start, extra } = distribute(innerH - contentH, justify, items.length)

    let cy = y + pad + start
    for (const { child, cs, mg, outerH } of items) {
      const cx = x + pad + alignOffset(inner - (cs.width + mg.l + mg.r), align)
      placeChild(child, cx + mg.l, cy + mg.t, inner, sc, cb)
      cy += outerH + gap + extra
    }
    return
  }

  // inline: main axis = horizontal (per line), cross = vertical (within line height)
  const f = flowInline(node.children, inner, gap, m, sc.fctx)
  let cy = y + pad
  for (const line of f.lines) {
    const { start, extra } = distribute(inner - line.main, justify, line.items.length)
    let cx = x + pad + start
    for (const { child, size, mg, outerW, outerH } of line.items) {
      const cyi = cy + alignOffset(line.cross - outerH, align)
      placeChild(child, cx + mg.l, cyi + mg.t, inner, sc, cb)
      cx += outerW + gap + extra
    }
    cy += line.cross + gap
  }
}

/** Place one flow child, honouring relative offsets; defer absolutes to their CB. */
function placeChild(child, x, y, availW, sc, cb) {
  const pos = positionOf(child)
  if (isOutOfFlow(child)) { sc.deferred.push({ node: child, cb: pos === 'fixed' ? sc.root : cb }); return }

  const sz = measureNode(child, availW, sc.ms, sc.fctx)
  const ownCB = pos !== 'static' ? { x, y, w: sz.width, h: sz.height } : cb
  place(child, x, y, availW, sc, ownCB)

  if (pos === 'relative') {
    const { dx, dy } = offsetDelta(child.opts.offset, sc.fctx)
    shiftSubtree(child, dx, dy, sc)
  }
}

/** Resolve an absolute node against its containing block. */
function placeAbsolute(entry, sc) {
  const { node, cb } = entry
  const sz = measureNode(node, cb.w, sc.ms, sc.fctx)
  const o = node.opts.offset ?? {}
  const left = val(o.left, sc.fctx), right = val(o.right, sc.fctx)
  const top  = val(o.top,  sc.fctx), bottom = val(o.bottom, sc.fctx)
  const w = sz.width, h = sz.height
  const x = cb.x + (left != null ? left : right != null ? cb.w - w - right : 0)
  const y = cb.y + (top  != null ? top  : bottom != null ? cb.h - h - bottom : 0)
  place(node, x, y, sz.width || cb.w, sc, { x, y, w, h })
}

/** Shift every leaf under a node by (dx, dy) — a relative offset moves the subtree. */
function shiftSubtree(node, dx, dy, sc) {
  if (dx === 0 && dy === 0) return
  for (let i = node._start; i < node._end; i++) {
    const r = sc.rects[i]
    if (r) { r.x += dx; r.y += dy }
  }
}

/** left/top move positively; right/bottom move the opposite way. Each may be a function of time. */
function offsetDelta(offset = {}, fctx) {
  const left = val(offset.left, fctx), right = val(offset.right, fctx)
  const top  = val(offset.top,  fctx), bottom = val(offset.bottom, fctx)
  return {
    dx: left != null ? left : right  != null ? -right  : 0,
    dy: top  != null ? top  : bottom != null ? -bottom : 0,
  }
}

// ── Solve ─────────────────────────────────────────────────────────────────────

/**
 * Solve a layout tree into one rect per leaf, in document (paint) order.
 * @param {LayoutNode} root
 * @param {{ width: number, height: number }} frame — the design-space frame
 * @param {(source: *) => { width: number, height: number }} measureSource
 * @param {object} [fctx] — the frame context, so offsets/sizes may be functions of time
 * @param {{ x?: number, y?: number }} [scroll] — viewport scroll in design px; non-fixed
 *   boxes shift by it, clamped to the content bounds.
 * @returns {{ order, rects, content: {width,height}, scrollMax: {x,y}, scroll: {x,y} }}
 */
export function solveLayout(root, frame, measureSource, fctx = {}, scroll = {}) {
  const order = flattenLeaves(root) // sets _start/_end on every node
  const viewport = { x: 0, y: 0, w: frame.width, h: frame.height }
  const sc = { rects: new Array(order.length), deferred: [], ms: measureSource, fctx, root: viewport }
  place(root, 0, 0, frame.width, sc, viewport)
  for (const entry of sc.deferred) placeAbsolute(entry, sc)

  // Content bounds → how far the layout can scroll.
  let maxX = 0, maxY = 0
  for (const r of sc.rects) if (r) { if (r.x + r.w > maxX) maxX = r.x + r.w; if (r.y + r.h > maxY) maxY = r.y + r.h }
  const scrollMax = { x: Math.max(0, maxX - frame.width), y: Math.max(0, maxY - frame.height) }
  const sx = clamp(scroll.x ?? 0, 0, scrollMax.x), sy = clamp(scroll.y ?? 0, 0, scrollMax.y)

  // Shift everything by the scroll, except fixed boxes (pinned to the viewport).
  if (sx || sy) for (let i = 0; i < order.length; i++) {
    const r = sc.rects[i]
    if (r && !order[i].fixed) { r.x -= sx; r.y -= sy }
  }

  return { order, rects: sc.rects, content: { width: maxX, height: maxY }, scrollMax, scroll: { x: sx, y: sy } }
}

// ── Design space → clip space ────────────────────────────────────────────────

/** A degenerate transform that draws nothing — used for a pending (0-size) box. */
export const HIDDEN = new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 1])

/**
 * Map the fullscreen quad onto a design-space rect, in clip space. Design space is
 * top-left origin, y-down; clip space is centre origin, y-up — hence the y flip.
 *
 * `rotate` (radians, counter-clockwise, like Transform.rotate) and `scale` (a
 * number, or [sx, sy]) apply about the rect's centre, after layout — CSS-transform
 * semantics: the box keeps its flow slot, only the paint moves. Rotation is
 * composed in pixel space, where units are isotropic, so a rotated box keeps its
 * shape on a non-square frame.
 *
 * @param {{x,y,w,h}} rect @param {{width,height}} frame
 * @param {number} [rotate] @param {number|[number, number]} [scale]
 * @returns {Float32Array} column-major mat3
 */
export function rectToMatrix(rect, frame, rotate = 0, scale = 1) {
  const { width: W, height: H } = frame
  if (!rotate && scale === 1) {
    const cx = (rect.x + rect.w / 2) / W * 2 - 1
    const cy = 1 - (rect.y + rect.h / 2) / H * 2
    return Transform.identity().translate(cx, cy).scale(rect.w / W, rect.h / H).matrix()
  }
  const [sx, sy] = Array.isArray(scale) ? scale : [scale, scale]
  const cx = rect.x + rect.w / 2 - W / 2
  const cy = H / 2 - (rect.y + rect.h / 2)
  return Transform.identity()
    .scale(2 / W, 2 / H)           // pixels → clip space
    .translate(cx, cy)             // centre the box (y-up pixels, frame-centre origin)
    .rotate(rotate)
    .scale(sx * rect.w / 2, sy * rect.h / 2) // quad (±1) → scaled box, in pixels
    .matrix()
}

/**
 * Inset a source of aspect `srcAspect` inside its box per the fit rule.
 * `fill` stretches to the box; `contain` letterboxes (shrinks the box to the source
 * aspect). `cover` keeps the full box and crops instead — see coverUV — so here it
 * returns the box unchanged. Aspect 0 (unknown) always fills.
 * @param {{x,y,w,h}} box @param {number} srcAspect @param {string} fit
 * @returns {{x,y,w,h}}
 */
export function fitRect(box, srcAspect, fit) {
  if (fit !== 'contain' || !(srcAspect > 0) || !(box.w > 0) || !(box.h > 0)) return box
  const boxAspect = box.w / box.h
  let w = box.w, h = box.h
  if (srcAspect > boxAspect) h = box.w / srcAspect // wider than box → limit by width
  else w = box.h * srcAspect                       // taller → limit by height
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h }
}

/**
 * The UV sub-rect for `cover`: the box keeps its full size and a centred crop of
 * the source fills it. Returns `[offsetX, offsetY, scaleX, scaleY]` in 0..1, the
 * identity `[0,0,1,1]` meaning no crop. The overflowing axis is the one trimmed.
 * @param {{w,h}} box @param {number} srcAspect
 * @returns {number[]}
 */
export function coverUV(box, srcAspect) {
  if (!(srcAspect > 0) || !(box.w > 0) || !(box.h > 0)) return [0, 0, 1, 1]
  const boxAspect = box.w / box.h
  if (srcAspect > boxAspect) { const f = boxAspect / srcAspect; return [(1 - f) / 2, 0, f, 1] } // trim width
  const f = srcAspect / boxAspect; return [0, (1 - f) / 2, 1, f] // trim height
}

// ── Source intrinsic size ─────────────────────────────────────────────────────

/**
 * A source's intrinsic size in design px, covering every source kind: a Clip or
 * Text (width/height getters), a raw <video> (videoWidth), an image
 * (naturalWidth), a canvas (width). Zero when not yet known (a Clip pre-ready).
 * @param {*} s
 * @returns {{ width: number, height: number }}
 */
export function intrinsicSize(s) {
  if (!s) return { width: 0, height: 0 }
  const width  = s.videoWidth  || s.naturalWidth  || s.width  || 0
  const height = s.videoHeight || s.naturalHeight || s.height || 0
  return { width, height }
}

/** A source's aspect ratio, or 0 if unknown. */
export function aspectOf(s) {
  const { width, height } = intrinsicSize(s)
  return height > 0 ? width / height : 0
}
