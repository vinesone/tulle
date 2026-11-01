/**
 * Image → Gaussian splats. A photo has no depth, so this estimates it — Depth
 * Anything V2 (small) running in the browser via transformers.js, fetched from a
 * CDN on first use exactly as HeadTracker fetches its face model — then lifts
 * every pixel onto its camera ray at that depth as a small gaussian.
 *
 *   const { data, camera } = await imageToSplat(file)
 *   scene.camera = camera          // reproduces the photo's framing exactly
 *   await scene.load(data)         // then lean around it
 *
 * The result is a 2.5D "3D photo": correct parallax for small head movements,
 * with whatever the camera never saw (behind a foreground object) filled by a
 * coarse backfill layer rather than left as a hole.
 *
 * splatFromDepth() is the pure core — pixels + a disparity map in, SplatData out
 * — so bring your own depth (a different model, a phone's depth map, a painted
 * mask) and skip the download entirely.
 */

/**
 * Where the depth model comes from. Override per call via `options.model`.
 * `env` is assigned onto transformers.js' `env` before loading — e.g.
 * `{ remoteHost, allowRemoteModels, localModelPath }` to self-host the model;
 * `wasmPaths` / `numThreads` go to its ONNX Runtime backend.
 */
export const DEPTH_DEFAULTS = {
  module: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6/dist/transformers.min.js',
  model:  'onnx-community/depth-anything-v2-small',
  device: 'wasm',
  dtype:  'q8',
  env:    null,
}

/**
 * @typedef {object} ImageSplatOptions
 * @property {'model' | 'flat' | DepthMap | ((canvas: HTMLCanvasElement) => DepthMap | Promise<DepthMap>)} [depth='model']
 *   — how to get depth: estimate it, none (a flat card), a map you supply, or a function.
 * @property {number} [maxSize=640] — longest side, px, of the grid sampled (one splat per pixel).
 * @property {number} [fov=50] — vertical field of view the photo is assumed to have, degrees.
 * @property {number} [far=3] — farthest depth relative to the nearest (1). Larger = deeper scene.
 * @property {boolean} [backfill=true] — add a coarse layer behind depth edges to fill disocclusions.
 * @property {Partial<typeof DEPTH_DEFAULTS>} [model] — model/CDN overrides.
 * @property {(p: { stage: 'model' | 'depth' | 'build', loaded?: number, total?: number, file?: string }) => void} [onProgress]
 */

/** @typedef {{ data: ArrayLike<number>, width: number, height: number }} DepthMap — disparity: larger = nearer. */

/**
 * Turn an image into splats.
 * @param {HTMLImageElement | HTMLCanvasElement | ImageBitmap | Blob | string} image —
 *   an element, a bitmap, a File/Blob, or a URL.
 * @param {ImageSplatOptions} [options]
 * @returns {Promise<{ data: import('./splatData.js').SplatData, camera: object, width: number, height: number }>}
 */
export async function imageToSplat(image, options = {}) {
  const { depth = 'model', maxSize = 640, onProgress } = options
  const canvas = await rasterize(image, maxSize)
  const { width, height } = canvas
  const pixels = canvas.getContext('2d').getImageData(0, 0, width, height).data

  let disparity
  if (depth === 'flat') disparity = new Float32Array(width * height).fill(1)
  else {
    onProgress?.({ stage: 'depth' })
    const map = depth === 'model' ? await estimateDepth(canvas, options)
      : typeof depth === 'function' ? await depth(canvas)
      : depth
    disparity = normalizeDepth(map, width, height)
  }

  onProgress?.({ stage: 'build' })
  return { ...splatFromDepth({ pixels, disparity, width, height }, options), width, height }
}

/**
 * Estimate relative depth for an image with Depth Anything V2. Runs in a Web
 * Worker, so the page keeps rendering while it thinks; the model loads once and
 * is reused. Falls back to this thread where blob workers are blocked (CSP).
 * @param {HTMLCanvasElement} canvas
 * @param {{ model?: Partial<typeof DEPTH_DEFAULTS>, onProgress?: Function }} [options]
 * @returns {Promise<DepthMap>} disparity, larger = nearer
 */
export async function estimateDepth(canvas, { model, onProgress } = {}) {
  const config = { ...DEPTH_DEFAULTS, ...model }
  const { width, height } = canvas
  const rgba = canvas.getContext('2d').getImageData(0, 0, width, height).data
  const rgb = new Uint8Array(width * height * 3)
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) { rgb[j] = rgba[i]; rgb[j + 1] = rgba[i + 1]; rgb[j + 2] = rgba[i + 2] }
  const progress = p => onProgress?.({ stage: 'model', ...p })
  return runtime(config).run(rgb, width, height, progress)
}

