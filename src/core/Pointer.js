/**
 * Pointer — canvas-relative pointer state, kept live and fed to shaders.
 *
 * Every effect can read the pointer without any wiring:
 *
 *   uniform vec2  u_pointer;      // 0..1, origin bottom-left (matches vUv)
 *   uniform bool  u_pointerDown;
 *
 * Or listen from JavaScript:
 *
 *   tulle.on('pointermove', p => tulle.set('blur', { radius: p.u * 20 }))
 *
 * Coordinates are normalised against the canvas's *displayed* size, so they
 * stay correct when CSS scales the canvas away from its backing resolution.
 * `v` is flipped to match Tulle's y-up UV convention — pointer at the bottom
 * of the canvas gives v = 0, exactly like vUv.
 */
export class Pointer {
  /** Canvas pixels, top-left origin — matches drawImage/getBoundingClientRect. */
  x = 0
  y = 0

  /** Normalised 0..1, bottom-left origin — matches vUv in your shaders. */
  u = 0
  v = 0

  /** True while any button is held. */
  down = false

  /** True while the pointer is over the canvas. */
  inside = false

  /** Bitmask from the last pointer event. */
  buttons = 0

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('./Scope.js').Scope} scope — owns listener removal
   * @param {(type: string, payload: any) => void} emit
   */
  constructor(canvas, scope, emit) {
    const track = event => {
      const rect = canvas.getBoundingClientRect()

      // A zero-sized (display:none) canvas would divide by zero.
      const nx = rect.width  ? (event.clientX - rect.left) / rect.width  : 0
      const ny = rect.height ? (event.clientY - rect.top)  / rect.height : 0

      this.x = nx * canvas.width
      this.y = ny * canvas.height
      this.u = nx
      this.v = 1 - ny // y-up, to match vUv
      this.buttons = event.buttons
    }

    const on = (type, handler, options) => scope.listen(canvas, type, handler, options)

    on('pointermove', e => { track(e); emit('pointermove', this.snapshot()) })

    on('pointerdown', e => {
      track(e)
      this.down = true
      // Capture so a drag that leaves the canvas keeps reporting.
      canvas.setPointerCapture?.(e.pointerId)
      emit('pointerdown', this.snapshot())
    })

    on('pointerup', e => {
      track(e)
      this.down = false
      canvas.releasePointerCapture?.(e.pointerId)
      emit('pointerup', this.snapshot())
    })

    on('pointerenter', e => { track(e); this.inside = true;  emit('pointerenter', this.snapshot()) })

    // Release `down` on leave: without capture, the matching pointerup can
    // land on another element and the pointer would stay stuck down forever.
    on('pointerleave', e => {
      track(e)
      this.inside = false
      this.down = false
      emit('pointerleave', this.snapshot())
    })

    on('click', e => { track(e); emit('click', this.snapshot()) })

    // passive: we never preventDefault, so don't block scrolling.
    on('wheel', e => {
      track(e)
      emit('wheel', { ...this.snapshot(), deltaX: e.deltaX, deltaY: e.deltaY })
    }, { passive: true })
  }

  /** A plain, detached copy — safe to store or pass to a listener. */
  snapshot() {
    const { x, y, u, v, down, inside, buttons } = this
    return { x, y, u, v, down, inside, buttons }
  }
}
