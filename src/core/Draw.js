/**
 * Draw — a canvas source you paint with a callback, re-run every rendered frame.
 *
 * Canvas 2D is already a complete drawing API, and any canvas is already a Tulle
 * source — what's missing is only the lifecycle around it: create the surface,
 * size it, redraw it once per frame, tear it down. Draw wraps exactly that, the
 * way Text wraps type and Clip wraps a <video>. The core learns nothing; a Draw
 * is just a source (`texSource`) with an `advance()` the render loop already
 * calls on every source that has one.
 *
 *   const scene = tulle.draw((ctx, { time, width, height }) => {
 *     ctx.clearRect(0, 0, width, height)
 *     ctx.arc(width / 2, height / 2, 50 + Math.sin(time) * 20, 0, 7)
 *     ctx.fill()
 *   })
 *
 *   tulle.layout(block([scene, title]))
 *
 * Because it is ticked by the render loop (never a wall clock or its own rAF),
 * a Draw renders identically in a live preview and a deterministic renderAt()
 * export — the same rule Clip's cues follow.
 */

export class Draw {
  #canvas
  #ctx
  #fn
  #destroyed = false
  #warned = false

  /**
   * @param {(ctx: CanvasRenderingContext2D, frame: object) => void} fn — painter,
   *   called once per rendered frame with the 2D context and the frame context
   *   (plus this surface's `width`/`height`).
   * @param {{ width: number, height: number }} options — surface size in px.
   *   `tulle.draw()` fills these from the canvas; the standalone form requires them.
   */
  constructor(fn, { width, height } = {}) {
    if (typeof fn !== 'function')
      throw new Error('Draw: the first argument must be a painter function (ctx, frame) => void.')
    if (!(width > 0) || !(height > 0))
      throw new Error('Draw: options.width and options.height are required (px).')
    this.#fn = fn
    this.#canvas = makeCanvas(width, height)
    this.#ctx = this.#canvas.getContext('2d')
  }

  // ── Source contract ─────────────────────────────────────────────────────────

  /** The canvas, a valid texImage2D input — lets a Draw stand in for an image. */
  get texSource() { return this.#canvas }
  /** Escape hatch to the raw surface. */
  get canvas() { return this.#canvas }
  /** Intrinsic width in px — how layout measures this source. */
  get width()  { return this.#canvas.width }
  /** Intrinsic height in px. */
  get height() { return this.#canvas.height }

  /** Resize the surface (clears it, as canvas resizing does). */
  resize(width, height) {
    this.#canvas.width  = Math.max(1, Math.round(width))
    this.#canvas.height = Math.max(1, Math.round(height))
    return this
  }

  /** Swap the painter; the next frame paints with it. */
  set(fn) {
    if (typeof fn !== 'function') throw new Error('Draw.set: expected a painter function.')
    this.#fn = fn
    return this
  }

  // ── Frame tick ──────────────────────────────────────────────────────────────

  /**
   * Repaint. Called once per rendered frame by Tulle (deduped per render() call,
   * like Clip.advance). A throwing painter is reported once, not per frame.
   * @param {import('./Tulle.js').FrameContext} [frame]
   */
  advance(frame) {
    if (this.#destroyed) return
    try {
      this.#fn(this.#ctx, { ...frame, width: this.#canvas.width, height: this.#canvas.height })
    } catch (err) {
      if (!this.#warned) { this.#warned = true; console.error('Tulle: a Draw painter threw —', err) }
    }
  }

  /** Release the painter and shrink the surface. Idempotent. */
  destroy() {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#fn = null
    this.#canvas.width = this.#canvas.height = 1
  }
}

// ── gradient ─────────────────────────────────────────────────────────────────

let noiseTile = null

/**
 * A dithered linear-gradient canvas — the everyday backdrop source. Plain canvas
 * gradients band visibly on dark scenes at 8 bits per channel; this one blends a
 * low-amplitude noise tile over the ramp (additive, a few least-significant bits)
 * so the banding breaks up. The return value is a canvas: drop it straight into a
 * layer or a layout box.
 *
 *   const sky = gradient([[0, '#0b1026'], [1, '#05060f']], { width: W, height: H, angle: 115 })
 *   // stops without offsets spread evenly:
 *   const brand = tulle.gradient(['#ff5470', '#8367c7', '#4cc9f0'])
 *
 * @param {Array<[number, string] | string>} stops — `[offset, color]` pairs
 *   (offset 0..1), or bare colors spread evenly.
 * @param {{ width: number, height: number, angle?: number, dither?: boolean }} options —
 *   size in px (required standalone; `tulle.gradient()` fills them from the canvas).
 *   `angle` is in degrees: 0 sweeps left→right, 90 top→bottom. Default 90.
 * @returns {HTMLCanvasElement}
 */
export function gradient(stops, { width, height, angle = 90, dither = true } = {}) {
  if (!Array.isArray(stops) || stops.length === 0)
    throw new Error('gradient: need at least one stop — a color, or an [offset, color] pair.')
  if (!(width > 0) || !(height > 0))
    throw new Error('gradient: options.width and options.height are required (px).')

  const canvas = makeCanvas(width, height)
  const x = canvas.getContext('2d')

  // The gradient axis runs through the centre; half-length is the extent's
  // projection onto it, so the ramp covers the corners at any angle.
  const a = angle * Math.PI / 180
  const dx = Math.cos(a), dy = Math.sin(a)
  const half = (Math.abs(dx) * width + Math.abs(dy) * height) / 2
  const cx = width / 2, cy = height / 2
  const g = x.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half)

  const n = stops.length
  stops.forEach((stop, i) => {
    const [offset, color] = Array.isArray(stop) ? stop : [n > 1 ? i / (n - 1) : 0, stop]
    g.addColorStop(offset, color)
  })
  x.fillStyle = g
  x.fillRect(0, 0, width, height)

  if (dither) {
    // Additive so it lifts the darks too, where an 'overlay' pass does nothing.
    noiseTile ??= makeNoiseTile()
    x.save()
    x.globalCompositeOperation = 'lighter'
    x.globalAlpha = 0.55
    x.fillStyle = x.createPattern(noiseTile, 'repeat')
    x.fillRect(0, 0, width, height)
    x.restore()
  }
  return canvas
}

/** A 128² grey-noise tile, a few LSBs in amplitude — enough to break banding. */
function makeNoiseTile() {
  const tile = makeCanvas(128, 128)
  const c = tile.getContext('2d')
  const img = c.createImageData(128, 128)
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() * 26
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v
    img.data[i + 3] = 255
  }
  c.putImageData(img, 0, 0)
  return tile
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCanvas(width, height) {
  if (typeof document === 'undefined' || !document.createElement)
    throw new Error('Tulle: no document to create a canvas in.')
  const canvas = document.createElement('canvas')
  canvas.width  = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  return canvas
}
