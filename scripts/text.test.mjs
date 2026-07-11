/**
 * Text line-breaking tests — pure logic, no canvas or GPU needed.
 *
 * layoutLines is the one part of typesetting that has real branching (honouring
 * hard newlines, greedy word wrap, over-long words). We test it with a fake
 * monospace measure — every character is one unit wide — so wrap points are
 * predictable without a font.
 *
 *   npm test
 */
import { layoutLines } from '../src/core/Text.js'

let failed = 0
const eq = (got, want, msg) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { console.log(`ok    ${msg}`); return }
  console.error(`FAIL  ${msg} — got ${g}, want ${w}`); failed++
}

/** One unit per character, matching how canvas measureText scales with length. */
const mono = s => s.length

// ── No wrapping: newlines become lines, nothing else splits ──────────────────
eq(layoutLines('hello world', mono, 0),        ['hello world'], 'maxWidth 0 disables wrapping')
eq(layoutLines('hello world', mono, Infinity), ['hello world'], 'Infinity disables wrapping')
eq(layoutLines('a\nb\nc', mono, 0),            ['a', 'b', 'c'],  'hard newlines split into lines')

// ── Greedy word wrap ─────────────────────────────────────────────────────────
// "aaa bbb ccc": at width 7, "aaa bbb" (7) fits, adding " ccc" (11) does not.
eq(layoutLines('aaa bbb ccc', mono, 7), ['aaa bbb', 'ccc'], 'wraps when the next word overflows')
eq(layoutLines('aaa bbb ccc', mono, 3), ['aaa', 'bbb', 'ccc'], 'one word per line at a tight width')
eq(layoutLines('aaa bbb ccc', mono, 100), ['aaa bbb ccc'], 'no wrap when it all fits')

// ── Over-long words are not broken mid-character ─────────────────────────────
eq(layoutLines('supercalifragilistic', mono, 5), ['supercalifragilistic'], 'a too-long word stays whole')
eq(layoutLines('hi supercalifragilistic', mono, 5), ['hi', 'supercalifragilistic'], 'long word drops to its own line')

// ── Newlines and wrapping compose; blank lines survive ───────────────────────
eq(layoutLines('aaa bbb\nccc', mono, 3), ['aaa', 'bbb', 'ccc'], 'wrap applies within each paragraph')
eq(layoutLines('a\n\nb', mono, 0), ['a', '', 'b'], 'blank line between paragraphs is preserved')
eq(layoutLines('  aaa   bbb  ', mono, 100), ['aaa bbb'], 'runs of whitespace collapse to single gaps')

console.log('')
if (failed) { console.error(`${failed} problem${failed === 1 ? '' : 's'}.`); process.exit(1) }
console.log('text: all line-breaking tests passed.')
