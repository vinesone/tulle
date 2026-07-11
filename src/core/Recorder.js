import { WebMWriter } from './webm.js'

/**
 * Recorder — deterministic offline export.
 *
 * The whole of Tulle is built so that a frame is a pure function of time:
 * renderAt(t) pins the clock, effect and layout params are values-of-time, and
 * nothing reads the wall clock. This module cashes that in. It walks a timeline
 * frame by frame, and for each frame:
 *
 *   1. seeks every time-based source (a Clip) to that exact time and waits, so the
 *      video actually shows the right frame — an <video> decodes on its own
 *      schedule and cannot be sampled synchronously (see docs/composition.md);
 *   2. calls renderAt(t) to draw that frame deterministically;
 *   3. hands the canvas to a sink — a WebCodecs encoder for record(), or a caller
 *      callback for walkFrames().
 *
 * Because step 1 waits for a real seek, export is slower than realtime, but every
 * frame is exact and an export at 30 fps matches a preview at 144 Hz.
 *
 *   const blob = await tulle.record({ fps: 30, duration: 6 })
 *   download(blob, 'out.webm')
 */

/**
 * The exact frame times of a timeline. Pure — the schedule an export follows.
 * @param {{ fps?: number, duration: number, from?: number }} opts
 * @returns {Array<{ index: number, time: number, timestamp: number }>} timestamp in µs
 */
export function frameTimestamps({ fps = 30, duration, from = 0 } = {}) {
  if (!(duration > 0)) throw new Error('Recorder: a positive `duration` (seconds) is required.')
  if (!(fps > 0)) throw new Error('Recorder: `fps` must be positive.')
  const total = Math.max(1, Math.round(duration * fps))
  const out = []
  for (let i = 0; i < total; i++) {
    const time = from + i / fps
    out.push({ index: i, time, timestamp: Math.round(time * 1e6) })
  }
  return out
}

/** Seek every time-based source in the composition to `time` and wait for it. */
async function seekSources(tulle, time) {
  const jobs = []
  for (const source of tulle.sources)
    if (source && typeof source.seekTo === 'function') jobs.push(source.seekTo(time))
  await Promise.all(jobs)
}

/** Longest finite duration among the composition's sources, else undefined. */
function inferDuration(tulle) {
  let max = 0
  for (const source of tulle.sources) {
    const d = source && source.duration
    if (Number.isFinite(d) && d > max) max = d
  }
  return max > 0 ? max : undefined
}

/**
 * Walk a timeline deterministically, calling `onFrame(canvas, meta)` per frame
 * after seeking sources and rendering. Stops any running loop first (a live loop
 * and a deterministic walk cannot share the clock). The loop is left stopped.
 * @param {import('./Tulle.js').Tulle} tulle
 * @param {{ fps?, duration?, from? }} options
 * @param {(canvas: HTMLCanvasElement, meta: {index,time,timestamp}) => any} onFrame
 * @returns {Promise<number>} frames walked
 */
export async function walkFrames(tulle, options, onFrame) {
  const duration = options.duration ?? inferDuration(tulle)
  const times = frameTimestamps({ ...options, duration })
  if (tulle.running) tulle.stop()
  for (const meta of times) {
    await seekSources(tulle, meta.time)
    tulle.renderAt(meta.time)
    await onFrame(tulle.canvas, meta)
  }
  return times.length
}

/** WebCodecs codec string → WebM CodecID. */
function webmCodecId(codec) {
  if (codec.startsWith('vp09') || codec.startsWith('vp9')) return 'V_VP9'
  if (codec.startsWith('vp8'))  return 'V_VP8'
  if (codec.startsWith('av01')) return 'V_AV1'
  throw new Error(`Recorder: codec "${codec}" has no WebM mapping (use a VP8/VP9/AV1 codec).`)
}

/**
 * Render a timeline to a WebM video, deterministically. Requires WebCodecs.
 * @param {import('./Tulle.js').Tulle} tulle
 * @param {{
 *   fps?: number, duration?: number, from?: number,
 *   codec?: string, bitrate?: number, keyframeInterval?: number,
 *   onProgress?: (fraction: number) => void,
 * }} [options]
 * @returns {Promise<Blob>} a video/webm blob
 */
export async function record(tulle, options = {}) {
  if (typeof VideoEncoder === 'undefined')
    throw new Error('Recorder: WebCodecs (VideoEncoder) is not available in this browser.')

  const {
    fps = 30, from = 0,
    codec = 'vp09.00.10.08', bitrate = 8_000_000,
    keyframeInterval = Math.max(1, Math.round(fps * 2)),
    onProgress,
  } = options
  const duration = options.duration ?? inferDuration(tulle)
  if (!(duration > 0))
    throw new Error('Recorder.record: pass a `duration` (no source has a finite one to infer from).')

  const canvas = tulle.canvas
  const { width, height } = canvas

  const writer = new WebMWriter({ width, height, codec: webmCodecId(codec), frameRate: fps })
  let encodeError = null
  const encoder = new VideoEncoder({
    output: (chunk) => {
      const buf = new Uint8Array(chunk.byteLength)
      chunk.copyTo(buf)
      writer.addFrame(buf, chunk.timestamp / 1000, chunk.type === 'key')
    },
    error: err => { encodeError = err },
  })
  encoder.configure({ codec, width, height, bitrate, framerate: fps })

  const total = frameTimestamps({ fps, duration, from }).length
  await walkFrames(tulle, { fps, duration, from }, (frameCanvas, meta) => {
    if (encodeError) throw encodeError
    const frame = new VideoFrame(frameCanvas, { timestamp: meta.timestamp })
    encoder.encode(frame, { keyFrame: meta.index % keyframeInterval === 0 })
    frame.close()
    onProgress?.((meta.index + 1) / total)
  })

  await encoder.flush()
  encoder.close()
  if (encodeError) throw encodeError
  return writer.finalize()
}
