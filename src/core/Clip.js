import { Emitter } from './Emitter.js'
import { Scope }   from './Scope.js'

/**
 * Clip — a video source with a lifecycle.
 *
 * Tulle composites *sources*, and a Clip is just a source: it wraps an
 * HTMLVideoElement and hands it to the renderer via `texSource`, exactly the way
 * Text hands over its canvas. Because it is nothing more than a source, it drops
 * into a layer with no special handling anywhere — blur a clip, screen it over
 * another, place it with a Transform.
 *
 * What it adds is a lifecycle. A bare <video> makes you wire up half a dozen
 * native events by hand, each with its own quirks (`timeupdate` throttles to
 * ~4 Hz; `canplay` vs `loadeddata` mean subtly different things). A Clip *is* an
 * Emitter and speaks a small, clean vocabulary instead:
 *
 *   const clip = tulle.clip('film.mp4')
 *   clip.on('ready', ({ width, height }) => layout())   // first frame decodable
 *   clip.on('end',   () => showOutro())
 *   clip.at(2.5, () => showLowerThird())                 // timeline cue
 *   clip.play()
 *
 *   tulle.composite([{ source: clip }]).play()
 *
 * The design goal is a primitive small enough that a *timeline* — sequencing many
 * clips, cutting on a beat — is built on top of Clip, never inside it.
 *
 * Cues are driven by the render loop (see advance()), not the wall clock, so they
 * fire identically in a live preview and a deterministic renderAt() export.
 */

/** readyState: a decodable current frame plus known dimensions. */
const HAVE_CURRENT_DATA = 2

/** Tolerance for float time comparisons — well below a frame at any sane fps. */
const EPS = 1e-4

export class Clip extends Emitter {
  #el
  #scope = new Scope()
  #owned          // did we create #el (and so must release it), or adopt it?
  #autoplay
  #cues = []      // active timeline cues
  #last = 0       // last sampled currentTime, for crossing detection
  #seek = true    // next advance is a re-baseline (seek/wrap), not a continuous step
  #loops = 0
  #latched = new Map() // event -> payload, replayed to late subscribers
  #destroyed = false

