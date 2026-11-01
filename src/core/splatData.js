/**
 * Gaussian splat data — parsing, GPU packing, and depth sorting. Pure functions
 * over typed arrays: no DOM, no GL, so all of it runs (and is tested) in Node.
 *
 * Every loader produces one plain shape, SplatData:
 *
 *   {
 *     count:     number,
 *     positions: Float32Array  // 3 per splat — x y z
 *     scales:    Float32Array  // 3 per splat — linear std-dev along each local axis
 *     rotations: Float32Array  // 4 per splat — unit quaternion, w x y z
 *     colors:    Uint8Array    // 4 per splat — r g b a, straight (not premultiplied)
 *   }
 *
 * Build one yourself (any field but `positions` may be omitted) and hand it to a
 * Splat exactly like a loaded file.
 */

/** Zeroth-order spherical-harmonic constant: colour = 0.5 + SH_C0 · f_dc. */
const SH_C0 = 0.28209479177387814

/** Texels per row of the packed data texture; two RGBA32UI texels per splat. */
export const PACK_WIDTH = 2048

// ── Loaders ──────────────────────────────────────────────────────────────────

/**
 * Parse a file of either supported format, sniffing the `ply` magic.
 * @param {ArrayBuffer} buffer
 * @param {{ pointSize?: number }} [options] — see parsePly.
 * @returns {SplatData}
 */
export function parseSplatFile(buffer, options) {
  const head = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength))
  const isPly = head[0] === 0x70 && head[1] === 0x6c && head[2] === 0x79 && (head[3] === 0x0a || head[3] === 0x0d)
  return isPly ? parsePly(buffer, options) : parseSplat(buffer)
}

/**
 * The compact `.splat` format popularised by the antimatter15 web viewer: 32
 * bytes per splat — position f32×3, scale f32×3, colour u8×4, rotation u8×4
 * (w x y z, mapped from 0..255 to −1..1).
 * @param {ArrayBuffer} buffer
 * @returns {SplatData}
 */
export function parseSplat(buffer) {
  if (buffer.byteLength % 32 !== 0)
    throw new Error(`parseSplat: ${buffer.byteLength} bytes is not a whole number of 32-byte splats — is this a .splat file?`)
  const count = buffer.byteLength / 32
  const f32 = new Float32Array(buffer)
  const u8  = new Uint8Array(buffer)
  const data = allocate(count)

  for (let i = 0; i < count; i++) {
    const f = i * 8, b = i * 32
    data.positions.set(f32.subarray(f, f + 3), i * 3)
    data.scales.set(f32.subarray(f + 3, f + 6), i * 3)
    data.colors.set(u8.subarray(b + 24, b + 28), i * 4)
    setRotation(data.rotations, i,
      (u8[b + 28] - 128) / 128, (u8[b + 29] - 128) / 128,
      (u8[b + 30] - 128) / 128, (u8[b + 31] - 128) / 128)
  }
  return data
}

/**
 * Write SplatData as a `.splat` file — the inverse of parseSplat, and loadable
 * by the other web splat viewers too. Rotations quantise to a byte per
 * component, as the format does.
 * @param {SplatData} data
 * @returns {ArrayBuffer}
 */
export function encodeSplat({ count, positions, scales, rotations, colors }) {
  const buffer = new ArrayBuffer(count * 32)
  const f32 = new Float32Array(buffer)
  const u8  = new Uint8Array(buffer)
  for (let i = 0; i < count; i++) {
    const f = i * 8, b = i * 32
    f32.set(positions.subarray(i * 3, i * 3 + 3), f)
    f32.set(scales.subarray(i * 3, i * 3 + 3), f + 3)
    u8.set(colors.subarray(i * 4, i * 4 + 4), b + 24)
    for (let c = 0; c < 4; c++)
      u8[b + 28 + c] = Math.max(0, Math.min(255, Math.round(rotations[i * 4 + c] * 128 + 128)))
  }
  return buffer
}

