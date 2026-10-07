/**
 * Bundle self-check: the patch declares the 绘图模式 preset, the plugin the row
 * names loads and registers its full catalog, and the components the tools need
 * are reachable. Service reachability is informational; a failed structural
 * check exits non-zero.
 *
 * Usage: node tools/verify.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toolList } from '../lib/plugin.js'
import { bundle } from './bundle.mjs'

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const checks = []

function check(name, ok, detail = '') {
  checks.push({ name, ok })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`)
}

const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'))
const patch = readFileSync(join(PACKAGE_DIR, 'cordis.patch.yml'), 'utf8')
const composition = readFileSync(join(PACKAGE_DIR, 'preset', 'agent.cordis.yml'), 'utf8')
const pluginPath = join(PACKAGE_DIR, 'preset', 'dsh-comfyui-control', 'lib', 'index.js')

check('package.json declares the bundle patch', manifest.dsh?.bundle?.patch === './cordis.patch.yml')
check('the patch declares the preset-drawing row', /- id: preset-drawing\n\s+name: '@deepseek-ai\/dsh-agent-preset'/.test(patch))
check('the declaration carries 绘图模式', /name: 绘图模式/.test(patch))
check('the declaration mounts the plugin through the profile node_modules link', /- id: comfyui-control\s+name: \.\/node_modules\/dsh-comfyui-control\/preset\/dsh-comfyui-control\/lib\/index\.js/.test(patch))
check('loader expressions survived the build', patch.includes("!!js process.platform === 'win32'") && patch.includes("!!js process.platform !== 'win32'"))
check('every plugin row names a resolvable package or an owned path', composition
  .split(/^- id: /m).slice(1)
  .every((row) => {
    const name = row.match(/^\s*name: '?([^'\n]+)'?/m)?.[1] ?? ''
    return name.startsWith('@deepseek-ai/') || name.startsWith('.') || name.startsWith('cordis:')
  }))

const tools = toolList()
check('the source catalog has 19 tools', tools.length === 19, `got ${tools.length}`)
check('the plugin build is committed and current', existsSync(pluginPath) && readFileSync(pluginPath, 'utf8') === bundle())

if (existsSync(pluginPath)) {
  const built = await import(`file:///${pluginPath.replace(/\\/g, '/')}?verify=${Date.now()}`)
  const registered = []
  built.apply({ tools: { register: (definition) => { registered.push(definition.name); return () => {} } }, on: () => {} })
  check('the plugin the preset loads registers all 19 tools', registered.length === 19, `registered ${registered.length}`)
  check('the built catalog equals the source catalog', JSON.stringify([...registered].sort()) === JSON.stringify(tools.map((tool) => tool.name).sort()))
}

for (const file of ['pipeline.json', 'LORA_GUIDE.md']) {
  check(`the plugin ships ${file}`, existsSync(join(PACKAGE_DIR, 'preset', 'dsh-comfyui-control', file)))
}

// 8899 is a required dependency, so the viewer ships with the bundle.
check('the compare viewer ships with the bundle', existsSync(join(PACKAGE_DIR, 'tools', 'serve-compare.mjs')))
check('the package exposes the viewer as a script', JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')).scripts?.['serve-compare']?.includes('serve-compare.mjs'))
check('the plugin reports the viewer as required', composition.includes('8899') || readFileSync(join(PACKAGE_DIR, 'lib', 'danbooru.js'), 'utf8').includes('8899'))

// Every directory the plugin reads at runtime must be in the npm file list, or
// the published tarball is missing files that resolve fine in a git checkout.
const published = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')).files ?? []
for (const dir of ['lib', 'preset', 'repro']) {
  check(`npm publishes ${dir}/`, published.includes(dir))
}
check('npm publishes the repro manifest', existsSync(join(PACKAGE_DIR, 'repro', 'samples.json')) && published.includes('repro'))

const probes = [
  ['ComfyUI', `${process.env.COMFYUI_URL || 'http://127.0.0.1:8188'}/system_stats`],
  ['Ollama', `${process.env.OLLAMA_URL || 'http://127.0.0.1:11434'}/api/tags`],
  ['camofox-browser', `${process.env.CAMOFOX_URL || 'http://127.0.0.1:9377'}/health`],
  ['compare viewer', `${process.env.COMFYUI_VIEW_BASE || 'http://127.0.0.1:8899'}/`],
]
for (const [name, url] of probes) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
    process.stdout.write(`INFO  ${name}: HTTP ${response.status}\n`)
  } catch (error) {
    process.stdout.write(`INFO  ${name}: unreachable (${error.name})\n`)
  }
}

const failed = checks.filter((entry) => !entry.ok).length
process.stdout.write(`\n${checks.length - failed}/${checks.length} checks passed\n`)
if (failed > 0) process.exitCode = 1
