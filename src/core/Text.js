/**
 * Text — a styled block of type, rasterised into a 2D canvas that any layer can
 * use as its source.
 *
 * Tulle composites *sources*, and a Text is just a source: it typesets into a
 * full-frame canvas and hands that canvas to the renderer. Because it is nothing
 * more than a source, it inherits the entire compositor for free — blur a title,
 * screen it over video, place it with a Transform, fade its opacity. The core
 * never learns what a glyph is.
 *
 *   const title = new Text('Hello', { width: 640, height: 420, size: 72 })
 *   tulle.composite([
 *     { source: video },
 *     { source: title, blend: 'over' },
 *   ]).start(() => tulle.render())
 *
 *   title.set('Goodbye')                 // re-typeset; next frame shows it
 *   title.update({ color: '#ff5470' })   // restyle live
 *
 * Why a full-frame canvas and not a tight crop around the letters? A layer's
 * source is stretched across the frame before its Transform applies, so a source
 * whose aspect ratio differs from the frame's would distort. Sizing the canvas
 * to the composition sidesteps that, and it means text is positioned *within the
 * frame* (align / vAlign / padding) — the same mental model as laying out a page,
 * which is where composable layout will build from.
 *
 * Rendering happens only when something changes (construction, set, update,
 * resize), not every frame. The renderer re-uploads the canvas each frame, but
 * that is the same cost as a video frame and does no extra typesetting.
 */

/** Style + geometry defaults. Geometry (width/height/dpr) is usually supplied by Tulle.text(). */
export const TEXT_DEFAULTS = {
  // Geometry — the design resolution the text is typeset at.
  width:  1280,
  height: 720,
  dpr:    undefined, // resolved to devicePixelRatio (capped) at construction

  // Type.
  font:          'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  size:          48,          // px, in design units
  weight:        400,         // 100..900, or 'bold'
  italic:        false,
  color:         '#ffffff',
  lineHeight:    1.25,        // multiple of size
  letterSpacing: 0,           // px, in design units

  // Placement within the frame.
  align:   'center',          // 'left' | 'center' | 'right'
  vAlign:  'middle',          // 'top'  | 'middle' | 'bottom'
  padding: 0,                 // px, in design units, all four sides
  maxWidth: 0.9,              // fraction of frame width the block may fill before wrapping

  // Optional decoration.
  background: null,           // CSS colour filling the whole surface, or null for transparent
  shadow:     null,           // { color, blur?, x?, y? } — legibility over busy video
  stroke:     null,           // { color, width } — outline drawn under the fill
}

/**
 * Break text into display lines: honour explicit newlines, then greedily wrap
 * each paragraph to maxWidth. Pure — it takes a measure function rather than a
 * canvas, so it is unit-testable without a GPU or a DOM.
 *
 * A single word wider than maxWidth is left on its own line rather than broken
 * mid-character; character-level breaking is a later concern.
 *
 * @param {string} text
 * @param {(s: string) => number} measure — width of a string in the current font
 * @param {number} maxWidth — wrap width; <= 0 or non-finite disables wrapping
 * @returns {string[]}
 */
export function layoutLines(text, measure, maxWidth) {
  const paragraphs = String(text).split('\n')
  if (!(maxWidth > 0) || !Number.isFinite(maxWidth)) return paragraphs

  const lines = []
  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter(Boolean)
    if (words.length === 0) { lines.push(''); continue } // preserve blank lines

    let line = words[0]
    for (let i = 1; i < words.length; i++) {
      const candidate = `${line} ${words[i]}`
      if (measure(candidate) <= maxWidth) line = candidate
      else { lines.push(line); line = words[i] }
    }
    lines.push(line)
  }
  return lines
}

export class Text {
  #text
  #opts
  #canvas
  #ctx
  #dpr