const PLY_TYPES = {
  char: ['getInt8', 1],     int8: ['getInt8', 1],
  uchar: ['getUint8', 1],   uint8: ['getUint8', 1],
  short: ['getInt16', 2],   int16: ['getInt16', 2],
  ushort: ['getUint16', 2], uint16: ['getUint16', 2],
  int: ['getInt32', 4],     int32: ['getInt32', 4],
  uint: ['getUint32', 4],   uint32: ['getUint32', 4],
  float: ['getFloat32', 4], float32: ['getFloat32', 4],
  double: ['getFloat64', 8], float64: ['getFloat64', 8],
}

/**
 * A binary little-endian `.ply` — the format 3DGS training (INRIA's reference
 * code, Postshot, Polycam, Luma, …) exports. Reads position, `scale_*` (log),
 * `rot_*` (w x y z), `opacity` (logit), and the base colour from `f_dc_*`.
 * Higher-order SH (`f_rest_*`, view-dependent colour) is ignored. A plain point
 * cloud (`red`/`green`/`blue`, no scales) loads too, as small round splats.
 *
 * @param {ArrayBuffer} buffer
 * @param {{ pointSize?: number }} [options] — std-dev for splats with no scale.
 * @returns {SplatData}
 */
export function parsePly(buffer, { pointSize = 0.01 } = {}) {
  const bytes = new Uint8Array(buffer)
  const end = indexOf(bytes, 'end_header', 0, Math.min(bytes.length, 1 << 16))
  if (end < 0) throw new Error('parsePly: no end_header — not a .ply file, or a corrupt one.')
  let bodyStart = end + 'end_header'.length
  if (bytes[bodyStart] === 0x0d) bodyStart++
  bodyStart++ // the newline

  const header = new TextDecoder().decode(bytes.subarray(0, end)).split(/\r?\n/)
  const elements = []
  for (const line of header) {
    const [kw, ...rest] = line.trim().split(/\s+/)
    if (kw === 'format' && rest[0] !== 'binary_little_endian')
      throw new Error(`parsePly: "${rest[0]}" .ply files are not supported — export binary_little_endian.`)
    if (kw === 'element') elements.push({ name: rest[0], count: +rest[1], props: [], stride: 0, list: false })
    if (kw === 'property') {
      const el = elements.at(-1)
      if (!el) continue
      if (rest[0] === 'list') { el.list = true; continue }
      const type = PLY_TYPES[rest[0]]
      if (!type) throw new Error(`parsePly: unknown property type "${rest[0]}".`)
      el.props.push({ name: rest[1], get: type[0], offset: el.stride, size: type[1] })
      el.stride += type[1]
    }
  }

  // Skip any fixed-size elements stored before the vertices.
  let offset = bodyStart
  const vertex = elements.find(el => el.name === 'vertex')
  if (!vertex) throw new Error('parsePly: no "element vertex" in the header.')
  for (const el of elements) {
    if (el === vertex) break
    if (el.list) throw new Error(`parsePly: element "${el.name}" with list properties precedes the vertices.`)
    offset += el.count * el.stride
  }
  if (vertex.list) throw new Error('parsePly: list properties on vertices are not supported.')
  if (offset + vertex.count * vertex.stride > buffer.byteLength)
    throw new Error('parsePly: the file is shorter than its header says — truncated download?')

  const view = new DataView(buffer)
  const prop = name => vertex.props.find(p => p.name === name)
  const reader = name => {
    const p = prop(name)
    if (!p) return null
    const get = view[p.get].bind(view)
    // Integer colour channels are 0..255; normalise so every reader is 0..1-ish.
    const scale = p.get === 'getUint8' ? 1 / 255 : 1
    return base => get(base + p.offset, true) * scale
  }

  const [x, y, z] = ['x', 'y', 'z'].map(reader)
  if (!x || !y || !z) throw new Error('parsePly: vertices need x, y and z.')
  const s   = ['scale_0', 'scale_1', 'scale_2'].map(reader)
  const rot = ['rot_0', 'rot_1', 'rot_2', 'rot_3'].map(reader)
  const dc  = ['f_dc_0', 'f_dc_1', 'f_dc_2'].map(reader)
  const rgb = ['red', 'green', 'blue'].map(reader)
  const opacity = reader('opacity'), alpha = reader('alpha')
  const hasScale = s.every(Boolean), hasRot = rot.every(Boolean)
  const hasDc = dc.every(Boolean), hasRgb = rgb.every(Boolean)

  const count = vertex.count
  const data = allocate(count)
  const { positions, scales, rotations, colors } = data

  for (let i = 0; i < count; i++) {
    const base = offset + i * vertex.stride
    positions[i * 3]     = x(base)
    positions[i * 3 + 1] = y(base)
    positions[i * 3 + 2] = z(base)

    if (hasScale) {
      scales[i * 3]     = Math.exp(s[0](base))
      scales[i * 3 + 1] = Math.exp(s[1](base))
      scales[i * 3 + 2] = Math.exp(s[2](base))
    } else {
      scales[i * 3] = scales[i * 3 + 1] = scales[i * 3 + 2] = pointSize
    }

    if (hasRot) setRotation(rotations, i, rot[0](base), rot[1](base), rot[2](base), rot[3](base))
    else setRotation(rotations, i, 1, 0, 0, 0)

    let r = 1, g = 1, b = 1
    if (hasDc) { r = 0.5 + SH_C0 * dc[0](base); g = 0.5 + SH_C0 * dc[1](base); b = 0.5 + SH_C0 * dc[2](base) }
    else if (hasRgb) { r = rgb[0](base); g = rgb[1](base); b = rgb[2](base) }
    const a = opacity ? 1 / (1 + Math.exp(-opacity(base))) : alpha ? alpha(base) : 1

    colors[i * 4]     = toByte(r)
    colors[i * 4 + 1] = toByte(g)
    colors[i * 4 + 2] = toByte(b)
    colors[i * 4 + 3] = toByte(a)
  }
  return data
}

