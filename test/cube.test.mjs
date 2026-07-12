/**
 * .cube LUT parser tests — pure text parsing, no canvas or GPU needed.
 *
 * Covers the shape Premiere Pro and DaVinci Resolve export: a header, optional
 * comments/title/domain lines, then size³ rows of "r g b", red varying fastest.
 *
 *   npm test
 */
import { parseCube } from '../src/effects/color/Lut.js'

let failed = 0
const ok = (cond, msg) => { if (cond) console.log(`ok    ${msg}`); else { console.error(`FAIL  ${msg}`); failed++ } }
const throws = (fn, msg) => { try { fn(); console.error(`FAIL  ${msg} — did not throw`); failed++ } catch { console.log(`ok    ${msg}`) } }

// A minimal 2×2×2 identity-ish cube with comments, title, and a domain line.
const CUBE = `# a comment
TITLE "Teal & Orange"
LUT_3D_SIZE 2
DOMAIN_MIN 0.0 0.0 0.0
DOMAIN_MAX 1.0 1.0 1.0
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1`

{
  const cube = parseCube(CUBE)
  ok(cube.size === 2, 'reads LUT_3D_SIZE')
  ok(cube.title === 'Teal & Orange', 'reads quoted TITLE')
  ok(cube.data.length === 2 * 2 * 2 * 3, 'collects size³ RGB triples')

  // Red varies fastest: entry 1 is (1,0,0); blue slowest: entry 4 is (0,0,1).
  ok(cube.data[3] === 1 && cube.data[4] === 0 && cube.data[5] === 0, 'row order: red fastest')
  ok(cube.data[12] === 0 && cube.data[13] === 0 && cube.data[14] === 1, 'row order: blue slowest')
  ok(cube.domainMax[0] === 1, 'reads DOMAIN_MAX')
}

// Robustness: blank lines, CRLF, and an unknown keyword line are tolerated.
{
  const messy = 'LUT_3D_SIZE 2\r\nLUT_3D_INPUT_RANGE 0 1\r\n\r\n' +
    ['0 0 0','1 0 0','0 1 0','1 1 0','0 0 1','1 0 1','0 1 1','1 1 1'].join('\r\n')
  const cube = parseCube(messy)
  ok(cube.data.length === 24, 'skips blank lines, CRLF, and unknown keywords')
}

// Errors: a 1D LUT, a missing size, and a truncated body are all rejected.
throws(() => parseCube('LUT_1D_SIZE 16\n0 0 0'), 'rejects 1D LUTs with a clear error')
throws(() => parseCube('0 0 0\n1 1 1'), 'rejects a file with no LUT_3D_SIZE')
throws(() => parseCube('LUT_3D_SIZE 2\n0 0 0\n1 0 0'), 'rejects a truncated body (wrong entry count)')

console.log('')
if (failed) { console.error(`${failed} test(s) failed.`); process.exit(1) }
console.log('cube parser: all tests passed.')
