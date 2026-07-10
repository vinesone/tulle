/**
 * Scope — a bag of teardown functions.
 *
 * Every resource Tulle acquires (a GPU program, a DOM listener, a timer)
 * registers its own undo at the moment it's created. Disposing the scope runs
 * them in reverse, so nothing has to remember what it allocated.
 *
 * This is the whole reason `destroy()` is optional: Tulle owns one scope, and
 * the render loop disposes it automatically when the canvas leaves the DOM.
 *
 *   const scope = new Scope()
 *   scope.listen(canvas, 'pointermove', onMove)   // auto-removed
 *   scope.own(effect)                             // .destroy() called
 *   scope.add(() => clearInterval(id))            // arbitrary undo
 *   scope.dispose()
 */
export class Scope {
  /** @type {Array<() => void>} */
  #disposers = []
  #disposed = false

  /** True once dispose() has run. Adding to a disposed scope runs the disposer immediately. */
  get disposed() { return this.#disposed }

  /**
   * Register a teardown function.
   * @param {() => void} disposer
   * @returns {() => void} the same function, for convenience
   */
  add(disposer) {
    // Late registration on a dead scope would leak. Run it now instead.
    if (this.#disposed) { disposer(); return disposer }
    this.#disposers.push(disposer)
    return disposer
  }

  /**
   * Take ownership of anything with a destroy() method.
   * @template {{ destroy(): void }} T
   * @param {T} resource
   * @returns {T}
   */
  own(resource) {
    this.add(() => resource.destroy())
    return resource
  }

  /**
   * Add a DOM listener that removes itself on dispose.
   * @param {EventTarget} target
   * @param {string} type
   * @param {EventListenerOrEventListenerObject} handler
   * @param {boolean|AddEventListenerOptions} [options]
   */
  listen(target, type, handler, options) {
    target.addEventListener(type, handler, options)
    this.add(() => target.removeEventListener(type, handler, options))
  }

  /**
   * Run every disposer, most-recent first, then empty the scope.
   * Idempotent. A throwing disposer never prevents the others from running.
   */
  dispose() {
    if (this.#disposed) return
    this.#disposed = true

    // Reverse order: resources are torn down before whatever they depend on.
    for (let i = this.#disposers.length - 1; i >= 0; i--) {
      try {
        this.#disposers[i]()
      } catch (err) {
        console.error('Tulle: a disposer threw during teardown —', err)
      }
    }
    this.#disposers.length = 0
  }
}
