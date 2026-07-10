/**
 * Zero-dependency static server for local development.
 *
 * Tulle's examples use `<script type="module">`, and ES module imports are
 * subject to CORS — over file:// the page origin is `null` and Chrome refuses
 * to load them. So the examples must be served over http://, even locally.
 *
 *   npm run dev   →   http://localhost:8080/examples/basic.html
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, normalize, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PORT = Number(process.env.PORT) || 8080

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
}

const server = createServer(async (req, res) => {
  // Strip query/hash, then normalize away any ../ before joining to ROOT.
  const raw = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
  const rel = normalize(raw).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '')
  const path = join(ROOT, rel || 'examples/basic.html')

  if (!path.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden')
    return
  }

  try {
    const body = await readFile(path)
    res.writeHead(200, {
      'Content-Type': MIME[extname(path)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store', // always serve fresh source while iterating
    })
    res.end(body)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end(`Not found: /${rel}`)
  }
})

server.listen(PORT, () => {
  console.log(`\n  Tulle dev server\n  → http://localhost:${PORT}/examples/basic.html\n`)
})