/**
 * Build a depth estimator from a transformers.js module. Self-contained on
 * purpose: it runs on this thread and, via its source text, inside the worker.
 */
async function createEstimator({ pipeline, RawImage, env }, { model, device, dtype, env: overrides }, onProgress) {
  for (const [key, value] of Object.entries(overrides || {})) {
    if (key === 'wasmPaths' || key === 'numThreads') env.backends.onnx.wasm[key] = value
    else env[key] = value
  }
  const estimator = await pipeline('depth-estimation', model, {
    device, dtype,
    progress_callback: p => { if (p.status === 'progress') onProgress({ loaded: p.loaded, total: p.total, file: p.file }) },
  })
  return async (rgb, width, height) => {
    const { predicted_depth: depth } = await estimator(new RawImage(rgb, width, height, 3))
    const [h, w] = depth.dims.slice(-2)
    return { data: Float32Array.from(depth.data), width: w, height: h }
  }
}

const workerSource = module => `import * as transformers from ${JSON.stringify(module)}
${createEstimator}
let estimate = null
onmessage = async ({ data: { id, config, rgb, width, height } }) => {
  try {
    estimate = estimate || createEstimator(transformers, config, progress => postMessage({ id, progress }))
    const depth = await (await estimate)(rgb, width, height)
    postMessage({ id, depth }, [depth.data.buffer])
  } catch (err) {
    estimate = null
    postMessage({ id, error: String((err && err.message) || err) })
  }
}`

const runtimes = new Map()

/** One estimator per config, shared by every call; evicted on failure so a retry starts clean. */
function runtime(config) {
  const key = JSON.stringify(config)
  if (!runtimes.has(key)) {
    const evict = () => runtimes.delete(key)
    runtimes.set(key, (typeof Worker !== 'undefined' && workerRuntime(config, evict)) || mainRuntime(config, evict))
  }
  return runtimes.get(key)
}

function workerRuntime(config, evict) {
  let worker
  try {
    const url = URL.createObjectURL(new Blob([workerSource(config.module)], { type: 'text/javascript' }))
    worker = new Worker(url, { type: 'module' })
    URL.revokeObjectURL(url)
  } catch {
    return null // blob/module workers blocked — run on this thread
  }
  const pending = new Map()
  let nextId = 0
  const failAll = err => { evict(); worker.terminate(); for (const p of pending.values()) p.reject(err); pending.clear() }

  worker.onmessage = ({ data }) => {
    const job = pending.get(data.id)
    if (!job) return
    if (data.progress) return job.onProgress(data.progress)
    pending.delete(data.id)
    if (data.error) { evict(); job.reject(new Error(`depth estimation failed — ${data.error}`)) }
    else job.resolve(data.depth)
  }
  // A module that fails to import (offline, blocked CDN) surfaces here, not as a message.
  worker.onerror = event => { event.preventDefault?.(); failAll(new Error(`depth worker failed — ${event.message || 'could not load ' + config.module}`)) }

  return {
    run(rgb, width, height, onProgress) {
      return new Promise((resolve, reject) => {
        const id = ++nextId
        pending.set(id, { resolve, reject, onProgress })
        worker.postMessage({ id, config, rgb, width, height }, [rgb.buffer])
      })
    },
  }
}

function mainRuntime(config, evict) {
  let estimate = null
  return {
    async run(rgb, width, height, onProgress) {
      try {
        estimate ??= import(/* webpackIgnore: true */ config.module).then(m => createEstimator(m, config, onProgress))
        return await (await estimate)(rgb, width, height)
      } catch (err) {
        evict()
        throw err
      }
    },
  }
}

// ── Pure core (no DOM — unit-testable) ────────────────────────────────────────

/**
 * Lift pixels onto their camera rays at the given disparity.
 *
 * The photo is treated as taken by a pinhole camera at the origin looking down
 * −z with vertical field of view `fov`. Disparity (0..1, 1 = nearest) is mapped
 * linearly in inverse depth between `far` and 1 — the space monocular models
 * predict in, and the one where equal steps look like equal parallax.
 *
 * Each splat is sized to its pixel's footprint at its depth, so the image tiles
 * without gaps from the original viewpoint. On a slope its depth axis stretches
 * to meet its neighbours, so slanted surfaces stay solid when the eye moves; at
 * a real depth edge it doesn't, so foreground never smears into background.
 *
 * Leaning around a foreground object reveals background the photo never saw.
 * The backfill is a coarse plate behind such objects: the farthest depth (and
 * its colour) within `reach` of each block, so the background extends under
 * whatever stands in front of it instead of leaving a hole.
 *
 * @param {{ pixels: ArrayLike<number>, disparity: ArrayLike<number>, width: number, height: number }} input —
 *   RGBA pixels (row 0 at the top) and one disparity per pixel, 0..1.
 * @param {{ fov?: number, far?: number, backfill?: boolean, reach?: number, overscan?: number }} [options] —
 *   `reach`: how far (fraction of the long side) the plate extends under foreground;
 *   `overscan`: how much tighter the returned camera frames than the photo, so
 *   moderate head movement doesn't reach the photo's border.
 * @returns {{ data: import('./splatData.js').SplatData, camera: object }}
 */
