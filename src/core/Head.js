import { Emitter } from './Emitter.js'

/**
 * HeadTracker — where the viewer's eyes are, relative to the screen.
 *
 * The output is `offset`: the eye position relative to where it was when
 * tracking settled (or when you last called recenter()), in units of the
 * screen's half-height. `x` is right, `y` up, `z` away from the screen — the
 * units camera.js' windowCamera() takes, so a Splat can consume it directly:
 *
 *   const head = tulle.head()          // webcam, falls back to the pointer
 *   await head.start()                 // asks for the camera
 *   scene.track(head)
 *
 * Sources:
 *
 * - `'webcam'` — face landmarks from MediaPipe's FaceLandmarker. The library is
 *   fetched from a CDN the first time you call start() (Tulle itself stays free
 *   of dependencies), or pass your own `landmarker` / `detect`. Eye position
 *   comes from the eye-corner landmarks; distance from their spacing against an
 *   average interpupillary distance, so no calibration step is needed.
 * - `'pointer'` — the pointer stands in for your head. For development, for a
 *   denied camera (the default fallback), or as a deliberate mouse-look.
 * - `'manual'` — nothing is sampled; feed poses yourself with update() (a
 *   WebXR viewer pose, a different face tracker, a recorded path).
 *
 * Raw poses are in millimetres from the camera and pass through a One Euro
 * filter: steady when you hold still, responsive when you move.
 *
 * Tracking is live input like the pointer, never part of a deterministic
 * export — record a pose path and replay it with update() if you need that.
 */

/** Where the webcam backend loads MediaPipe from. Override per tracker via `vision`. */
export const VISION_DEFAULTS = {
  module: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs',
  wasm:   'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm',
  model:  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
}

/** Samples to wait before fixing the neutral pose — lets the filter settle. */
const SETTLE = 10

export class HeadTracker extends Emitter {
  #opts
  #source       // the source in use — may differ from the requested one after a fallback
  #pointer
  #filters
  #pose = null
  #neutral = null
  #samples = 0

  #running = false
  #raf = null
  #video = null
  #stream = null
  #landmarker = null
  #ownsLandmarker = false
  #lastFrameTime = -1
  #lastSeen = 0
  #tracking = false
  #destroyed = false