  /**
   * @param {string} text — may contain '\n' for hard line breaks
   * @param {Partial<typeof TEXT_DEFAULTS>} [options]
   */
  constructor(text = '', options = {}) {
    this.#text = String(text)
    this.#opts = { ...TEXT_DEFAULTS, ...options }

    this.#canvas = makeCanvas()
    this.#ctx    = this.#canvas.getContext('2d')
    if (!this.#ctx) throw new Error('Tulle.Text: could not get a 2D context.')

    this.#resize()
    this.#render()
  }

  /** The raster this Text typesets into — a valid layer source and texImage2D input. */
  get canvas()    { return this.#canvas }
  /** The renderer reads this to upload a source; lets a Text stand in for an image. */
  get texSource() { return this.#canvas }

  get text()   { return this.#text }
  /** Design-space frame width (not the DPR-scaled backing store). */
  get width()  { return this.#opts.width }
  get height() { return this.#opts.height }
  /** A detached copy of the live style. */
  get style()  { return { ...this.#opts } }

  /**
   * Replace the text and re-typeset. Cheap; the GPU picks it up next frame.
   * @param {string} text
   */
  set(text) {
    this.#text = String(text)
    this.#render()
    return this
  }

  /**
   * Merge style (and optionally geometry) changes, then re-typeset.
   * Changing width/height/dpr resizes the backing store.
   * @param {Partial<typeof TEXT_DEFAULTS>} options
   */
  update(options = {}) {
    const resizing =
      ('width'  in options && options.width  !== this.#opts.width)  ||
      ('height' in options && options.height !== this.#opts.height) ||
      ('dpr'    in options && options.dpr    !== this.#opts.dpr)

    this.#opts = { ...this.#opts, ...options }
    if (resizing) this.#resize()
    this.#render()
    return this
  }

  /**
   * Resize the design frame (typically to match a resized output canvas).
   * @param {number} width @param {number} height @param {number} [dpr]
   */
  resize(width, height, dpr) {
    this.#opts.width  = width
    this.#opts.height = height
    if (dpr !== undefined) this.#opts.dpr = dpr
    this.#resize()
    this.#render()
    return this
  }

  /**
   * Measure the current block without repainting. Useful for aligning other
   * layers to the text, and the seed of a future layout pass.
   * @returns {{ lines: string[], lineHeight: number, blockWidth: number, blockHeight: number }}
   */
  measure() {
    const o = this.#opts
    this.#applyFont()
    const avail = this.#available()
    const lines = layoutLines(this.#text, s => this.#ctx.measureText(s).width, avail)
    const lineHeight = o.size * o.lineHeight
    let blockWidth = 0
    for (const line of lines) blockWidth = Math.max(blockWidth, this.#ctx.measureText(line).width)
    return { lines, lineHeight, blockWidth, blockHeight: lines.length * lineHeight }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /** Size the backing store to design × dpr and scale the context to design units. */
  #resize() {
    const o = this.#opts
    this.#dpr = clampDpr(o.dpr)
    this.#canvas.width  = Math.max(1, Math.round(o.width  * this.#dpr))
    this.#canvas.height = Math.max(1, Math.round(o.height * this.#dpr))
  }

  /** Build the CSS font shorthand from the current style. */
  #applyFont() {
    const o = this.#opts
    this.#ctx.font = `${o.italic ? 'italic ' : ''}${o.weight} ${o.size}px ${o.font}`
  }

  /** Wrap width in design units: the narrower of the padded frame and maxWidth. */
  #available() {
    const o = this.#opts
    const padded  = o.width - o.padding * 2
    const capped  = o.maxWidth != null ? o.maxWidth * o.width : Infinity
    return Math.min(padded, capped)
  }

  #render() {
    const ctx = this.#ctx
    const o   = this.#opts
    const { width, height } = o

    // Draw in design units regardless of the DPR-scaled backing store.
    ctx.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)

    if (o.background) {
      ctx.fillStyle = o.background
      ctx.fillRect(0, 0, width, height)
    }

    this.#applyFont()
    ctx.textBaseline = 'top'
    ctx.textAlign    = o.align
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${o.letterSpacing}px`

    const lines  = layoutLines(this.#text, s => ctx.measureText(s).width, this.#available())
    const lineH  = o.size * o.lineHeight
    const blockH = lines.length * lineH

    let y = o.padding
    if (o.vAlign === 'middle') y = (height - blockH) / 2
    else if (o.vAlign === 'bottom') y = height - o.padding - blockH

    let x = width / 2
    if (o.align === 'left')  x = o.padding
    else if (o.align === 'right') x = width - o.padding

    if (o.shadow) {
      ctx.shadowColor   = o.shadow.color
      ctx.shadowBlur    = o.shadow.blur ?? 0
      ctx.shadowOffsetX = o.shadow.x ?? 0
      ctx.shadowOffsetY = o.shadow.y ?? 0
    }
    if (o.stroke) {
      ctx.lineJoin  = 'round'
      ctx.lineWidth = o.stroke.width
    }

    for (let i = 0; i < lines.length; i++) {
      const ly = y + i * lineH
      if (o.stroke) { ctx.strokeStyle = o.stroke.color; ctx.strokeText(lines[i], x, ly) }
      ctx.fillStyle = o.color
      ctx.fillText(lines[i], x, ly)
    }

    // Clear shadow so a later manual draw on this context isn't tainted.
    ctx.shadowColor = 'transparent'
    ctx.shadowBlur  = 0
    ctx.shadowOffsetX = 0
    ctx.shadowOffsetY = 0
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** An HTMLCanvasElement in a DOM, else an OffscreenCanvas — both are texImage2D inputs. */
function makeCanvas() {
  if (typeof document !== 'undefined' && document.createElement)
    return document.createElement('canvas')
  if (typeof OffscreenCanvas !== 'undefined')
    return new OffscreenCanvas(1, 1)
  throw new Error('Tulle.Text: no canvas implementation available in this environment.')
}

/** Resolve and cap the device pixel ratio — 2× is plenty for crisp type, 3× just burns memory. */
function clampDpr(dpr) {
  const ambient = (typeof globalThis !== 'undefined' && globalThis.devicePixelRatio) || 1
  const value = dpr ?? ambient
  return Math.max(1, Math.min(value, 2))
}
