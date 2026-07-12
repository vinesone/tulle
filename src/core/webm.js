/**
 * webm — a minimal, dependency-free WebM (Matroska/EBML) muxer.
 *
 * WebCodecs gives you encoded video chunks; a container has to wrap them before a
 * player will touch them. Tulle ships no dependencies and has no build step, so
 * rather than pull in a muxer library this hand-rolls the small subset of WebM an
 * export needs: an EBML header, one video track, and clusters of SimpleBlocks.
 *
 * It buffers every frame and assembles the file in finalize(), so all element
 * sizes are known and written exactly (no unknown-size streaming). That costs
 * memory proportional to the clip — fine for the offline exports this is for.
 *
 * The fiddly, error-prone part — EBML variable-length integers — is pure and
 * exported, so it is unit-tested (test/export.test.mjs) without a browser. The
 * assembly itself is browser-verified via examples/export.html.
 *
 *   const w = new WebMWriter({ width: 1280, height: 720, codec: 'V_VP9', frameRate: 30 })
 *   w.addFrame(bytes, timestampMs, isKeyframe)
 *   const blob = w.finalize()   // a video/webm Blob
 */

// ── EBML primitives (pure, tested) ────────────────────────────────────────────

/**
 * Encode a value as an EBML variable-length integer (used for element sizes and
 * the track number in a block). The first byte carries a length marker; the
 * all-ones pattern of each width is reserved (it means "unknown size"), so a value
 * that would fill a width exactly spills into the next one.
 * @param {number} value
 * @returns {Uint8Array}
 */
export function vint(value) {
  let length = 1
  while (length <= 8 && value >= 2 ** (7 * length) - 1) length++
  const bytes = new Uint8Array(length)
  let v = value
  for (let i = length - 1; i >= 0; i--) { bytes[i] = v & 0xff; v = Math.floor(v / 256) }
  bytes[0] |= 1 << (8 - length) // length-descriptor marker bit
  return bytes
}

/** Minimal big-endian unsigned integer, at least one byte. */
export function uintBytes(n) {
  const bytes = []
  let v = Math.max(0, Math.floor(n))
  do { bytes.unshift(v & 0xff); v = Math.floor(v / 256) } while (v > 0)
  return Uint8Array.from(bytes)
}

/** 8-byte big-endian IEEE-754 double. */
function f64(n) {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setFloat64(0, n, false)
  return b
}

const utf8 = s => new TextEncoder().encode(s)

