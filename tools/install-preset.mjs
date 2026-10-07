/**
 * Install the 绘图模式 agent preset into a dsh home.
 *
 * Copies the preset composition plus a self-contained bundle of this package
 * into `<dshHome>/.agent-presets/<id>/`, which is the only place a user preset
 * lives. The preset names the bundle by relative path, so the two files travel
 * together and other presets never see the plugin.
 *
 * Usage:
 *   node tools/install-preset.mjs [--id drawing] [--dsh-home <dir>] [--force]
 *   node tools/install-preset.mjs --uninstall [--id drawing] [--dsh-home <dir>]
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundle } from './bundle.mjs'

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const PRESET_DIR = join(PACKAGE_DIR, 'preset')
// The plugin is a directory inside the preset that mirrors this package's shape:
// the bundle sits in `lib/`, so the plugin resolves its own root as the preset
// directory whether it runs from a checkout or from this copy.
const BUNDLE_DIR = 'dsh-comfyui-control'
const BUNDLE_ENTRY = `${BUNDLE_DIR}/lib/index.js`

function parseArgs(argv) {
  const options = { id: 'drawing', dshHome: process.env.DSH_HOME || join(homedir(), '.dsh'), force: false, uninstall: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--id') options.id = argv[++index]
    else if (arg === '--dsh-home') options.dshHome = argv[++index]
    else if (arg === '--force') options.force = true
    else if (arg === '--uninstall') options.uninstall = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(options.id)) throw new Error(`invalid preset id: ${options.id}`)
  options.dshHome = resolve(options.dshHome)
  return options
}

function usage() {
  process.stdout.write(`usage: node tools/install-preset.mjs [--id drawing] [--dsh-home <dir>] [--force] [--uninstall]\n`)
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  usage()
  process.exit(0)
}

const target = join(options.dshHome, '.agent-presets', options.id)

if (options.uninstall) {
  if (!existsSync(target)) {
    process.stdout.write(`nothing to remove: ${target}\n`)
    process.exit(0)
  }
  rmSync(target, { recursive: true, force: true })
  process.stdout.write(`removed ${target}\n`)
  process.exit(0)
}

if (existsSync(target) && !options.force) {
  const entries = readdirSync(target)
  if (entries.length > 0) {
    process.stderr.write(`refusing to overwrite ${target}: it already exists (pass --force to replace it)\n`)
    process.exit(1)
  }
}

mkdirSync(target, { recursive: true })
const pluginDir = join(target, BUNDLE_DIR)
mkdirSync(join(pluginDir, 'lib'), { recursive: true })
const bundlePath = join(pluginDir, 'lib', 'index.js')
writeFileSync(bundlePath, bundle(), 'utf8')
copyFileSync(join(PRESET_DIR, 'preset.yml'), join(target, 'preset.yml'))
copyFileSync(join(PRESET_DIR, 'agent.cordis.yml'), join(target, 'agent.cordis.yml'))
const guide = join(PACKAGE_DIR, 'docs', 'LORA_GUIDE.md')
let guidePaths = []
if (existsSync(guide)) {
  copyFileSync(guide, join(target, 'LORA_GUIDE.md'))
  // A second copy in the plugin's state directory, so the default install and a
  // checkout run from anywhere agree on where the guide lives.
  const stateDir = join(options.dshHome, 'storages', 'dsh-comfyui-control')
  mkdirSync(stateDir, { recursive: true })
  copyFileSync(guide, join(stateDir, 'LORA_GUIDE.md'))
  guidePaths = [join(target, 'LORA_GUIDE.md'), join(stateDir, 'LORA_GUIDE.md')]
}
// The Anima workflow travels with the preset so the installed copy is
// self-contained: the bundle resolves its own directory as its plugin root.
const pipeline = join(PACKAGE_DIR, 'pipeline.json')
if (existsSync(pipeline)) copyFileSync(pipeline, join(target, 'pipeline.json'))

const { toolList } = await import(`file:///${bundlePath.replace(/\\/g, '/')}?install=${Date.now()}`)

process.stdout.write([
  `installed 绘图模式 preset: ${target}`,
  `  preset.yml        display name and picker description`,
  `  agent.cordis.yml  composition; mounts ./${BUNDLE_ENTRY}`,
  `  ${BUNDLE_ENTRY}  self-contained plugin (${toolList().length} comfyui_* tools)`,
  ...(existsSync(join(target, 'pipeline.json')) ? ['  pipeline.json     Anima 管线 workflow（随预设一起安装）'] : []),
  ...(guidePaths.length > 0 ? [`  LORA_GUIDE.md     LoRA 规范（read 工具用这些路径）:`, ...guidePaths.map((path) => `                      ${path}`)] : []),
  '',
  'Other presets do not name this plugin, so they never see these tools.',
  'Select 绘图模式 in the agent-preset picker (or set it as the default) to use them.',
  '',
].join('\n'))
