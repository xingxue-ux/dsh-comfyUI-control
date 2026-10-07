/**
 * End-to-end self-check for the 绘图模式 preset.
 *
 * Verifies, without touching a live model, that:
 *   1. this package's tools all build, register and validate;
 *   2. the shipped preset composition names the plugin and nothing else, and
 *      no other preset in the dsh home names it;
 *   3. when the preset is installed, the installed copy loads and exposes the
 *      same tool catalog as the source tree;
 *   4. the local services the tools depend on answer (informational).
 *
 * Usage: node tools/verify.mjs [--installed] [--id drawing] [--dsh-home <dir>]
 * Exits non-zero when a check fails; service reachability never fails the run.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const installed = args.includes('--installed')
const idIndex = args.indexOf('--id')
const presetId = idIndex >= 0 ? args[idIndex + 1] : 'drawing'
const homeIndex = args.indexOf('--dsh-home')
const dshHome = resolve(homeIndex >= 0 ? args[homeIndex + 1] : process.env.DSH_HOME || join(homedir(), '.dsh'))

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`)
}

function readIfPresent(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

async function main() {
  // 1. the source-of-truth catalog
  const { toolList } = await import('../lib/plugin.js')
  const tools = toolList()
  check('tool catalog has 18 tools', tools.length === 18, `got ${tools.length}`)
  check('tool names are unique and prefixed', new Set(tools.map((t) => t.name)).size === tools.length && tools.every((t) => t.name.startsWith('comfyui_')))

  // 2. the shipped preset composition
  const composition = readIfPresent(join(PACKAGE_DIR, 'preset', 'agent.cordis.yml'))
  check('preset composition exists', composition !== undefined)
  check('composition mounts the bundled plugin', /name: '\.\/dsh-comfyui-control\/lib\/index\.js'/.test(composition ?? ''))
  check('composition declares the 绘图模式 persona', /- id: persona/.test(composition ?? ''))
  check('preset.yml declares 绘图模式', /^name: 绘图模式$/m.test(readIfPresent(join(PACKAGE_DIR, 'preset', 'preset.yml')) ?? ''))
  const presetGuide = join(PACKAGE_DIR, 'docs', 'LORA_GUIDE.md')
  check('LoRA guide ships with the package', existsSync(presetGuide) && readFileSync(presetGuide, 'utf8').includes('comfyui_generate'))

  // 3. no other preset names this plugin
  const presetRoot = join(dshHome, '.agent-presets')
  if (existsSync(presetRoot)) {
    const foreign = []
    for (const entry of readdirSync(presetRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === presetId) continue
      const file = join(presetRoot, entry.name, 'agent.cordis.yml')
      if (!existsSync(file)) continue
      if (/dsh-comfyui-control/.test(readFileSync(file, 'utf8'))) foreign.push(entry.name)
    }
    check('no other preset names this plugin', foreign.length === 0, foreign.join(', '))
  } else {
    check('dsh presets directory exists', false, presetRoot)
  }

  // 4. the installed copy
  if (installed) {
    const target = join(presetRoot, presetId)
    check('preset is installed', existsSync(target), target)
    const bundlePath = join(target, 'dsh-comfyui-control', 'lib', 'index.js')
    if (existsSync(bundlePath)) {
      const bundled = await import(`file:///${bundlePath.replace(/\\/g, '/')}?verify=${Date.now()}`)
      const installedNames = bundled.toolList().map((tool) => tool.name).sort()
      check('installed bundle exposes the same catalog', JSON.stringify(installedNames) === JSON.stringify(tools.map((t) => t.name).sort()))
      const registered = []
      bundled.apply({
        tools: { register: (definition) => { registered.push(definition.name); return () => {} } },
        on: () => {},
      })
      check('installed bundle registers all tools', registered.length === tools.length, `registered ${registered.length}`)

      // The installed bundle must resolve its own directory, not the build
      // checkout: its pipeline has to live inside the preset directory.
      const status = await bundled.toolList().find((tool) => tool.name === 'comfyui_status').execute({}, {})
      check('installed bundle reports the preset directory as its own', status.pipeline.startsWith(target), status.pipeline)
      check('installed preset ships the pipeline it reports', existsSync(status.pipeline) && status.pipeline_exists === true, status.pipeline)
    } else {
      check('installed bundle exists', false, bundlePath)
    }
    check('installed composition matches the shipped one', readIfPresent(join(target, 'agent.cordis.yml')) === composition)
  }

  // 5. local services (informational)
  const probes = [
    ['ComfyUI', `${process.env.COMFYUI_URL || 'http://127.0.0.1:8188'}/system_stats`],
    ['Ollama', `${process.env.OLLAMA_URL || 'http://127.0.0.1:11434'}/api/tags`],
    ['camofox-browser', `${process.env.CAMOFOX_URL || 'http://127.0.0.1:9377'}/health`],
  ]
  for (const [name, url] of probes) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
      process.stdout.write(`INFO  ${name}: HTTP ${response.status}\n`)
    } catch (error) {
      process.stdout.write(`INFO  ${name}: unreachable (${error.name})\n`)
    }
  }

  const failed = checks.filter((entry) => !entry.ok)
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`)
  if (failed.length > 0) process.exitCode = 1
}

await main()
