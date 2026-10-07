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
const BUNDLE_NAME = 'dsh-comfyui-control.js'

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
const source = bundle()
writeFileSync(join(target, BUNDLE_NAME), source, 'utf8')
copyFileSync(join(PRESET_DIR, 'preset.yml'), join(target, 'preset.yml'))
copyFileSync(join(PRESET_DIR, 'agent.cordis.yml'), join(target, 'agent.cordis.yml'))
const guide = join(PACKAGE_DIR, 'docs', 'LORA_GUIDE.md')
if (existsSync(guide)) copyFileSync(guide, join(target, 'LORA_GUIDE.md'))

const { toolList } = await import(`file:///${join(target, BUNDLE_NAME).replace(/\\/g, '/')}?install=${Date.now()}`)

process.stdout.write([
  `installed 绘图模式 preset: ${target}`,
  `  preset.yml        display name and picker description`,
  `  agent.cordis.yml  composition; mounts ./${BUNDLE_NAME}`,
  `  ${BUNDLE_NAME}  self-contained plugin (${toolList().length} comfyui_* tools)`,
  '',
  'Other presets do not name this plugin, so they never see these tools.',
  'Select 绘图模式 in the agent-preset picker (or set it as the default) to use them.',
  '',
].join('\n'))