/**
 * Complete a partial SplatData: default scales (`pointSize`), identity
 * rotations, and opaque white. Validates array lengths against `count`.
 * @param {Partial<SplatData> & { positions: Float32Array | number[] }} input
 * @param {{ pointSize?: number }} [options]
 * @returns {SplatData}
 */
export function toSplatData(input, { pointSize = 0.01 } = {}) {
  if (!input?.positions) throw new Error('Splat: data needs at least `positions` (3 floats per splat).')
  const count = input.count ?? Math.floor(input.positions.length / 3)
  const check = (name, per) => {
    const arr = input[name]
    if (arr && arr.length < count * per)
      throw new Error(`Splat: data.${name} has ${arr.length} values; ${count} splats need ${count * per}.`)
    return arr
  }
  check('positions', 3)
  const data = allocate(count)
  data.positions.set(input.positions.length === count * 3 ? input.positions : input.positions.slice(0, count * 3))

  const scales = check('scales', 3)
  if (scales) data.scales.set(scales.slice(0, count * 3))
  else data.scales.fill(pointSize)

  const rotations = check('rotations', 4)
  for (let i = 0; i < count; i++) {
    if (rotations) setRotation(data.rotations, i, rotations[i * 4], rotations[i * 4 + 1], rotations[i * 4 + 2], rotations[i * 4 + 3])
    else data.rotations[i * 4] = 1
  }

  const colors = check('colors', 4)
  if (colors) data.colors.set(colors.slice(0, count * 4))
  else data.colors.fill(255)
  return data
}

// ── GPU packing ──────────────────────────────────────────────────────────────

/**
 * Pack splats for an RGBA32UI data texture, two texels per splat:
 *
 *   texel 0: position x y z (float bits), colour r g b a (one byte each)
 *   texel 1: 3D covariance, upper triangle xx xy xz yy yz zz as six half-floats
 *
 * Precomputing the covariance (Σ = R S Sᵀ Rᵀ) on the CPU means the vertex shader
 * reads 32 bytes per splat and never touches a quaternion. It is stored ×4 so the
 * tiny values of small splats keep precision in half floats; the shader undoes it.
 *
 * @param {SplatData} data
 * @returns {{ data: Uint32Array, width: number, height: number }}
 */