export function splatFromDepth({ pixels, disparity, width, height }, { fov = 50, far = 3, backfill = true, reach = 0.08, overscan = 0.08 } = {}) {
  const tanH = Math.tan(fov * Math.PI / 360)
  const aspect = width / height
  const n = width * height

  // Depth per pixel; inverse depth runs from 1/far (d = 0) to 1 (d = 1).
  const raw = new Float32Array(n)
  for (let i = 0; i < n; i++) raw[i] = 1 / (1 / far + clamp01(disparity[i]) * (1 - 1 / far))

  const footprint = 2 * tanH / height // world size of one pixel at depth 1
  const z = snapEdges(raw, width, height, footprint)
  const BLOCK = 4
  const blocks = backfill ? Math.ceil(width / BLOCK) * Math.ceil(height / BLOCK) : 0
  const out = allocate(n + blocks)
  let k = 0

  const put = (u, v, depth, sigmaXY, sigmaZ, p) => {
    out.positions[k * 3]     = (u / width - 0.5) * 2 * tanH * aspect * depth
    out.positions[k * 3 + 1] = (0.5 - v / height) * 2 * tanH * depth
    out.positions[k * 3 + 2] = -depth
    out.scales[k * 3] = out.scales[k * 3 + 1] = sigmaXY
    out.scales[k * 3 + 2] = sigmaZ
    out.rotations[k * 4] = 1
    out.colors.set([pixels[p], pixels[p + 1], pixels[p + 2], pixels[p + 3]], k * 4)
    k++
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (pixels[i * 4 + 3] < 8) continue // transparent pixels make no splat
      const d = z[i]
      const sigma = 0.6 * footprint * d
      // Largest step to a neighbour, unless it's an edge (a jump of a few pixels'
      // worth — depth models blur edges into ramps, which must not become sheets).
      let step = 0
      for (const j of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, y > 0 ? i - width : -1, y < height - 1 ? i + width : -1]) {
        if (j < 0) continue
        const dz = Math.abs(z[j] - d)
        if (dz < 4 * footprint * d && dz > step) step = dz
      }
      put(x + 0.5, y + 0.5, d, sigma, Math.min(4 * sigma, Math.max(sigma, step * 0.6)), i * 4)
    }
  }

  if (backfill) {
    const bw = Math.ceil(width / BLOCK), bh = Math.ceil(height / BLOCK)
    // Per block: nearest depth, and the farthest pixel (its index carries depth and colour).
    const nearest = new Float32Array(bw * bh).fill(Infinity)
    let deepest = new Int32Array(bw * bh).fill(-1)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = y * width + x
        if (pixels[i * 4 + 3] < 8) continue
        const b = Math.floor(y / BLOCK) * bw + Math.floor(x / BLOCK)
        if (z[i] < nearest[b]) nearest[b] = z[i]
        if (deepest[b] < 0 || z[i] > z[deepest[b]]) deepest[b] = i
      }
    // Max-filter the farthest pixel over ±R blocks — separable: rows, then columns.
    const R = Math.max(1, Math.ceil(reach * Math.max(width, height) / BLOCK))
    const dilate = (src, along) => {
      const dst = new Int32Array(src.length).fill(-1)
      for (let by = 0; by < bh; by++)
        for (let bx = 0; bx < bw; bx++) {
          let best = -1
          for (let r = -R; r <= R; r++) {
            const x = along ? bx + r : bx, y = along ? by : by + r
            if (x < 0 || y < 0 || x >= bw || y >= bh) continue
            const c = src[y * bw + x]
            if (c >= 0 && (best < 0 || z[c] > z[best])) best = c
          }
          dst[by * bw + bx] = best
        }
      return dst
    }
    deepest = dilate(dilate(deepest, true), false)

    // A plate splat only where something nearer stands in front of that far surface.
    for (let by = 0; by < bh; by++)
      for (let bx = 0; bx < bw; bx++) {
        const b = by * bw + bx, at = deepest[b]
        if (at < 0) continue
        const back = z[at]
        if (back - nearest[b] < 3 * footprint * back) continue
        const depth = back * 1.01
        const sigma = 0.7 * BLOCK * footprint * depth
        put((bx + 0.5) * BLOCK, (by + 0.5) * BLOCK, depth, sigma, sigma, at * 4)
      }
  }

  const data = trim(out, k)
  // Put the median depth on the glass: half the scene behind it, half in front.
  const sorted = Float32Array.from(z).sort()
  const focus = sorted[Math.floor(sorted.length / 2)] || 1
  return {
    data,
    camera: { position: [0, 0, 0], target: [0, 0, -focus], up: [0, 1, 0], fov: Math.atan(tanH * (1 - overscan)) * 360 / Math.PI },
  }
}