/** Concatenate Uint8Arrays. */
function concat(...parts) {
  let len = 0
  for (const p of parts) len += p.length
  const out = new Uint8Array(len)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

/** One EBML element: id bytes + size vint + payload. */
function el(id, payload) {
  return concat(Uint8Array.from(id), vint(payload.length), payload)
}

// ── Element IDs ───────────────────────────────────────────────────────────────

const ID = {
  EBML:            [0x1a, 0x45, 0xdf, 0xa3],
  EBMLVersion:     [0x42, 0x86],
  EBMLReadVersion: [0x42, 0xf7],
  EBMLMaxIDLength: [0x42, 0xf2],
  EBMLMaxSizeLength: [0x42, 0xf3],
  DocType:         [0x42, 0x82],
  DocTypeVersion:  [0x42, 0x87],
  DocTypeReadVersion: [0x42, 0x85],

  Segment:       [0x18, 0x53, 0x80, 0x67],
  Info:          [0x15, 0x49, 0xa9, 0x66],
  TimecodeScale: [0x2a, 0xd7, 0xb1],
  MuxingApp:     [0x4d, 0x80],
  WritingApp:    [0x57, 0x41],
  Duration:      [0x44, 0x89],

  Tracks:       [0x16, 0x54, 0xae, 0x6b],
  TrackEntry:   [0xae],
  TrackNumber:  [0xd7],
  TrackUID:     [0x73, 0xc5],
  TrackType:    [0x83],
  FlagLacing:   [0x9c],
  CodecID:      [0x86],
  Video:        [0xe0],
  PixelWidth:   [0xb0],
  PixelHeight:  [0xba],

  Cluster:     [0x1f, 0x43, 0xb6, 0x75],
  Timecode:    [0xe7],
  SimpleBlock: [0xa3],
}

/** SimpleBlock: track vint, int16 relative timecode (BE), flags byte, then data. */
function simpleBlock(trackNumber, relTimeMs, key, data) {
  const tn = vint(trackNumber)
  const header = new Uint8Array(tn.length + 3)
  header.set(tn, 0)
  new DataView(header.buffer).setInt16(tn.length, relTimeMs, false)
  header[tn.length + 2] = key ? 0x80 : 0x00 // keyframe flag
  return el(ID.SimpleBlock, concat(header, data))
}

// ── Writer ────────────────────────────────────────────────────────────────────

const TIMECODE_SCALE = 1_000_000 // ns per tick → timecodes are milliseconds
const MAX_CLUSTER_MS = 32_000    // keep block rel-timecodes inside int16

export class WebMWriter {
  #width; #height; #codec; #frameRate
  #frames = [] // { data, timestampMs, key }

  /** @param {{ width, height, codec?: string, frameRate?: number }} opts — codec is a WebM CodecID, e.g. 'V_VP9'. */
  constructor({ width, height, codec = 'V_VP9', frameRate = 30 }) {
    this.#width = width; this.#height = height; this.#codec = codec; this.#frameRate = frameRate
  }

  /** @param {Uint8Array} data @param {number} timestampMs @param {boolean} key */
  addFrame(data, timestampMs, key) {
    this.#frames.push({ data, timestampMs: Math.round(timestampMs), key: !!key })
  }

  /** Assemble the whole file. @returns {Blob} a video/webm blob. */
  finalize() {
    const header = el(ID.EBML, concat(
      el(ID.EBMLVersion,        uintBytes(1)),
      el(ID.EBMLReadVersion,    uintBytes(1)),
      el(ID.EBMLMaxIDLength,    uintBytes(4)),
      el(ID.EBMLMaxSizeLength,  uintBytes(8)),
      el(ID.DocType,            utf8('webm')),
      el(ID.DocTypeVersion,     uintBytes(2)),
      el(ID.DocTypeReadVersion, uintBytes(2)),
    ))

    const frames = this.#frames
    const lastMs = frames.length ? frames[frames.length - 1].timestampMs : 0
    const durationMs = lastMs + 1000 / this.#frameRate

    const info = el(ID.Info, concat(
      el(ID.TimecodeScale, uintBytes(TIMECODE_SCALE)),
      el(ID.MuxingApp,  utf8('tulle')),
      el(ID.WritingApp, utf8('tulle')),
      el(ID.Duration,   f64(durationMs)),
    ))

    const tracks = el(ID.Tracks, el(ID.TrackEntry, concat(
      el(ID.TrackNumber, uintBytes(1)),
      el(ID.TrackUID,    uintBytes(1)),
      el(ID.TrackType,   uintBytes(1)), // 1 = video
      el(ID.FlagLacing,  uintBytes(0)),
      el(ID.CodecID,     utf8(this.#codec)),
      el(ID.Video, concat(
        el(ID.PixelWidth,  uintBytes(this.#width)),
        el(ID.PixelHeight, uintBytes(this.#height)),
      )),
    )))

    // Group frames into clusters: a new one at each keyframe, or before the rel
    // timecode would overflow int16.
    const clusters = []
    let cur = null
    for (const f of frames) {
      if (!cur || f.key || f.timestampMs - cur.base >= MAX_CLUSTER_MS) {
        cur = { base: f.timestampMs, blocks: [] }
        clusters.push(cur)
      }
      cur.blocks.push(simpleBlock(1, f.timestampMs - cur.base, f.key, f.data))
    }
    const clusterEls = clusters.map(c =>
      el(ID.Cluster, concat(el(ID.Timecode, uintBytes(c.base)), ...c.blocks)))

    const segment = el(ID.Segment, concat(info, tracks, ...clusterEls))
    return new Blob([header, segment], { type: 'video/webm' })
  }
}
