/**
 * Pre-publish gate.
 *
 * Tulle ships raw ESM with no build step, so nothing would otherwise catch a
 * syntax error before it reaches npm. This parses every published source file
 * and verifies the package's export map actually resolves.
 *
 *   npm run check
 */
import { execFile } from 'node:child_process'
import { readdir, readFile, access } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run  = promisify(execFile)
const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** @returns {Promise<string[]>} every .js file under dir, recursively */
async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = await Promise.all(entries.map(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return walk(path)
    return extname(path) === '.js' ? [path] : []
  }))
  return files.flat()
}

let failed = 0
const fail = msg => { console.error(`FAIL  ${msg}`); failed++ }

// 1. Every source file must parse as an ES module.
const sources = await walk(join(ROOT, 'src'))
for (const file of sources) {
  const rel = file.slice(ROOT.length)
  try {
    await run(process.execPath, ['--check', file])
    console.log(`ok    ${rel}`)
  } catch (err) {
    fail(`${rel}\n${err.stderr?.trim()}`)
  }
}

// 2. A GLSL template literal must not contain a backtick — it would silently
//    terminate the template and the shader would be parsed as JavaScript.
for (const file of sources) {
  const text = await readFile(file, 'utf8')
  const shader = text.match(/fragSrc\s*=\s*\/\*\s*glsl\s*\*\/`([\s\S]*?)`/)
  if (shader && shader[1].includes('`'))
    fail(`${file.slice(ROOT.length)} — backtick inside a GLSL template literal`)
}

// 3. Every path in the export map must exist.
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
const paths = []
const collect = value => {
  if (typeof value === 'string') paths.push(value)
  else if (value && typeof value === 'object') Object.values(value).forEach(collect)
}
collect(pkg.exports)

for (const path of paths) {
  if (path.includes('*')) continue // wildcard subpath, nothing to stat
  try {
    await access(join(ROOT, path))
    console.log(`ok    exports -> ${path}`)
  } catch {
    fail(`exports points at a missing file: ${path}`)
  }
}

console.log('')
if (failed) {
  console.error(`${failed} problem${failed === 1 ? '' : 's'} — not publishable.`)
  process.exit(1)
}
console.log(`${sources.length} source files parsed, export map resolves. Ready to publish.`)
