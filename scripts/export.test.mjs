/**
 * Export tests — the pure, error-prone pieces of offline export, no browser.
 *
 * EBML variable-length integers are the part of the WebM muxer most likely to have
 * an off-by-one, so they're checked against hand-computed bytes. frameTimestamps is
 * the deterministic schedule an export follows. The muxer assembly and WebCodecs
 * path are browser-verified via examples/export.html.
 *
 *   npm test
 */
import { vint, uintBytes } from '../src/core/webm.js'
import { frameTimestamps } from '../src/core/Recorder.js'

let failed = 0
const ok = (cond, msg) => { if (cond) console.log(`ok    ${msg}`); else { console.error(`FAIL  ${msg}`); failed++ } }
const bytes = (got, want, msg) => {
  const g = [...got].map(b => b.toString(16).padStart(2, '0')).join(' ')
  const w = want.map(b => b.toString(16).padStart(2, '0')).join(' ')
  ok(g === w, `${msg} — got [${g}], want [${w}]`)
}

// ── EBML vint: length marker + value; all-ones per width is reserved ─────────
bytes(vint(0),     [0x80],       'vint 0 → one byte, marker only')
bytes(vint(1),     [0x81],       'vint 1')
bytes(vint(126),   [0xfe],       'vint 126 → largest 1-byte value')
bytes(vint(127),   [0x40, 0x7f], 'vint 127 → spills to 2 bytes (0x7f reserved)')
bytes(vint(128),   [0x40, 0x80], 'vint 128')
bytes(vint(16382), [0x7f, 0xfe], 'vint 16382 → largest 2-byte value')
bytes(vint(16383), [0x20, 0x3f, 0xff], 'vint 16383 → spills to 3 bytes')

// ── uintBytes: minimal big-endian, at least one byte ─────────────────────────
bytes(uintBytes(0),      [0x00],             'uint 0 → one zero byte')
bytes(uintBytes(1),      [0x01],             'uint 1')
bytes(uintBytes(255),    [0xff],             'uint 255')
bytes(uintBytes(256),    [0x01, 0x00],       'uint 256 → two bytes')
bytes(uintBytes(1000000),[0x0f, 0x42, 0x40], 'uint 1000000 (the timecode scale)')

// ── frameTimestamps: exact schedule ──────────────────────────────────────────
{
  const t = frameTimestamps({ fps: 30, duration: 1 })
  ok(t.length === 30, 'frameTimestamps: 30 frames for 1s @ 30fps')
  ok(t[0].index === 0 && t[0].time === 0 && t[0].timestamp === 0, 'frameTimestamps: first frame at 0')
  ok(Math.abs(t[1].time - 1 / 30) < 1e-9, 'frameTimestamps: second frame at 1/30 s')
  ok(t[29].timestamp === Math.round(29 / 30 * 1e6), 'frameTimestamps: last timestamp in µs')
}
{
  const t = frameTimestamps({ fps: 25, duration: 2, from: 10 })
  ok(t.length === 50, 'frameTimestamps: 50 frames for 2s @ 25fps')
  ok(t[0].time === 10, 'frameTimestamps: honours `from`')
}
{
  let threw = false
  try { frameTimestamps({ fps: 30 }) } catch { threw = true }
  ok(threw, 'frameTimestamps: missing duration throws')
}

console.log('')
if (failed) { console.error(`${failed} test(s) failed.`); process.exit(1) }
console.log('export: all muxer + schedule tests passed.')