  /**
   * @param {string | HTMLVideoElement} src — a URL (a fresh <video> is created)
   *   or an existing element (adopted).
   * @param {import('../../types/index.js').ClipOptions} [options]
   */
  constructor(src, options = {}) {
    super()

    this.#owned = typeof src === 'string'
    const el = this.#owned ? makeVideo() : src
    this.#el = el
    this.#autoplay = options.autoplay ?? false

    // Set attributes before src: crossOrigin only takes effect if set before load,
    // and muted must be true before an unattended autoplay is allowed.
    el.muted = options.muted ?? true
    el.loop  = options.loop  ?? false
    if ('playsInline' in el) el.playsInline = options.playsInline ?? true
    else el.setAttribute('playsinline', '')
    if (options.crossOrigin != null) el.crossOrigin = options.crossOrigin
    if (options.preload != null) el.preload = options.preload
    if (this.#owned) el.src = src

    // Native events → the Clip vocabulary. All auto-removed on destroy().
    const on = (type, fn) => this.#scope.listen(el, type, fn)
    on('loadstart',  () => this.#markLoad())
    on('loadeddata', () => this.#markReady())
    on('canplay',    () => this.#markReady()) // some browsers reach ready via canplay
    on('playing',    () => this.emit('play'))
    on('pause',      () => this.emit('pause'))
    on('ended',      () => this.emit('end'))
    on('waiting',    () => this.emit('waiting'))
    on('seeking',    () => { this.#seek = true }) // re-baseline; don't burst cues
    on('error',      () => this.emit('error', el.error))

    // An adopted element may already be past a milestone (cached, or reused). Replay
    // those facts on the next microtask so subscribers attached right after
    // construction still see them. Deferred so `new Clip(el).on('ready', …)` works.
    queueMicrotask(() => {
      if (this.#destroyed) return
      if (el.networkState !== HTMLMediaElement.NETWORK_EMPTY) this.#markLoad()
      if (el.readyState >= HAVE_CURRENT_DATA) this.#markReady()
    })
  }

  // ── Source contract ─────────────────────────────────────────────────────────

  /** The <video>, a valid texImage2D input — lets a Clip stand in for an image. */
  get texSource() { return this.#el }
  /** Escape hatch to the raw element. */
  get el() { return this.#el }
  /** False until a frame is decodable; the renderer skips uploading an empty video. */
  get uploadable() { return this.#el.readyState >= HAVE_CURRENT_DATA && this.#el.videoWidth > 0 }

  // ── Intrinsic size — the bridge to flow layout ──────────────────────────────

  /** Intrinsic width in px; 0 until 'ready'. */
  get width()  { return this.#el.videoWidth }
  /** Intrinsic height in px; 0 until 'ready'. */
  get height() { return this.#el.videoHeight }
  /** width / height, or 0 before it is known. */
  get aspect() { const h = this.#el.videoHeight; return h ? this.#el.videoWidth / h : 0 }
  /** Duration in seconds; NaN until metadata. */
  get duration() { return this.#el.duration }

  // ── Playback state ──────────────────────────────────────────────────────────

  get currentTime() { return this.#el.currentTime }
  get playing() { const el = this.#el; return !el.paused && !el.ended && el.readyState > HAVE_CURRENT_DATA }
  /** Has 'ready' fired. */
  get ready() { return this.#latched.has('ready') }

  // ── Transport ───────────────────────────────────────────────────────────────

  /** Start playback. Returns the play() promise; reject if the browser blocks it. */
  play() { return Promise.resolve(this.#el.play()) }
  pause() { this.#el.pause(); return this }
  /** Jump to a time (seconds or "mm:ss"). Flags a re-baseline so cues don't burst. */
  seek(time) { this.#seek = true; this.#el.currentTime = parseTime(time); return this }

  /**
   * Seek and resolve once the frame at that time is decoded and displayable — what
   * deterministic export needs, since an <video> cannot be sampled synchronously.
   * @param {number|string} time
   * @returns {Promise<Clip>}
   */
  seekTo(time) {
    const t = parseTime(time)
    const el = this.#el
    this.#seek = true
    return new Promise(resolve => {
      if (Math.abs(el.currentTime - t) < 1e-3 && el.readyState >= HAVE_CURRENT_DATA) { resolve(this); return }
      const done = () => { el.removeEventListener('seeked', done); resolve(this) }
      el.addEventListener('seeked', done)
      el.currentTime = t
    })
  }
  rate(x) { this.#el.playbackRate = x; return this }
  volume(v) { this.#el.volume = Math.max(0, Math.min(1, v)); return this }
  mute()   { this.#el.muted = true;  return this }
  unmute() { this.#el.muted = false; return this }

  /** Resolves when the clip is ready (immediately if it already is). */
  whenReady() {
    if (this.ready) return Promise.resolve(this)
    return new Promise(resolve => {
      const off = this.on('ready', () => { off(); resolve(this) })
    })
  }

  // ── Timeline cues ───────────────────────────────────────────────────────────

  /**
   * Fire `handler` once when playback crosses `time` (seconds or "mm:ss"). A cue
   * added behind the playhead is treated as already passed; one ahead fires when
   * crossed. Returns an unsubscribe function, like on().
   * @param {number|string} time
   * @param {(time: number, clip: Clip) => void} handler
   * @returns {() => void}
   */
  at(time, handler) {
    const at = parseTime(time)
    const cue = { at, handler, fired: at <= this.#last + EPS }
    this.#cues.push(cue)
    return () => this.#removeCue(cue)
  }

  /**
   * Fire `handler` every `interval` seconds of playback. Returns unsubscribe.
   * @param {number} interval — seconds, > 0
   * @param {(time: number, clip: Clip) => void} handler
   * @returns {() => void}
   */
  every(interval, handler) {
    if (!(interval > 0)) throw new Error('Clip.every: interval must be > 0.')
    const cue = { every: interval, handler }
    this.#cues.push(cue)
    return () => this.#removeCue(cue)
  }

  clearCues() { this.#cues.length = 0; return this }

  // ── Frame tick ──────────────────────────────────────────────────────────────

  /**
   * Sample playback and fire whatever this frame crossed. Called once per rendered
   * frame by Tulle, which already re-uploads every source each frame. Reads the
   * video's own currentTime, so cues track the *film's* position, not the wall
   * clock. Deduped per render() call by Tulle, so a clip used in two layers ticks
   * once.
   * @param {import('./Tulle.js').FrameContext} [_frame] — reserved for the
   *   explicit-time variant offline export will need.
   */
  advance(_frame) {
    if (this.#destroyed) return
    const prev = this.#last
    const curr = this.#el.currentTime
    const continuous = !this.#seek && curr + EPS >= prev

    for (const { handler, time } of dueCues(this.#cues, prev, curr, continuous))
      try { handler(time, this) } catch (err) { console.error('Tulle: a cue handler threw —', err) }

    // A looping element never fires native 'ended'; detect the wrap ourselves.
    if (this.#el.loop && curr + EPS < prev && Number.isFinite(this.#el.duration) &&
        prev - curr > this.#el.duration / 2) {
      this.#loops++
      this.emit('loop', { count: this.#loops })
    }

    this.#last = curr
    this.#seek = false
    this.emit('time', curr)
  }

  // ── Teardown ────────────────────────────────────────────────────────────────

  /** Pause, release listeners, drop the src if we own it, emit 'unload'. Idempotent. */
  destroy() {
    if (this.#destroyed) return
    this.#destroyed = true
    this.emit('unload')     // while subscribers are still attached
    this.#scope.dispose()   // native listeners off
    this.#el.pause()
    if (this.#owned) { this.#el.removeAttribute('src'); this.#el.load() } // free the resource
    this.#cues.length = 0
    this.clear()            // drop subscribers
  }

  // ── Events (latch-and-replay) ───────────────────────────────────────────────

  /**
   * Subscribe. Overrides Emitter.on to replay latched lifecycle events (load,
   * ready) to a late subscriber, so `clip.on('ready', …)` works even if the clip
   * loaded before the listener was attached.
   */
  on(type, handler) {
    const off = super.on(type, handler)
    if (this.#latched.has(type)) {
      const payload = this.#latched.get(type)
      queueMicrotask(() => { if (!this.#destroyed) handler(payload) })
    }
    return off
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  #removeCue(cue) {
    const i = this.#cues.indexOf(cue)
    if (i >= 0) this.#cues.splice(i, 1)
  }

  #markLoad() {
    if (this.#latched.has('load')) return
    this.#latched.set('load', undefined)
    this.emit('load')
  }

  #markReady() {
    if (this.#latched.has('ready')) return
    const el = this.#el
    this.#last = el.currentTime
    const payload = { width: el.videoWidth, height: el.videoHeight, duration: el.duration }
    this.#latched.set('ready', payload)
    this.emit('ready', payload)
    if (this.#autoplay) this.play().catch(err => this.emit('error', err))
  }
}

// ── Pure helpers (no DOM, no GPU — unit-testable) ─────────────────────────────

/**
 * Which cues fire when playback moves from `prev` to `curr` seconds, in ascending
 * time order. Mutates each one-shot's `fired` flag. Pure of any DOM/GPU, so the
 * crossing logic is testable without a video — the same discipline as layoutLines.
 *
 * - continuous forward: every crossed one-shot fires once; `every` fires for each
 *   interval boundary in (prev, curr].
 * - not continuous (a seek, a loop wrap, or curr < prev): nothing fires; one-shots
 *   ahead of the new position re-arm, passed ones stay consumed.
 *
 * @param {Array<{at?: number, every?: number, fired?: boolean, handler: Function}>} cues
 * @param {number} prev @param {number} curr @param {boolean} continuous
 * @returns {Array<{ handler: Function, time: number }>}
 */
export function dueCues(cues, prev, curr, continuous) {
  const out = []
  for (const cue of cues) {
    if (!continuous) {
      if (cue.every == null) cue.fired = cue.at <= curr + EPS // re-arm those still ahead
      continue
    }
    if (cue.every != null) {
      for (let k = Math.floor(prev / cue.every) + 1; k * cue.every <= curr + EPS; k++)
        out.push({ handler: cue.handler, time: k * cue.every })
    } else if (!cue.fired && prev < cue.at - EPS && cue.at <= curr + EPS) {
      cue.fired = true
      out.push({ handler: cue.handler, time: cue.at })
    }
  }
  out.sort((a, b) => a.time - b.time)
  return out
}

/**
 * Coerce a time to seconds. Accepts a number, or a colon string:
 * '90' → 90, '1:30' → 90, '1:23.5' → 83.5, '1:02:03' → 3723.
 * @param {number|string} t
 * @returns {number}
 */
export function parseTime(t) {
  if (typeof t === 'number') return t
  const parts = String(t).split(':').map(Number)
  if (parts.length === 0 || parts.some(n => Number.isNaN(n)))
    throw new Error(`Clip: could not parse time "${t}".`)
  return parts.reduce((acc, n) => acc * 60 + n, 0)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeVideo() {
  if (typeof document === 'undefined' || !document.createElement)
    throw new Error('Tulle.Clip: no document to create a <video> in.')
  return document.createElement('video')
}
