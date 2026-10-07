/**
 * Serve the plugin's compare directory on 8899.
 *
 * The 绘图模式 preset treats this server as required: `comfyui_generate` answers
 * with a `view_url` on this base, so without it the model hands the user a dead
 * link. Started by hand or by the launcher; it serves only GET/HEAD from the
 * state directory, so it exposes nothing else on the machine.
 *
 * Usage: node tools/serve-compare.mjs [--port 8899] [--host 127.0.0.1] [--dir <path>]
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { COMPARE_DIR } from '../lib/env.js'

function parseArgs(argv) {
  const options = { port: Number(process.env.COMFYUI_VIEW_PORT ?? 8899), host: '127.0.0.1', dir: COMPARE_DIR }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--port') options.port = Number(argv[++index])
    else if (flag === '--host') options.host = argv[++index]
    else if (flag === '--dir') options.dir = resolve(argv[++index])
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error(`invalid port: ${options.port}`)
  return options
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

const options = parseArgs(process.argv.slice(2))
const root = resolve(options.dir)
const rootPrefix = root.endsWith(sep) ? root : root + sep

createServer((request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405).end('method not allowed')
    return
  }
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
  const relative = normalize(pathname).replace(/^[/\\]+/, '')
  const target = resolve(root, relative)
  if (target !== root && !target.startsWith(rootPrefix)) {
    response.writeHead(403).end('forbidden')
    return
  }
  let stats
  try {
    stats = statSync(target)
  } catch {
    response.writeHead(404).end('not found')
    return
  }
  const file = stats.isDirectory() ? join(target, 'index.html') : target
  if (!existsSync(file) || statSync(file).isDirectory()) {
    response.writeHead(404).end('not found')
    return
  }
  response.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': statSync(file).size,
    'cache-control': 'no-store',
  })
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  createReadStream(file).pipe(response)
}).listen(options.port, options.host, () => {
  process.stdout.write(`compare viewer: http://${options.host}:${options.port}/  ->  ${root}\n`)
})
