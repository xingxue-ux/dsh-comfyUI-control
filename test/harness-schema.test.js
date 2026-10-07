/**
 * Conformance test: the local tool compiler must project and validate exactly
 * like `@deepseek-ai/dsh-tools`.
 *
 * The plugin ships its own compiler because a user preset cannot resolve the
 * harness packages. This test loads the real implementation from the installed
 * harness and compares both the compiled JSON Schema of every tool in this
 * package and the violation lists for a battery of hostile argument values.
 *
 * Skipped when no harness installation can be found.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const harnessCandidates = [
  process.env.DSH_HARNESS_NODE_MODULES,
  join(homedir(), '.dsh', 'profiles', 'node_modules'),
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'npm-cache') : undefined,
]

async function loadHarness() {
  for (const candidate of harnessCandidates) {
    if (!candidate) continue
    try {
      const require = createRequire(join(candidate, 'noop.js'))
      const entry = require.resolve('@deepseek-ai/dsh-tools')
      return await import(pathToFileURL(entry).href)
    } catch {
      // Try the next candidate root.
    }
  }
  const appDir = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar.unpacked')
    : undefined
  if (appDir && existsSync(appDir)) {
    try {
      const require = createRequire(join(appDir, 'noop.js'))
      return await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tools')).href)
    } catch {
      // Fall through to the skip.
    }
  }
  return undefined
}

const harness = await loadHarness()
const local = await import('../lib/tool.js')
const plugin = await import('../lib/plugin.js')

const skip = harness ? false : 'no installed @deepseek-ai/dsh-tools found'

test('every tool compiles to the same JSON Schema as the harness', { skip }, () => {
  const tools = plugin.toolList()
  assert.ok(tools.length >= 13, `expected at least 13 tools, got ${tools.length}`)
  for (const tool of tools) {
    // Re-define the same author options through both factories.
    const options = optionsOf(tool)
    const viaHarness = harness.defineTool(options)
    const viaLocal = local.defineTool(options)
    assert.deepEqual(viaLocal.parameters, viaHarness.parameters, `${tool.name}: parameter schema differs`)
    assert.deepEqual(viaLocal.output.schema, viaHarness.output.schema, `${tool.name}: output schema differs`)
  }
})

test('argument validation matches the harness for every tool', { skip }, () => {
  const cases = [undefined, null, [], {}, { __unknown: true }]
  for (const tool of plugin.toolList()) {
    const options = optionsOf(tool)
    const viaHarness = harness.defineTool(options)
    for (const value of cases) {
      assert.deepEqual(
        local.validateArgs(options.parameters, value),
        harness.validateArgs(options.parameters, value),
        `${tool.name}: validateArgs(${JSON.stringify(value)}) differs`,
      )
      assert.deepEqual(
        local.checkJsonSchema(viaHarness.parameters, value, ''),
        harness.validateArgs(options.parameters, value),
        `${tool.name}: compiled-schema validation differs for ${JSON.stringify(value)}`,
      )
    }
  }
})

/**
 * Recover the author options a built tool was made from.
 *
 * `defineTool` consumes the author schema and stores the compiled projection, so
 * the plugin keeps the author form on the registry entry for exactly this test.
 */
function optionsOf(tool) {
  assert.ok(tool.__options, `${tool.name}: definition does not retain its author options`)
  return tool.__options
}