export function packSplats({ count, positions, scales, rotations, colors }) {
  const perRow = PACK_WIDTH / 2
  const height = Math.max(1, Math.ceil(count / perRow))
  const out = new Uint32Array(PACK_WIDTH * height * 4)
  const f32 = new Float32Array(out.buffer)
  const u8  = new Uint8Array(out.buffer)

  for (let i = 0; i < count; i++) {
    const o = i * 8
    f32[o]     = positions[i * 3]
    f32[o + 1] = positions[i * 3 + 1]
    f32[o + 2] = positions[i * 3 + 2]
    u8.set(colors.subarray(i * 4, i * 4 + 4), (o + 3) * 4)

    const [xx, xy, xz, yy, yz, zz] = covariance(scales, rotations, i)
    out[o + 4] = toHalf(4 * xx) | (toHalf(4 * xy) << 16)
    out[o + 5] = toHalf(4 * xz) | (toHalf(4 * yy) << 16)
    out[o + 6] = toHalf(4 * yz) | (toHalf(4 * zz) << 16)
  }
  return { data: out, width: PACK_WIDTH, height }
}

/** Σ = M Mᵀ with M = R·S, for splat `i`. Returns the upper triangle. */
export function covariance(scales, rotations, i) {
  const w = rotations[i * 4], x = rotations[i * 4 + 1], y = rotations[i * 4 + 2], z = rotations[i * 4 + 3]
  const sx = scales[i * 3], sy = scales[i * 3 + 1], sz = scales[i * 3 + 2]
  // Rotation matrix rows, each column scaled by that axis' std-dev.
  const m00 = (1 - 2 * (y * y + z * z)) * sx, m01 = 2 * (x * y - w * z) * sy,       m02 = 2 * (x * z + w * y) * sz
  const m10 = 2 * (x * y + w * z) * sx,       m11 = (1 - 2 * (x * x + z * z)) * sy, m12 = 2 * (y * z - w * x) * sz
  const m20 = 2 * (x * z - w * y) * sx,       m21 = 2 * (y * z + w * x) * sy,       m22 = (1 - 2 * (x * x + y * y)) * sz
  return [
    m00 * m00 + m01 * m01 + m02 * m02,
    m00 * m10 + m01 * m11 + m02 * m12,
    m00 * m20 + m01 * m21 + m02 * m22,
    m10 * m10 + m11 * m11 + m12 * m12,
    m10 * m20 + m11 * m21 + m12 * m22,
    m20 * m20 + m21 * m21 + m22 * m22,
  ]
}

const halfF32 = new Float32Array(1)
const halfU32 = new Uint32Array(halfF32.buffer)

/** Float → IEEE 754 half bits, round-to-nearest. What GLSL's unpackHalf2x16 reads. */
export function toHalf(value) {
  halfF32[0] = value
  const bits = halfU32[0]
  const sign = (bits >>> 16) & 0x8000
  const exp  = (bits >>> 23) & 0xff
  let mant   = bits & 0x7fffff
  if (exp === 0xff) return sign | (mant ? 0x7e00 : 0x7c00) // NaN, ±∞
  const e = exp - 127 + 15
  if (e >= 31) return sign | 0x7c00                         // overflow → ∞
  if (e <= 0) {                                             // subnormal, or flush to 0
    if (e < -10) return sign
    mant = (mant | 0x800000) >> (1 - e)
    return sign | ((mant + 0x1000) >> 13)
  }
  // `+`, not `|`: a mantissa that rounds up carries into the exponent, correctly.
  return sign | ((e << 10) + ((mant + 0x1000) >> 13))
}

// ── Sorting ──────────────────────────────────────────────────────────────────

