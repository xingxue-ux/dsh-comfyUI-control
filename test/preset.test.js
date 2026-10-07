/**
 * Preset isolation tests.
 *
 * The plugin must live in exactly one agent preset (绘图模式) and be invisible to
 * every other mode. These tests read the real preset trees: this package's
 * preset, the presets shipped inside `dsh-agent-presets`, and the user's own
 * presets under `<dshHome>/.agent-presets`.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const SHIPPED_PRESETS = join(DSH_HOME, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets')
const USER_PRESETS = join(DSH_HOME, '.agent-presets')
const PLUGIN_RE = /dsh-comfyui-control/i

function loadYaml(path) {
  const require = createRequire(join(DSH_HOME, 'profiles', 'noop.js'))
  const yaml = require('js-yaml')
  const JsExpr = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (value) => ({ __js: value }) })
  const schema = yaml.DEFAULT_SCHEMA.extend([JsExpr])
  return yaml.load(readFileSync(path, 'utf8'), { schema })
}

/** Every preset composition directory that exists on this machine. */
function presetDirs() {
  const dirs = [{ id: 'drawing (this package)', dir: join(PACKAGE_DIR, 'preset') }]
  for (const [root, prefix] of [[SHIPPED_PRESETS, 'shipped'], [USER_PRESETS, 'user']]) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push({ id: `${prefix}:${entry.name}`, dir: join(root, entry.name) })
    }
  }
  return dirs.filter(({ dir }) => existsSync(join(dir, 'agent.cordis.yml')))
}

test('the package preset composes through the loader dialect', () => {
  const composition = loadYaml(join(PACKAGE_DIR, 'preset', 'agent.cordis.yml'))
  assert.ok(Array.isArray(composition), 'a composition is a top-level list of rows')
  const rows = composition.flatMap((row) => (Array.isArray(row?.insert) ? row.insert : [row]))
  const ids = rows.map((row) => row?.id)
  assert.equal(new Set(ids).size, ids.length, `duplicate row ids: ${ids.join(', ')}`)
  const plugin = rows.find((row) => row?.id === 'comfyui-control')
  assert.ok(plugin, 'the preset must mount the plugin')
  assert.equal(plugin.name, './dsh-comfyui-control.js', 'the preset ships the bundled plugin beside itself')
  // No row may declare a harness package this preset cannot resolve.
  for (const row of rows) {
    if (typeof row?.name !== 'string') continue
    if (row.name === './dsh-comfyui-control.js' || row.name.startsWith('cordis:')) continue
    assert.match(row.name, /^@deepseek-ai\//, `${row.id} names a package the preset cannot resolve: ${row.name}`)
  }
})

test('only 绘图模式 names the plugin', () => {
  const naming = []
  for (const { id, dir } of presetDirs()) {
    const text = readFileSync(join(dir, 'agent.cordis.yml'), 'utf8')
    if (PLUGIN_RE.test(text)) naming.push(id)
  }
  assert.deepEqual(naming, ['drawing (this package)'], `these presets also name the plugin: ${naming.join(', ')}`)
  const modes = presetDirs().map(({ id }) => id)
  for (const mode of ['shipped:standard', 'shipped:minimal', 'shipped:ptc', 'shipped:cordis']) {
    if (modes.includes(mode)) assert.ok(!naming.includes(mode), `${mode} must not name the plugin`)
  }
})

test('the preset display name is 绘图模式', () => {
  const metadata = loadYaml(join(PACKAGE_DIR, 'preset', 'preset.yml'))
  assert.equal(metadata.name, '绘图模式')
  assert.ok(metadata.description.length > 20)
})

test('the bundle beside the preset is what the composition loads', () => {
  const bundlePath = join(PACKAGE_DIR, 'preset', 'dsh-comfyui-control.js')
  if (existsSync(bundlePath)) {
    assert.match(readFileSync(bundlePath, 'utf8'), /export const apply/)
  }
})
