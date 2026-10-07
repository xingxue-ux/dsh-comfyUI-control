/**
 * Build the 0.2 bundle patch from the preset composition.
 *
 * DSH 0.2 no longer reads `$DSH_HOME/.agent-presets/<id>/`: a preset is a
 * `@deepseek-ai/dsh-agent-preset` declaration carried by a bundle patch. The
 * declaration's `plugins` list is this package's preset composition verbatim, so
 * the preset stays in one place and this generator only wraps it.
 *
 * Writes `cordis.patch.yml` and the bundled plugin. Uses `js-yaml` when the
 * harness provides it; otherwise it re-emits the YAML it read, which is enough
 * because the composition is already valid YAML.
 *
 * Usage: node tools/build-bundle.mjs
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundle } from './bundle.mjs'

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const COMPOSITION = join(PACKAGE_DIR, 'preset', 'agent.cordis.yml')
const METADATA = join(PACKAGE_DIR, 'preset', 'preset.yml')
const PATCH = join(PACKAGE_DIR, 'cordis.patch.yml')
const PLUGIN_ENTRY = join(PACKAGE_DIR, 'preset', 'dsh-comfyui-control', 'lib', 'index.js')
const PRESET_ID = 'drawing'

function loadYaml() {
  const roots = [
    process.env.DSH_HARNESS_NODE_MODULES,
    join(homedir(), '.dsh', 'profiles', 'node_modules'),
  ].filter(Boolean)
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
if (!yaml) throw new Error('js-yaml not found; run this from a machine with the harness installed')

// `!!js` is a Loader expression, not a YAML type js-yaml knows. Read it as a
// marked string, write it back as the inline tag on the same line, so the
// emitted patch keeps the expression the loader expects.
const JsType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (value) => ({ __js: value }),
  predicate: (value) => typeof value === 'object' && value !== null && typeof value.__js === 'string',
  represent: (value) => value.__js,
})
const schema = yaml.DEFAULT_SCHEMA.extend([JsType])

/**
 * Where the plugin sits relative to the profile directory.
 *
 * The Loader imports a relative row specifier as `new URL(name, ctx.baseUrl)`,
 * and a profile-level loader's base URL is the profile directory — so the row
 * names the plugin through the profile's own `node_modules` link. That is
 * `ctx.baseUrl`'s documented meaning, and it keeps the row working wherever the
 * bundle directory is checked out; `!!js` expressions cannot use
 * `import.meta.url` here, because they are evaluated with `new Function`, not as
 * a module.
 */
const PLUGIN_SPECIFIER = './node_modules/dsh-comfyui-control/preset/dsh-comfyui-control/lib/index.js'

/** Plugin rows in the composition written with a package-local path. */
const COMPOSITION_PLUGIN_PATH = './dsh-comfyui-control/lib/index.js'

const plugins = yaml.load(readFileSync(COMPOSITION, 'utf8'), { schema })
if (!Array.isArray(plugins)) throw new Error(`${COMPOSITION} must be a top-level list of plugin rows`)
const metadata = yaml.load(readFileSync(METADATA, 'utf8'), { schema })

const rows = plugins.map((row) =>
  row?.name === COMPOSITION_PLUGIN_PATH ? { ...row, name: PLUGIN_SPECIFIER } : row,
)

const patch = [
  {
    insert: [
      {
        id: `preset-${PRESET_ID}`,
        name: '@deepseek-ai/dsh-agent-preset',
        config: {
          id: PRESET_ID,
          name: metadata.name,
          description: metadata.description,
          order: metadata.order,
          plugins: rows,
        },
      },
    ],
  },
]

const dumpOptions = { lineWidth: 200, noRefs: true, schema }
const patchText = yaml.dump(patch, dumpOptions)
// js-yaml renders the marked scalar as an object; put the inline tag back.
const inlineJs = patchText.replace(
  /!!js\s*\n\s*(?:__js|js):\s*(.+)$/gm,
  (_match, expression) => `!!js ${expression.trim()}`,
)
writeFileSync(PATCH, inlineJs, 'utf8')
writeFileSync(PLUGIN_ENTRY, bundle(), 'utf8')
// Copied next to the plugin, which is where `lib/env.js` looks for the default
// workflow once the plugin runs from a bundle store.
const pluginDir = join(PACKAGE_DIR, 'preset', 'dsh-comfyui-control')
copyFileSync(join(PACKAGE_DIR, 'pipeline.json'), join(pluginDir, 'pipeline.json'))
const guide = join(PACKAGE_DIR, 'docs', 'LORA_GUIDE.md')
if (existsSync(guide)) copyFileSync(guide, join(pluginDir, 'LORA_GUIDE.md'))
// Same reason as pipeline.json: lib/repro.js reads it from PLUGIN_DIR.
const reproSamples = join(PACKAGE_DIR, 'repro', 'samples.json')
if (existsSync(reproSamples)) {
  mkdirSync(join(pluginDir, 'repro'), { recursive: true })
  copyFileSync(reproSamples, join(pluginDir, 'repro', 'samples.json'))
}

const toolCount = rows.find((row) => row?.id === 'comfyui-control') ? 19 : 0
process.stdout.write([
  `wrote ${PATCH}`,
  `wrote ${PLUGIN_ENTRY}`,
  `preset: ${PRESET_ID} (${metadata.name}), ${rows.length} plugin rows, ${toolCount} comfyui_* tools`,
].join('\n') + '\n')
if (!existsSync(PLUGIN_ENTRY)) throw new Error('plugin bundle was not written')