  /**
   * @param {object} [options]
   * @param {'webcam' | 'pointer' | 'manual'} [options.source='webcam']
   * @param {import('./Pointer.js').Pointer} [options.pointer] — for the pointer
   *   source and fallback; `tulle.head()` passes the Tulle's own.
   * @param {'pointer' | null} [options.fallback='pointer'] — what to do when the
   *   webcam can't start (denied, absent, offline). null rejects instead.
   * @param {number} [options.screenHeight=190] — physical screen height, mm.
   *   Sets how far a "half-screen" of head movement is; ~190 suits a laptop.
   * @param {number} [options.cameraFov=60] — webcam horizontal field of view, degrees.
   * @param {number} [options.ipd=63] — interpupillary distance, mm.
   * @param {{ minCutoff?: number, beta?: number }} [options.smoothing] — One Euro params.
   * @param {number} [options.lostAfter=0.5] — seconds without a face before 'lost'.
   * @param {object} [options.landmarker] — a ready MediaPipe FaceLandmarker (VIDEO mode).
   * @param {(video: HTMLVideoElement, timeMs: number) => ({x:number,y:number,z:number} | null)} [options.detect]
   *   — a custom detector returning a pose in mm, replacing MediaPipe.
   * @param {Partial<typeof VISION_DEFAULTS>} [options.vision] — CDN overrides.
   */
  constructor(options = {}) {
    super()
    this.#opts = {
      source: 'webcam', fallback: 'pointer', screenHeight: 190, cameraFov: 60, ipd: 63,
      lostAfter: 0.5, ...options,
      vision: { ...VISION_DEFAULTS, ...options.vision },
    }
    this.#source  = this.#opts.source
    this.#pointer = options.pointer ?? null
    const { minCutoff = 1, beta = 0.01 } = options.smoothing ?? {}
    this.#filters = [0, 1, 2].map(() => new OneEuro({ minCutoff, beta }))
    if (options.landmarker) this.#landmarker = options.landmarker
  }

  // ── State ───────────────────────────────────────────────────────────────────

  /** The source in use: 'webcam', 'pointer' or 'manual'. */
  get source()   { return this.#source }
  get running()  { return this.#running }
  /** True while a face (or the pointer) is being tracked. */
  get tracking() { return this.#tracking }
  /** The webcam <video>, for a preview — null for other sources. */
  get video()    { return this.#video }
  /** Smoothed eye position in mm from the camera, or null before the first sample. */
  get pose()     { return this.#pose && { ...this.#pose } }
  /** The pose offset() is measured from. */
  get neutral()  { return this.#neutral && { ...this.#neutral } }

  /**
   * Eye offset from neutral in screen half-heights — `{ x, y, z }`, all 0 until
   * the neutral pose is fixed. What Splat.track() reads.
   */
  get offset() {
    const p = this.#pose, n = this.#neutral
    if (!p || !n) return { x: 0, y: 0, z: 0 }
    const half = this.#opts.screenHeight / 2
    return { x: (p.x - n.x) / half, y: (p.y - n.y) / half, z: (p.z - n.z) / half }
  }

  // ── Control ─────────────────────────────────────────────────────────────────

  /**
   * Start tracking. For the webcam this asks for camera permission and loads the
   * face model; if either fails and `fallback` is 'pointer', it switches to the
   * pointer, emits 'fallback' with the error, and still resolves.
   * @returns {Promise<HeadTracker>}
   */
  async start() {
    this.#assertAlive('start')
    if (this.#running) return this

    if (this.#source === 'webcam') {
      try {
        await this.#startWebcam()
      } catch (err) {
        this.#stopWebcam()
        if (this.#opts.fallback === 'pointer' && this.#pointer) {
          this.#source = 'pointer'
          this.emit('fallback', err)
        } else {
          this.emit('error', err)
          throw err
        }
      }
    }
    if (this.#destroyed) return this
    if (this.#source === 'pointer' && !this.#pointer)
      throw new Error('HeadTracker: the pointer source needs a Pointer — create it with tulle.head(), or pass options.pointer.')

    if (this.#source === 'pointer') this.#neutral = { x: 0, y: 0, z: 600 }
    this.#running = true
    if (this.#source !== 'manual') this.#loop()
    this.emit('start', { source: this.#source })
    return this
  }

  /** Stop sampling and release the camera. The last pose is kept; start() resumes. */
  stop() {
    if (!this.#running) return this
    this.#running = false
    if (this.#raf !== null) {
      if (this.#raf.video) this.#video?.cancelVideoFrameCallback?.(this.#raf.id)
      else cancelAnimationFrame(this.#raf.id)
    }
    this.#raf = null
    this.#stopWebcam()
    this.emit('stop')
    return this
  }

  /** Make wherever the head is now the neutral (zero-offset) pose. */
  recenter() {
    if (this.#pose) this.#neutral = { ...this.#pose }
    else this.#samples = 0
    return this
  }

  /**
   * Feed a raw pose, in mm from the camera (x right, y up, z distance). Smoothed
   * like any sampled pose. The whole input path for the 'manual' source.
   * @param {{ x: number, y: number, z: number }} pose
   * @param {number} [timeMs=performance.now()]
   */
  update(pose, timeMs = performance.now()) {
    this.#ingest(pose, timeMs)
    this.#seen(true, timeMs)
    return this
  }

  /** Stop, close a landmarker we created, drop listeners. Idempotent. */
  destroy() {
    if (this.#destroyed) return
    this.stop()
    this.#destroyed = true
    if (this.#ownsLandmarker) this.#landmarker?.close?.()
    this.#landmarker = null
    this.emit('destroy')
    this.clear()
  }

  // ── Private: sampling ───────────────────────────────────────────────────────

  #loop() {
    const tick = () => {
      if (!this.#running) return
      this.#sample()
      this.#schedule(tick)
    }
    this.#schedule(tick)
  }

  #schedule(tick) {
    // A webcam only has something new once per video frame; sample on those.
    const video = this.#source === 'webcam' ? this.#video : null
    if (video?.requestVideoFrameCallback) this.#raf = { video: true, id: video.requestVideoFrameCallback(tick) }
    else this.#raf = { video: false, id: requestAnimationFrame(tick) }
  }

  #sample() {
    const now = performance.now()
    if (this.#source === 'pointer') {
      const p = this.#pointer
      const sh = this.#opts.screenHeight
      // Pointer at an edge = head one half-screen off-centre; away = centred.
      const pose = p.inside ? { x: (p.u - 0.5) * sh, y: (p.v - 0.5) * sh, z: 600 } : { x: 0, y: 0, z: 600 }
      this.#ingest(pose, now)
      this.#seen(p.inside, now)
      return
    }

    const video = this.#video
    if (!video || video.readyState < 2 || video.currentTime === this.#lastFrameTime) return
    this.#lastFrameTime = video.currentTime

    let pose = null
    try {
      if (this.#opts.detect) {
        pose = this.#opts.detect(video, now)
      } else {
        const face = this.#landmarker.detectForVideo(video, now)?.faceLandmarks?.[0]
        if (face) pose = poseFromLandmarks(face, {
          width: video.videoWidth, height: video.videoHeight,
          fov: this.#opts.cameraFov, ipd: this.#opts.ipd,
        })
      }
    } catch (err) {
      this.emit('error', err)
    }

    if (pose) {
      this.#ingest(pose, now)
      this.#seen(true, now)
    } else {
      this.#seen(false, now)
      // Lost for a while: drift gently back to neutral rather than freezing askew.
      if (!this.#tracking && this.#neutral) this.#ingest(this.#neutral, now)
    }
  }

  #ingest(raw, timeMs) {
    const t = timeMs / 1000
    const [fx, fy, fz] = this.#filters
    this.#pose = { x: fx.filter(raw.x, t), y: fy.filter(raw.y, t), z: fz.filter(raw.z, t) }
    if (!this.#neutral && ++this.#samples >= SETTLE) this.#neutral = { ...this.#pose }
    this.emit('pose', { pose: this.pose, offset: this.offset })
  }

  #seen(found, timeMs) {
    if (found) {
      this.#lastSeen = timeMs
      if (!this.#tracking) { this.#tracking = true; this.emit('found') }
    } else if (this.#tracking && timeMs - this.#lastSeen > this.#opts.lostAfter * 1000) {
      this.#tracking = false
      this.emit('lost')
    }
  }

  // ── Private: webcam ─────────────────────────────────────────────────────────

  async #startWebcam() {
    if (!globalThis.navigator?.mediaDevices?.getUserMedia)
      throw new Error('HeadTracker: no camera access here (needs a secure context — https or localhost).')

    const camera = navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    })
    const model = this.#opts.detect || this.#landmarker ? null : loadLandmarker(this.#opts.vision)
    // Ask for both at once; the model download overlaps the permission prompt.
    const [stream, landmarker] = await Promise.all([camera, model])
    if (landmarker) { this.#landmarker = landmarker; this.#ownsLandmarker = true }
    this.#stream = stream
    if (this.#destroyed) return

    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.srcObject = stream
    await video.play()
    this.#video = video
  }

  #stopWebcam() {
    this.#stream?.getTracks().forEach(track => track.stop())
    this.#stream = null
    if (this.#video) { this.#video.srcObject = null; this.#video = null }
    this.#lastFrameTime = -1
  }

  #assertAlive(method) {
    if (this.#destroyed) throw new Error(`HeadTracker.${method}: this tracker has been destroyed.`)
  }
}

/** Fetch MediaPipe and build a FaceLandmarker, preferring the GPU delegate. */
async function loadLandmarker({ module, wasm, model }) {
  const vision = await import(/* webpackIgnore: true */ module)
  const fileset = await vision.FilesetResolver.forVisionTasks(wasm)
  const create = delegate => vision.FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: model, delegate },
    runningMode: 'VIDEO',
    numFaces: 1,
  })
  try { return await create('GPU') } catch { return create('CPU') }
}

// ── Pure helpers (no DOM — unit-testable) ─────────────────────────────────────

/** FaceMesh landmark indices: the outer and inner corner of each eye. */
const EYES = { left: [33, 133], right: [362, 263] }

/**
 * Eye midpoint in mm from the camera, from normalised face landmarks (MediaPipe
 * FaceMesh topology: `{ x, y, z }` with x, y in 0..1 of the image and z in the
 * same scale as x). Distance comes from the eye spacing against a known IPD; the
 * landmarks' depth term keeps a turned head from reading as a farther one.
 *
 * x is the viewer's right (the image is unmirrored, so that is image-left), y up.
 *
 * @param {Array<{ x: number, y: number, z?: number }>} landmarks
 * @param {{ width: number, height: number, fov?: number, ipd?: number }} camera —
 *   frame size in px, horizontal fov in degrees, IPD in mm.
 * @returns {{ x: number, y: number, z: number }}
 */
export function poseFromLandmarks(landmarks, { width, height, fov = 60, ipd = 63 }) {
  const eye = ([a, b]) => {
    const p = landmarks[a], q = landmarks[b]
    return [(p.x + q.x) / 2 * width, (p.y + q.y) / 2 * height, ((p.z ?? 0) + (q.z ?? 0)) / 2 * width]
  }
  const l = eye(EYES.left), r = eye(EYES.right)
  const spacing = Math.hypot(l[0] - r[0], l[1] - r[1], l[2] - r[2]) || 1
  const focal = (width / 2) / Math.tan(fov * Math.PI / 360)
  const z = focal * ipd / spacing
  const cx = (l[0] + r[0]) / 2, cy = (l[1] + r[1]) / 2
  return { x: (width / 2 - cx) * z / focal, y: (height / 2 - cy) * z / focal, z }
}

/**
 * The One Euro filter (Casiez et al., 2012): a low-pass whose cutoff rises with
 * speed, so jitter is smoothed at rest without adding lag to real motion.
 *
 *   const f = new OneEuro({ minCutoff: 1, beta: 0.01 })
 *   smoothed = f.filter(raw, timeInSeconds)
 */
export class OneEuro {
  #minCutoff
  #beta
  #dCutoff
  #x = 0
  #dx = 0
  #t = null

  /** @param {{ minCutoff?: number, beta?: number, dCutoff?: number }} [options] — Hz, 1/unit-per-second, Hz. */
  constructor({ minCutoff = 1, beta = 0.01, dCutoff = 1 } = {}) {
    this.#minCutoff = minCutoff
    this.#beta = beta
    this.#dCutoff = dCutoff
  }

  /** @param {number} value @param {number} t — seconds @returns {number} */
  filter(value, t) {
    if (this.#t === null) { this.#t = t; this.#x = value; this.#dx = 0; return value }
    const dt = Math.max(t - this.#t, 1e-6)
    this.#t = t
    this.#dx = mix(this.#dx, (value - this.#x) / dt, smoothing(this.#dCutoff, dt))
    const cutoff = this.#minCutoff + this.#beta * Math.abs(this.#dx)
    this.#x = mix(this.#x, value, smoothing(cutoff, dt))
    return this.#x
  }

  reset() { this.#t = null; return this }
}

const smoothing = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt))
const mix = (a, b, t) => a + (b - a) * t