/**
 * Depth models blur edges into ramps; a pixel halfway up one would float in
 * mid-air once the eye moves ("flying pixels"). Where a 5×5 neighbourhood spans
 * a real depth edge, snap each pixel to whichever side — near or far — it is
 * closer to, turning the ramp back into a step.
 */
export function snapEdges(z, width, height, footprint, radius = 2) {
  const out = new Float32Array(z)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let lo = Infinity, hi = -Infinity
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= height) continue
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= width) continue
          const v = z[yy * width + xx]
          if (v < lo) lo = v
          if (v > hi) hi = v
        }
      }
      const i = y * width + x
      if (hi - lo > 8 * footprint * lo) out[i] = z[i] - lo < hi - z[i] ? lo : hi
    }
  return out
}

/**
 * Resample a disparity map to `width`×`height` (bilinear) and stretch it to 0..1.
 * @param {DepthMap} map
 * @returns {Float32Array}
 */
export function normalizeDepth(map, width, height) {
  const { data, width: w, height: h } = map
  if (!data || data.length < w * h) throw new Error('imageToSplat: a depth map needs data of width × height values.')
  const out = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    const sy = Math.min(h - 1, Math.max(0, (y + 0.5) * h / height - 0.5))
    const y0 = Math.floor(sy), y1 = Math.min(h - 1, y0 + 1), fy = sy - y0
    for (let x = 0; x < width; x++) {
      const sx = Math.min(w - 1, Math.max(0, (x + 0.5) * w / width - 0.5))
      const x0 = Math.floor(sx), x1 = Math.min(w - 1, x0 + 1), fx = sx - x0
      const top = data[y0 * w + x0] * (1 - fx) + data[y0 * w + x1] * fx
      const bot = data[y1 * w + x0] * (1 - fx) + data[y1 * w + x1] * fx
      out[y * width + x] = top * (1 - fy) + bot * fy
    }
  }
  let min = Infinity, max = -Infinity
  for (const v of out) { if (v < min) min = v; if (v > max) max = v }
  const range = max - min
  for (let i = 0; i < out.length; i++) out[i] = range > 0 ? (out[i] - min) / range : 1
  return out
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Draw any image-like input into a canvas no larger than `maxSize` on its long side. */
async function rasterize(image, maxSize) {
  let source = image
  if (typeof image === 'string') source = await loadImage(image)
  else if (typeof Blob !== 'undefined' && image instanceof Blob) {
    if (image.type && !image.type.startsWith('image/'))
      throw new Error(`imageToSplat: "${image.name ?? image.type}" is not an image.`)
    source = await createImageBitmap(image)
  }
  const w = source.naturalWidth ?? source.videoWidth ?? source.width
  const h = source.naturalHeight ?? source.videoHeight ?? source.height
  if (!(w > 0) || !(h > 0)) throw new Error('imageToSplat: the image has no size — is it loaded?')

  const scale = Math.min(1, maxSize / Math.max(w, h))
  const canvas = document.createElement('canvas')
  canvas.width  = Math.max(1, Math.round(w * scale))
  canvas.height = Math.max(1, Math.round(h * scale))
  canvas.getContext('2d', { willReadFrequently: true }).drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous' // reading pixels back needs an untainted canvas
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`imageToSplat: couldn't load ${url} (CORS?).`))
    img.src = url
  })
}

function allocate(count) {
  return {
    count,
    positions: new Float32Array(count * 3),
    scales:    new Float32Array(count * 3),
    rotations: new Float32Array(count * 4),
    colors:    new Uint8Array(count * 4),
  }
}

function trim(data, count) {
  return {
    count,
    positions: data.positions.slice(0, count * 3),
    scales:    data.scales.slice(0, count * 3),
    rotations: data.rotations.slice(0, count * 4),
    colors:    data.colors.slice(0, count * 4),
  }
}

const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v
