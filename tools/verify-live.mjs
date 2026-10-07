/**
 * Live end-to-end probe of the built tools against the local services.
 *
 * Not part of the test suite: `node tools/verify-live.mjs` runs each tool that
 * has a live dependency and prints the evidence, so a reviewer can see the real
 * outputs without reading the suite's INFO lines.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { toolList } from '../lib/plugin.js'
import { COMFYUI_ROOT, outputDir } from '../lib/env.js'

const tools = new Map(toolList().map((tool) => [tool.name, tool]))
const exec = { signal: undefined }
const calls = []

async function call(name, args) {
  const tool = tools.get(name)
  if (!tool) throw new Error(`no such tool: ${name}`)
  const started = Date.now()
  try {
    const value = await tool.execute(args, exec)
    calls.push({ name, ms: Date.now() - started, value })
    process.stdout.write(`\n=== ${name} (${Date.now() - started}ms) ===\n`)
    process.stdout.write(`${JSON.stringify(value, null, 1).slice(0, 1400)}\n`)
  } catch (error) {
    calls.push({ name, ms: Date.now() - started, error })
    process.stdout.write(`\n=== ${name} FAILED (${Date.now() - started}ms) ===\n${error.message}\n`)
  }
}

function newestOutput() {
  const root = outputDir()
  const found = []
  const walk = (dir, depth) => {
    if (depth > 4 || !existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path, depth + 1)
      else if (entry.name.endsWith('.png')) found.push(path)
    }
  }
  walk(root, 0)
  return found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
}

await call('comfyui_status', {})
await call('comfyui_list_models', { folder: 'loras' })
await call('comfyui_queue', {})
await call('comfyui_get_model_guide', {})
await call('comfyui_setup_guide', {})
await call('comfyui_list_cached_characters', {})
await call('comfyui_lookup_character_tags', { character: 'hatsune miku' })

const image = newestOutput()
if (image) {
  process.stdout.write(`\n(probe image: ${image})\n`)
  await call('comfyui_extract_image_info', { image_path: image })
  const encoded = image.replace(/\.png$/i, '_enc.png')
  await call('comfyui_deconfuse_image', { image_path: image, mode: 'enc', times: 1, out_path: encoded })
  await call('comfyui_deconfuse_image', { image_path: encoded, mode: 'dec', times: 1 })
  // Vision is opt-in: the disabled default must return the explanation and
  // touch nothing. The enabled route needs the host services, so it is exercised
  // by the test suite's stubs rather than here.
  await call('comfyui_describe_image', { image_path: image, question: '用一句话描述这张图。' })
} else {
  process.stdout.write(`\n(no PNG under ${outputDir()})\n`)
}

await call('comfyui_search_lora', { filename: 'surtr945_v1.safetensors' })
const lora = join(COMFYUI_ROOT, 'models', 'loras', 'surtr945_v1.safetensors')
if (existsSync(lora)) {
  await call('comfyui_lookup_lora_hash', { local_path: lora })
} else {
  process.stdout.write(`\n(missing ${lora})\n`)
}

const failed = calls.filter((entry) => entry.error)
process.stdout.write(`\n${calls.length - failed.length}/${calls.length} live calls succeeded${failed.length ? `; failed: ${failed.map((entry) => entry.name).join(', ')}` : ''}\n`)
if (failed.length > 0) process.exitCode = 1
