/**
 * Bundle-shape tests.
 *
 * A DSH 0.2 preset is a `@deepseek-ai/dsh-agent-preset` declaration carried by a
 * bundle patch; `$DSH_HOME/.agent-presets/<id>/` is no longer read. These tests
 * pin the shipped bundle layout: the patch declares the preset with this
 * package's plugin rows verbatim, and the plugin the row names is the committed
 * build output.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { bundle } from '../tools/bundle.mjs'
import { toolList } from '../lib/plugin.js'

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const COMPOSITION = join(PACKAGE_DIR, 'preset', 'agent.cordis.yml')
const METADATA = join(PACKAGE_DIR, 'preset', 'preset.yml')
const PATCH = join(PACKAGE_DIR, 'cordis.patch.yml')
const PLUGIN = join(PACKAGE_DIR, 'preset', 'dsh-comfyui-control', 'lib', 'index.js')
const PRESET_ID = 'drawing'

function loadYaml() {
  const roots = [process.env.DSH_HARNESS_NODE_MODULES, join(homedir(), '.dsh', 'profiles', 'node_modules')].filter(Boolean)
  for (const root of roots) {
    try {
      return createRequire(join(root, 'noop.js'))('js-yaml')
    } catch {
      // try the next root
    }
  }
  return undefined
}

const yaml = loadYaml()
const JsType = yaml
  ? new yaml.Type('tag:yaml.org,2002:js', {
      kind: 'scalar',
      construct: (value) => ({ __js: value }),
      predicate: (value) => typeof value === 'object' && value !== null && typeof value.__js === 'string',
      represent: (value) => value.__js,
    })
  : undefined
const schema = yaml?.DEFAULT_SCHEMA.extend([JsType])

const skipYaml = yaml ? false : 'js-yaml not available (needs a harness install)'

test('the bundle declares its patch through package.json', () => {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'))
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.ok(existsSync(PATCH), 'the declared patch exists')
})

test('the patch declares one preset row with this package\'s plugin list', { skip: skipYaml }, () => {
  const patch = yaml.load(readFileSync(PATCH, 'utf8'), { schema })
  assert.ok(Array.isArray(patch), 'a patch is a top-level list')
  const rows = patch.flatMap((row) => (Array.isArray(row?.insert) ? row.insert : [row]))
  assert.equal(rows.length, 1, 'this bundle inserts exactly one row')
  const row = rows[0]
  assert.equal(row.id, `preset-${PRESET_ID}`)
  assert.equal(row.name, '@deepseek-ai/dsh-agent-preset')
  assert.equal(row.config.id, PRESET_ID)
  assert.equal(row.config.name, '绘图模式')
  assert.ok(typeof row.config.description === 'string' && row.config.description.length > 20)

  const composition = yaml.load(readFileSync(COMPOSITION, 'utf8'), { schema })
  // The build rewrites exactly one field: the plugin row's path becomes the
  // location the patch owns, so a bundle store can resolve it.
  const normalized = row.config.plugins.map((plugin) =>
    plugin?.id === 'comfyui-control' ? { ...plugin, name: './dsh-comfyui-control/lib/index.js' } : plugin,
  )
  assert.deepEqual(normalized, composition, 'the declaration carries the composition verbatim')
})

test('the preset mounts the plugin by a path this bundle owns', { skip: skipYaml }, () => {
  const patch = yaml.load(readFileSync(PATCH, 'utf8'), { schema })
  const [row] = patch.flatMap((entry) => entry.insert ?? [entry])
  const plugins = row.config.plugins
  const control = plugins.find((plugin) => plugin?.id === 'comfyui-control')
  assert.ok(control, 'the preset must mount the plugin')
  // A bundle store moves this directory, so the row derives the plugin URL from
  // the patch's own module URL instead of naming a path the store would break.
  assert.deepEqual(control.name, { __js: "new URL('preset/dsh-comfyui-control/lib/index.js', import.meta.url).href" })
  // A bundle store does not resolve harness packages for a preset row.
  for (const plugin of plugins) {
    if (plugin?.name === undefined) continue
    if (typeof plugin.name === 'object') continue
    if (plugin.name.startsWith('./') || plugin.name.startsWith('cordis:')) continue
    assert.match(plugin.name, /^@deepseek-ai\//, `${plugin.id} names an unresolved package: ${plugin.name}`)
  }
  // `!!js` survives the round trip as the inline tag the loader expects.
  assert.match(readFileSync(PATCH, 'utf8'), /disabled: !!js process\.platform === 'win32'/)
  assert.match(readFileSync(PATCH, 'utf8'), /disabled: !!js process\.platform !== 'win32'/)
  assert.match(readFileSync(PATCH, 'utf8'), /name: !!js new URL\('preset\/dsh-comfyui-control\/lib\/index\.js', import\.meta\.url\)\.href/)
})

test('the preset metadata is the 绘图模式 display text', () => {
  const metadata = readFileSync(METADATA, 'utf8')
  assert.match(metadata, /^name: 绘图模式$/m)
  assert.match(metadata, /^order: \d+$/m)
})

test('only the preset composition names the plugin', () => {
  const composition = readFileSync(COMPOSITION, 'utf8')
  const rows = composition.split('\n').filter((line) => /dsh-comfyui-control/.test(line))
  assert.equal(rows.length, 1, `the plugin is named once: ${rows.join(' | ')}`)
  assert.match(rows[0], /'\.\/dsh-comfyui-control\/lib\/index\.js'/)
})

test('the committed plugin build matches a fresh one', () => {
  assert.ok(existsSync(PLUGIN), 'the built plugin is committed')
  assert.equal(readFileSync(PLUGIN, 'utf8'), bundle(), 'run `npm run build` and commit the result')
})

test('the built plugin registers the full catalog', async () => {
  const built = await import(`file:///${PLUGIN.replace(/\\/g, '/')}?test=${Date.now()}`)
  assert.equal(built.name, 'dsh-comfyui-control')
  assert.deepEqual(built.toolList().map((tool) => tool.name).sort(), toolList().map((tool) => tool.name).sort())
  const registered = []
  built.apply({ tools: { register: (definition) => { registered.push(definition.name); return () => {} } }, on: () => {} })
  assert.equal(registered.length, toolList().length)
})