/**
 * Order splats back to front for a view matrix — the order alpha blending needs.
 * A 16-bit counting sort on view-space depth: O(n), stable, and fast enough to
 * re-run every time the head moves (in a worker, via its own source text —
 * which is why this function must stay self-contained).
 *
 * @param {Float32Array} positions — 3 per splat
 * @param {number} count
 * @param {ArrayLike<number>} view — column-major view matrix
 * @param {Uint32Array} [out]
 * @returns {Uint32Array} splat indices, farthest first
 */
export function sortSplats(positions, count, view, out = new Uint32Array(count)) {
  const a = view[2], b = view[6], c = view[10], d = view[14]
  const depth = new Float32Array(count)
  let min = Infinity, max = -Infinity
  for (let i = 0; i < count; i++) {
    const z = a * positions[i * 3] + b * positions[i * 3 + 1] + c * positions[i * 3 + 2] + d
    depth[i] = z
    if (z < min) min = z
    if (z > max) max = z
  }
  const BINS = 65536
  const scale = (BINS - 1) / ((max - min) || 1)
  const counts = new Uint32Array(BINS)
  const keys = new Uint16Array(count)
  for (let i = 0; i < count; i++) {
    const key = ((depth[i] - min) * scale) | 0
    keys[i] = key
    counts[key]++
  }
  // The camera looks down −z, so ascending z is farthest first.
  let sum = 0
  for (let k = 0; k < BINS; k++) { const n = counts[k]; counts[k] = sum; sum += n }
  for (let i = 0; i < count; i++) out[counts[keys[i]]++] = i
  return out
}

/**
 * Robust bounds for framing a camera: the 10th–90th percentile box on each axis
 * and the per-axis median as the centre, from a sample. Captured scenes carry a
 * halo of far-flung floaters and background that would drag a min/max box (or
 * even its midpoint) well off the subject; the median stays where the splats are.
 * @param {Float32Array} positions
 * @param {number} count
 * @returns {{ min: number[], max: number[], center: number[], radius: number }}
 */
export function boundsOf(positions, count) {
  if (count === 0) return { min: [0, 0, 0], max: [0, 0, 0], center: [0, 0, 0], radius: 1 }
  const n = Math.min(count, 20000)
  const step = count / n
  const min = [], max = [], center = []
  for (let axis = 0; axis < 3; axis++) {
    const sample = new Float32Array(n)
    for (let i = 0; i < n; i++) sample[i] = positions[Math.floor(i * step) * 3 + axis]
    sample.sort()
    min.push(sample[Math.floor((n - 1) * 0.1)])
    max.push(sample[Math.ceil((n - 1) * 0.9)])
    center.push(sample[Math.floor((n - 1) / 2)])
  }
  const radius = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2 || 1
  return { min, max, center, radius }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function allocate(count) {
  return {
    count,
    positions: new Float32Array(count * 3),
    scales:    new Float32Array(count * 3),
    rotations: new Float32Array(count * 4),
    colors:    new Uint8Array(count * 4),
  }
}

function setRotation(out, i, w, x, y, z) {
  const l = Math.hypot(w, x, y, z)
  if (!(l > 1e-8)) { out[i * 4] = 1; out[i * 4 + 1] = out[i * 4 + 2] = out[i * 4 + 3] = 0; return }
  out[i * 4] = w / l; out[i * 4 + 1] = x / l; out[i * 4 + 2] = y / l; out[i * 4 + 3] = z / l
}

const toByte = v => Math.max(0, Math.min(255, Math.round(v * 255)))

/** First index of ASCII `needle` in `bytes[from, to)`, or −1. */
function indexOf(bytes, needle, from, to) {
  const codes = [...needle].map(ch => ch.charCodeAt(0))
  outer: for (let i = from; i <= to - codes.length; i++) {
    for (let j = 0; j < codes.length; j++) if (bytes[i + j] !== codes[j]) continue outer
    return i
  }
  return -1
}

/**
 * @typedef {{ count: number, positions: Float32Array, scales: Float32Array,
 *             rotations: Float32Array, colors: Uint8Array }} SplatData
 */
