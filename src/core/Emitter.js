/**
 * Emitter — a minimal typed event bus.
 *
 * `on()` returns its own unsubscribe function, so a listener is always
 * cancellable without having to hold on to the original handler reference.
 *
 *   const off = tulle.on('pointermove', p => console.log(p.u, p.v))
 *   off()
 */
export class Emitter {
  /** @type {Map<string, Set<Function>>} */
  #handlers = new Map()

  /**
   * @param {string} type
   * @param {Function} handler
   * @returns {() => void} unsubscribe
   */
  on(type, handler) {
    if (typeof handler !== 'function')
      throw new TypeError(`Tulle.on("${type}"): handler must be a function.`)

    let set = this.#handlers.get(type)
    if (!set) this.#handlers.set(type, (set = new Set()))
    set.add(handler)

    return () => this.off(type, handler)
  }

  /**
   * Listen once, then auto-unsubscribe.
   * @param {string} type
   * @param {Function} handler
   * @returns {() => void} unsubscribe
   */
  once(type, handler) {
    const off = this.on(type, (...args) => { off(); handler(...args) })
    return off
  }

  /**
   * Remove one handler, or every handler for a type if none is given.
   * @param {string} type
   * @param {Function} [handler]
   */
  off(type, handler) {
    if (!handler) { this.#handlers.delete(type); return }
    const set = this.#handlers.get(type)
    if (!set) return
    set.delete(handler)
    if (set.size === 0) this.#handlers.delete(type)
  }

  /**
   * Fire an event. A throwing handler is reported but never stops the others,
   * and never escapes into the render loop.
   * @param {string} type
   * @param {*} [payload]
   */
  emit(type, payload) {
    const set = this.#handlers.get(type)
    if (!set) return

    // Copy: a handler may unsubscribe itself (or others) mid-emit.
    for (const handler of [...set]) {
      try {
        handler(payload)
      } catch (err) {
        console.error(`Tulle: listener for "${type}" threw —`, err)
      }
    }
  }

  /** @param {string} type */
  listenerCount(type) { return this.#handlers.get(type)?.size ?? 0 }

  clear() { this.#handlers.clear() }
}
