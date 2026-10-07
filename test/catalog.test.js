/**
 * Package-level tests: the tool catalog, the preset composition, and the
 * bundle used to install the plugin into a preset directory.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { ToolArgsError, checkJsonSchema, defineTool, parameterSchema, validateArgs } from '../lib/tool.js'
import { apply, toolList } from '../lib/plugin.js'
import { bundle } from '../tools/bundle.mjs'

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

const EXPECTED_TOOLS = [
  'comfyui_status',
  'comfyui_setup_guide',
  'comfyui_get_model_guide',
  'comfyui_list_models',
  'comfyui_generate',
  'comfyui_repro_check',
  'comfyui_run_workflow',
  'comfyui_history',
  'comfyui_queue',
  'comfyui_node_info',
  'comfyui_extract_image_info',
  'comfyui_describe_image',
  'comfyui_deconfuse_image',
  'comfyui_lookup_character_tags',
  'comfyui_lookup_character_appearance',
  'comfyui_list_cached_characters',
  'comfyui_search_lora',
  'comfyui_download_lora',
  'comfyui_lookup_lora_hash',
]

test('the catalog exposes every tool of the reference server', () => {
  const names = toolList().map((tool) => tool.name)
  assert.deepEqual([...names].sort(), [...EXPECTED_TOOLS].sort())
  assert.equal(new Set(names).size, names.length, 'tool names must be unique')
})

test('every definition satisfies the tool contract', () => {
  const allowed = ['type', 'oneOf', 'description', 'title', 'default', 'examples', 'required', 'properties', 'additionalProperties', 'items', 'enum', 'const']
  for (const tool of toolList()) {
    assert.match(tool.name, /^[a-z][a-z0-9_]*$/, `${tool.name} is not a valid tool name`)
    assert.ok(tool.description.length > 40, `${tool.name} needs a model-facing description`)
    assert.equal(tool.parameters.type, 'object', `${tool.name} parameters must be an object root`)
    assert.ok(tool.parameters.properties, `${tool.name} needs a parameters object`)
    assert.equal(typeof tool.execute, 'function', `${tool.name} needs execute`)
    assert.equal(typeof tool.output.render, 'function', `${tool.name} needs output.render`)
    assert.ok(tool.output.schema, `${tool.name} needs an output schema`)
    for (const [key, property] of Object.entries(tool.parameters.properties)) {
      for (const field of Object.keys(property)) {
        assert.ok(allowed.includes(field), `${tool.name}.${key} uses unsupported schema field "${field}"`)
      }
      if (property.type === 'object') assert.equal(typeof property.additionalProperties, 'boolean', `${tool.name}.${key} needs additionalProperties`)
      // A typeless property is the harness's "any JSON value" node, which is
      // only meaningful when it at least carries a description.
      assert.ok(property.type || property.oneOf || property.description, `${tool.name}.${key} declares nothing`)
    }
  }
})

test('argument validation rejects malformed calls before execute runs', async () => {
  const parameters = {
    path: { type: 'string', required: true },
    count: { type: 'integer' },
    ratio: { type: 'number' },
    flag: { type: 'boolean' },
    items: { type: 'array', items: { type: 'string' } },
    nested: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', required: true } } },
  }
  const schema = { type: 'object', properties: parameterSchema(parameters), required: ['path'] }
  const tool = defineTool({
    name: 'sample',
    description: 'sample tool used by the validation test',
    parameters,
    output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: 'ok' }] },
    execute: async (args) => args,
  })

  assert.deepEqual(validateArgs(parameters, { path: 'x' }), [])
  assert.deepEqual(validateArgs(parameters, {}), ['missing required property "path"'])
  assert.deepEqual(validateArgs(parameters, { path: 1 }), ['"path" must be a string'])
  assert.deepEqual(validateArgs(parameters, { path: 'x', count: 1.5 }), ['"count" must be an integer'])
  assert.deepEqual(validateArgs(parameters, { path: 'x', ratio: Number.NaN }), ['"ratio" must be a finite JSON number'])
  assert.deepEqual(validateArgs(parameters, { path: 'x', flag: 'yes' }), ['"flag" must be a boolean'])
  assert.deepEqual(validateArgs(parameters, { path: 'x', items: [1] }), ['"items[0]" must be a string'])
  assert.deepEqual(validateArgs(parameters, { path: 'x', nested: {} }), ['missing required property "nested.name"'])
  assert.deepEqual(validateArgs(parameters, { path: 'x', nested: { name: 'n', extra: 1 } }), ['"nested.extra" is not a declared property (additionalProperties: false)'])
  assert.deepEqual(validateArgs(parameters, { path: 'x', unknown: 1 }), [], 'the parameter root stays open')
  // The compiled projection is what the registry enforces and what a call is validated against.
  assert.deepEqual(checkJsonSchema(schema, { path: 'x' }, ''), [])
  assert.deepEqual(checkJsonSchema(schema, {}, ''), ['missing required property "path"'])

  await assert.rejects(() => tool.execute({}, undefined), ToolArgsError)
})

test('apply registers every tool and disposes them together', () => {
  const registered = new Map()
  const disposers = []
  const ctx = {
    tools: {
      register(definition) {
        assert.ok(!registered.has(definition.name), `${definition.name} registered twice`)
        registered.set(definition.name, definition)
        const dispose = () => registered.delete(definition.name)
        disposers.push(dispose)
        return dispose
      },
    },
    on() {},
  }
  const dispose = apply(ctx)
  assert.deepEqual([...registered.keys()].sort(), [...EXPECTED_TOOLS].sort())
  dispose()
  assert.equal(registered.size, 0)
  assert.equal(disposers.length, EXPECTED_TOOLS.length)
})

test('the preset composition parses and names the bundled plugin', () => {
  const composition = readFileSync(join(PACKAGE_DIR, 'preset', 'agent.cordis.yml'), 'utf8')
  assert.match(composition, /^- id: comfyui-control$/m)
  assert.match(composition, /name: '\.\/dsh-comfyui-control\/lib\/index\.js'/)
  assert.match(composition, /name: '@deepseek-ai\/dsh-persona'/)
  assert.match(composition, /- id: tool-fs$|name: '@deepseek-ai\/dsh-tool-fs'/m)
  const preset = readFileSync(join(PACKAGE_DIR, 'preset', 'preset.yml'), 'utf8')
  assert.match(preset, /^name: 绘图模式$/m)

  // Rows that consume a service must sit inside a group; this preset has none.
  assert.ok(!/provide\(/.test(composition), 'the preset publishes no service')
})

test('the bundled plugin is self-contained and re-exports the plugin surface', async () => {
  const source = bundle()
  assert.match(source, /export const apply/)
  assert.match(source, /export const toolList/)
  for (const match of source.matchAll(/^\s*import\b[^'"]*?from\s*(['"])([^'"]+)\1/gm)) {
    assert.ok(match[2].startsWith('node:'), `the bundle must not depend on ${match[2]}`)
  }
  const target = join(PACKAGE_DIR, 'test', '.tmp-bundle.mjs')
  const { writeFileSync, rmSync } = await import('node:fs')
  writeFileSync(target, source, 'utf8')
  try {
    const bundled = await import(`${new URL(`file:///${target.replace(/\\/g, '/')}`).href}?t=${Date.now()}`)
    assert.equal(bundled.name, 'dsh-comfyui-control')
    assert.deepEqual(bundled.toolList().map((tool) => tool.name).sort(), [...EXPECTED_TOOLS].sort())
    assert.equal(typeof bundled.apply, 'function')
    const registered = []
    bundled.apply({ tools: { register: (definition) => { registered.push(definition.name); return () => {} } }, on: () => {} })
    assert.equal(registered.length, EXPECTED_TOOLS.length)
  } finally {
    rmSync(target, { force: true })
  }
})
