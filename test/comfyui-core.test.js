/**
 * Unit tests for the ComfyUI engine and the tools' pure helpers, plus a live
 * smoke test against a locally running ComfyUI (skipped when it is absent).
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import { deflateSync } from 'node:zlib'
import { COMPARE_DIR, COMFYUI_URL, MCP_MARK, PLUGIN_DIR, VIEW_BASE } from '../lib/env.js'
import {
  buildKrea2Workflow,
  findNode,
  findNodes,
  historyToRuns,
  injectLoraChain,
  isStamped,
  loadPipeline,
  makeView,
  modelNames,
  parseLoraText,
  queueView,
  recentRunSources,
  stampSource,
  systemStats,
  validateResources,
  viewUrl,
} from '../lib/comfyui.js'
import { ANIMA_GUIDE, applyWorkflowWidgets, extractImageInfo, parseComfyPrompt, parsePngText, readImageInfo, tools } from '../lib/tools/comfyui.js'

const PIPELINE = join(PLUGIN_DIR, 'pipeline.json')

// ---------------------------------------------------------------- PNG fixtures

/** A PNG chunk with a zeroed CRC: the parser walks lengths, it does not verify. */
function chunk(type, data) {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(data.length, 0)
  header.write(type, 4, 'latin1')
  return Buffer.concat([header, data, Buffer.alloc(4)])
}

function textChunk(key, value) {
  return chunk('tEXt', Buffer.concat([Buffer.from(key, 'latin1'), Buffer.from([0]), Buffer.from(value, 'utf8')]))
}

function pngBytes(textChunks = {}, width = 4, height = 6) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const chunks = [chunk('IHDR', ihdr)]
  for (const [key, value] of Object.entries(textChunks)) chunks.push(textChunk(key, value))
  chunks.push(chunk('IDAT', deflateSync(Buffer.alloc(0))))
  chunks.push(chunk('IEND', Buffer.alloc(0)))
  return Buffer.concat([signature, ...chunks])
}

const POSITIVE = 'masterpiece, best quality, newest, 1girl, solo, varesa_(genshin_impact), looking at viewer, long flowing hair, detailed background'
const COMFY_PROMPT = {
  1: { class_type: 'UNETLoader', inputs: { unet_name: 'anima-base-v1.0.safetensors', weight_dtype: 'default' } },
  6: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_06b_base.safetensors', type: 'stable_diffusion' } },
  8: { class_type: 'CLIPTextEncode', inputs: { clip: ['6', 0], text: POSITIVE } },
  68: { class_type: 'CLIPTextEncode', inputs: { clip: ['6', 0], text: 'worst quality' } },
  5: { class_type: 'EmptyLatentImage', inputs: { width: 832, height: 1216, batch_size: 1 } },
  10: { class_type: 'LoraLoader', inputs: { lora_name: 'surtr945_v1.safetensors', strength_model: 0.8, strength_clip: 0.8 } },
  3: { class_type: 'KSampler', inputs: { seed: 110661221469510, steps: 30, cfg: 4.0, sampler_name: 'euler_ancestral', scheduler: 'simple', denoise: 1.0 } },
}

// ---------------------------------------------------------------- pipeline

test('pipeline loads and findNodes matches class type and title', () => {
  const graph = loadPipeline(PIPELINE)
  assert.equal(Object.keys(graph).length, 11)
  assert.equal(findNode(graph, 'UNETLoader')[1].inputs.unet_name, 'anima-base-v1.0.safetensors')
  assert.equal(findNode(graph, 'CLIPLoader')[1].inputs.type, 'stable_diffusion')
  assert.equal(findNode(graph, 'CLIPTextEncode', 'Positive')[0], '8')
  assert.equal(findNode(graph, 'CLIPTextEncode', 'Negative')[0], '68')
  assert.equal(findNodes(graph, 'KSampler').length, 1)
  assert.equal(findNodes(graph, 'CLIPTextEncode', 'Positive').length, 1)
  assert.equal(findNodes(graph, 'CLIPTextEncode', 'Missing').length, 0)
  assert.throws(() => findNode(graph, 'KSamplerAdvanced'), /node not found: KSamplerAdvanced/)
  assert.throws(() => loadPipeline(join(PLUGIN_DIR, 'no-such-pipeline.json')), /pipeline not found/)
  // the shipped pipeline is the default, so an argument-free load works
  assert.equal(findNode(loadPipeline(), 'SaveImage')[1].inputs.filename_prefix, 'Anima/%year%-%month%-%day%/anima')
})

test('parseLoraText reads name and strength and ignores malformed tags', () => {
  assert.deepEqual(parseLoraText('<lora:a.safetensors:0.3>, <lora:b.safetensors:0.85>'), [
    { name: 'a.safetensors', strength: 0.3 },
    { name: 'b.safetensors', strength: 0.85 },
  ])
  assert.deepEqual(parseLoraText('no loras here'), [])
  assert.deepEqual(parseLoraText('<lora:missing-strength.safetensors>'), [])
})

test('injectLoraChain builds a LoraLoader chain and rewires sampler and text encoders', () => {
  const graph = loadPipeline(PIPELINE)
  injectLoraChain(graph, '<lora:first.safetensors:0.3>, <lora:second.safetensors:0.8>')
  const clipId = findNode(graph, 'CLIPLoader')[0]
  const loras = findNodes(graph, 'LoraLoader').map(([id, node]) => [id, node])
  assert.equal(loras.length, 2)
  const [firstId, first] = loras[0]
  const [secondId, second] = loras[1]
  assert.ok(Number(firstId) > 68 && Number(secondId) > Number(firstId))
  // the first LoRA takes the CLIPLoader's single output, the rest take index 1
  assert.deepEqual(first.inputs.clip, [clipId, 0])
  assert.deepEqual(first.inputs.model, ['1', 0])
  assert.deepEqual(second.inputs.clip, [firstId, 1])
  assert.deepEqual(second.inputs.model, [firstId, 0])
  assert.equal(first.inputs.lora_name, 'first.safetensors')
  assert.equal(second.inputs.strength_clip, 0.8)
  assert.deepEqual(findNode(graph, 'KSampler')[1].inputs.model, [secondId, 0])
  assert.deepEqual(findNode(graph, 'CLIPTextEncode', 'Positive')[1].inputs.clip, [secondId, 1])
  assert.deepEqual(findNode(graph, 'CLIPTextEncode', 'Negative')[1].inputs.clip, [secondId, 1])
})

test('injectLoraChain leaves the graph untouched without lora tags', () => {
  const graph = loadPipeline(PIPELINE)
  const before = JSON.stringify(graph)
  injectLoraChain(graph, '')
  injectLoraChain(graph, undefined)
  assert.equal(JSON.stringify(graph), before)
})

test('stampSource marks every node and isStamped reads the marker', () => {
  const graph = loadPipeline(PIPELINE)
  assert.equal(isStamped(graph), false)
  stampSource(graph)
  assert.equal(isStamped(graph), true)
  assert.equal(graph['8']._meta.title, 'Positive')
  assert.equal(graph['8']._meta[MCP_MARK], true)
})

test('validateResources rejects out-of-range sizes without touching the network', async () => {
  await assert.rejects(validateResources({ width: 0 }), /invalid width: 0/)
  await assert.rejects(validateResources({ height: 4097 }), /invalid height: 4097/)
  await assert.rejects(validateResources({ unet: 'definitely-missing.safetensors' }), /resource not found: models\/diffusion_models\/definitely-missing.safetensors/)
  await assert.rejects(validateResources({ loras: ['definitely-missing-lora'] }), /resource not found: models\/loras\/definitely-missing-lora/)
  await validateResources({ width: 4096, height: 1 })
})

test('buildKrea2Workflow matches the Krea2 engine contract', () => {
  const graph = buildKrea2Workflow({ prompt: 'a girl', negativePrompt: 'blurry', seed: 7, loraList: [{ name: 'a.safetensors', strength: 0.5 }, { name: 'b.safetensors' }], upscale: true })
  assert.equal(graph['1'].inputs.clip_name, 'qwen3vl_4b_fp8_scaled.safetensors')
  assert.equal(graph['1'].inputs.type, 'krea2')
  assert.equal(graph['7'].inputs.steps, 8)
  assert.equal(graph['7'].inputs.cfg, 1.0)
  assert.equal(graph['7'].inputs.sampler_name, 'er_sde')
  assert.equal(graph['4'].inputs.text, 'a girl')
  assert.equal(graph['5'].inputs.text, 'blurry')
  assert.deepEqual(graph['20'].inputs.model, ['2', 0])
  assert.deepEqual(graph['21'].inputs.model, ['20', 0])
  assert.equal(graph['21'].inputs.strength_model, 1.0)
  assert.deepEqual(graph['7'].inputs.model, ['21', 0])
  assert.deepEqual(graph['50'].inputs.image, ['8', 0])
  assert.deepEqual(graph['9'].inputs.images, ['50', 0])
  assert.equal(graph['9'].inputs.filename_prefix, 'Krea2/%year%-%month%-%day%/krea')
  const plain = buildKrea2Workflow({ prompt: 'x', seed: 1 })
  assert.equal(plain['9'].inputs.images[0], '8')
  assert.equal(plain['48'], undefined)
})

// ---------------------------------------------------------------- extraction

test('parseComfyPrompt reads sampler, model, size, caption and LoRA flavours', () => {
  const generation = parseComfyPrompt(COMFY_PROMPT)
  assert.deepEqual(generation.sampler, { seed: 110661221469510, steps: 30, cfg: 4.0, sampler_name: 'euler_ancestral', scheduler: 'simple', denoise: 1.0 })
  assert.equal(generation.model, 'anima-base-v1.0.safetensors')
  assert.deepEqual(generation.size, [832, 1216])
  assert.equal(generation.prompt_text, POSITIVE)
  assert.deepEqual(generation.loras, [{ node: 'LoraLoader', lora: 'surtr945_v1.safetensors', strength: 0.8 }])

  const rgthree = parseComfyPrompt({ 1: { class_type: 'Power Lora Loader (rgthree)', inputs: { loras: { __value__: [{ on: true, lora: 'a.safetensors', strength: 0.5, strengthTwo: null }] } } } })
  assert.deepEqual(rgthree.loras, [{ node: 'Power Lora Loader (rgthree)', lora: 'a.safetensors', strength: 0.5, enabled: true }])

  const slots = parseComfyPrompt({ 2: { class_type: 'LoraLoader', inputs: { lora_1: { on: false, lora: 'b.safetensors', strength: 0.4 } } } })
  assert.deepEqual(slots.loras, [{ node: 'LoraLoader', lora: 'b.safetensors', strength: 0.4, enabled: false }])

  const loraData = JSON.stringify({ entries: [{ item_type: 'lora', lora_name: 'z.safetensors', weight: 0.7, enabled: true }, { item_type: 'model', lora_name: 'skip' }] })
  const zml = parseComfyPrompt({ 3: { class_type: 'ZML_PowerLoraLoader', inputs: { lora_loader_data: loraData } } })
  assert.deepEqual(zml.loras, [{ node: 'ZML_PowerLoraLoader', lora: 'z.safetensors', strength: 0.7, enabled: true }])
  assert.equal(parseComfyPrompt({}), undefined)
})

test('applyWorkflowWidgets fills what the prompt graph lacked', () => {
  const generation = { model: 'kept.safetensors' }
  applyWorkflowWidgets({
    nodes: [
      { type: 'ZML_PowerLoraLoader', widgets_values: [JSON.stringify({ entries: [{ item_type: 'lora', lora_name: 'w.safetensors', weight: 0.6, enabled: true }] })] },
      { type: 'Power Lora Loader (rgthree)', widgets_values: [{ __value__: [{ on: true, lora: 'r.safetensors', strength: 1, strengthTwo: null }] }] },
      { type: 'UNETLoader', widgets_values: ['ignored-because-model-is-set.safetensors'] },
      { type: 'KSampler', widgets_values: [123, 'randomize', 25, 5.5, 'dpmpp_2m', 'karras', 0.9] },
    ],
  }, generation)
  assert.equal(generation.model, 'kept.safetensors')
  assert.deepEqual(generation.sampler, { seed: 123, steps: 25, cfg: 5.5, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise: 0.9 })
  assert.deepEqual(generation.loras, [
    { node: 'ZML_PowerLoraLoader', lora: 'w.safetensors', strength: 0.6, enabled: true },
    { node: 'Power Lora Loader (rgthree)', lora: 'r.safetensors', strength: 1, enabled: true },
  ])

  const empty = {}
  const advanced = { type: 'KSamplerAdvanced', widgets_values: ['enable', 9, 'randomize', 12, 3.5, 'euler', 'normal', 1] }
  applyWorkflowWidgets({ nodes: [{ type: 'UNETLoader', widgets_values: ['from-workflow.safetensors'] }, advanced] }, empty)
  assert.equal(empty.model, 'from-workflow.safetensors')
  assert.deepEqual(empty.sampler, { seed: 9, steps: 12, cfg: 3.5, sampler_name: 'euler', scheduler: 'normal' })
})

test('parsePngText reads tEXt, iTXt and zTXt chunks', () => {
  const iTXtData = [Buffer.from('prompt', 'latin1'), Buffer.from([0, 0, 0]), Buffer.from(''), Buffer.from([0]), Buffer.from(''), Buffer.from([0]), Buffer.from('{"a":1}', 'utf8')]
  const iTXt = chunk('iTXt', Buffer.concat(iTXtData))
  const zTXt = chunk('zTXt', Buffer.concat([Buffer.from('Comment', 'latin1'), Buffer.from([0, 0]), deflateSync(Buffer.from('compressed comment'))]))
  const bytes = Buffer.concat([pngBytes({ Software: 'ComfyUI' }), iTXt, zTXt])
  const text = parsePngText(bytes)
  assert.equal(text.Software, 'ComfyUI')
  assert.equal(text.prompt, '{"a":1}')
  assert.equal(text.Comment, 'compressed comment')
})

test('extractImageInfo parses a ComfyUI-shaped PNG', () => {
  const bytes = pngBytes({ prompt: JSON.stringify(COMFY_PROMPT), workflow: JSON.stringify({ nodes: [] }), parameters: 'a girl\nSteps: 20, Sampler: Euler' })
  const info = extractImageInfo(bytes, 'synthetic.png')
  assert.equal(info.file, 'synthetic.png')
  assert.equal(info.format, 'png')
  assert.deepEqual(info.size, [4, 6])
  assert.equal(info.size_bytes, bytes.length)
  assert.equal(info.metadata.prompt, JSON.stringify(COMFY_PROMPT))
  assert.equal(info.error, undefined)
  assert.deepEqual(info.generation.sampler.steps, 30)
  assert.equal(info.generation.model, 'anima-base-v1.0.safetensors')
  assert.equal(info.generation.prompt_text, POSITIVE)
  assert.equal(info.generation.parameters_head, 'a girl\nSteps: 20, Sampler: Euler')
})

test('extractImageInfo reports other containers instead of guessing', () => {
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from([0x00, 0x10]), Buffer.alloc(14),
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x00, 0x03, 0x00]), Buffer.alloc(8),
    Buffer.from([0xff, 0xda, 0x00, 0x02]),
  ])
  const info = extractImageInfo(jpeg, 'synthetic.jpg')
  assert.equal(info.format, 'jpeg')
  assert.deepEqual(info.size, [768, 512])
  assert.match(info.note, /EXIF/)
  assert.deepEqual(info.metadata, {})
  assert.equal(extractImageInfo(Buffer.from('not an image'), 'x.bin').format, 'unknown')
  assert.match(extractImageInfo(Buffer.from('not an image'), 'x.bin').note, /unknown/)
})

test('readImageInfo reads a PNG back from disk and tolerates bad paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-comfyui-image-'))
  try {
    const path = join(dir, 'comfy.png')
    writeFileSync(path, pngBytes({ prompt: JSON.stringify(COMFY_PROMPT) }))
    const info = readImageInfo(path)
    assert.equal(info.format, 'png')
    assert.deepEqual(info.size, [4, 6])
    assert.deepEqual(info.generation.size, [832, 1216])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  assert.match(readImageInfo(join('no', 'such', 'file.png')).error, /cannot open image/)
})

// ---------------------------------------------------------------- web shapes

test('viewUrl builds the ComfyUI /view query', () => {
  assert.equal(
    viewUrl('output/Anima/2025-01-01/anima_00001_.png'),
    `${COMFYUI_URL}/view?filename=anima_00001_.png&subfolder=Anima%2F2025-01-01&type=output`,
  )
  assert.equal(viewUrl({ filename: 'a b.png', subfolder: '', type: 'temp' }), `${COMFYUI_URL}/view?filename=a%20b.png&subfolder=&type=temp`)
})

test('historyToRuns classifies stamped and manual graphs', () => {
  const stamped = stampSource(JSON.parse(JSON.stringify(COMFY_PROMPT)))
  const history = {
    manual1: {
      prompt: [1, 'manual1', COMFY_PROMPT, {}, {}],
      outputs: { 9: { images: [{ filename: 'manual.png', subfolder: 'Anima', type: 'output' }] } },
      status: { status_str: 'success', completed: true, messages: [['execution_start', { timestamp: 1000 }], ['execution_success', { timestamp: 4000 }]] },
    },
    mcp1: {
      prompt: [2, 'mcp1', stamped, {}, {}],
      outputs: { 9: { images: [{ filename: 'mcp.png', subfolder: '', type: 'output' }] } },
      status: { status_str: 'success', completed: true, messages: [] },
    },
  }
  const runs = historyToRuns(history)
  assert.equal(runs.length, 2)
  assert.equal(runs[0].prompt_id, 'manual1')
  assert.equal(runs[0].source, 'manual')
  assert.equal(runs[1].source, 'mcp')
  assert.equal(runs[0].completed, true)
  assert.equal(runs[0].timing.elapsed_s, 3)
  assert.equal(runs[0].outputs[0].node, '9')
  assert.equal(runs[0].outputs[0].ref, 'output/Anima/manual.png')
  assert.equal(runs[0].outputs[0].view_url, `${COMFYUI_URL}/view?filename=manual.png&subfolder=Anima&type=output`)
  assert.deepEqual(recentRunSources(history, 1)[0], { source: 'manual', outputs: ['manual.png'], prompt_id: 'manual1' })
  assert.deepEqual(historyToRuns({}), [])
})

test('makeView copies the output and builds a comparison page', async () => {
  const out = mkdtempSync(join(tmpdir(), 'dsh-comfyui-output-'))
  const created = []
  try {
    process.env.COMFYUI_OUTPUT = out
    writeFileSync(join(out, 'anima_00007_.png'), pngBytes({}, 4, 6))
    const result = { outputs: ['output/anima_00007_.png'] }
    await makeView(result)
    assert.equal(result.view_url, `${VIEW_BASE}/anima_00007_.png`)
    created.push(join(COMPARE_DIR, 'anima_00007_.png'))

    writeFileSync(join(out, 'reference.png'), pngBytes({}, 4, 6))
    const compared = { outputs: ['output/anima_00007_.png'] }
    await makeView(compared, join(out, 'reference.png'))
    assert.equal(compared.view_url, `${VIEW_BASE}/anima_00007_.html`)
    created.push(join(COMPARE_DIR, 'anima_00007_.html'), join(COMPARE_DIR, 'anima_00007__ref.png'))

    const missing = { outputs: ['output/nope.png'] }
    assert.deepEqual(await makeView(missing), { outputs: ['output/nope.png'] })
    assert.equal((await makeView({ outputs: [] })).view_url, undefined)
  } finally {
    delete process.env.COMFYUI_OUTPUT
    rmSync(out, { recursive: true, force: true })
    for (const path of created) rmSync(path, { force: true })
  }
})

// ---------------------------------------------------------------- tool surface

test('every tool is a defineTool definition with a render and a validate-args wrapper', async () => {
  assert.deepEqual(tools.map((tool) => tool.name), [
    'comfyui_status',
    'comfyui_list_models',
    'comfyui_generate',
    'comfyui_run_workflow',
    'comfyui_history',
    'comfyui_queue',
    'comfyui_node_info',
    'comfyui_extract_image_info',
    'comfyui_get_model_guide',
  ])
  for (const tool of tools) {
    assert.equal(typeof tool.execute, 'function', tool.name)
    assert.equal(typeof tool.output.render, 'function', tool.name)
    assert.equal(typeof tool.output.schema, 'object', tool.name)
    assert.ok(tool.description.length > 60, `${tool.name} needs a full description`)
  }
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
  assert.deepEqual(byName.comfyui_generate.parameters.properties.engine.enum, ['anima', 'krea2'])
  assert.equal(byName.comfyui_generate.parameters.required.includes('prompt'), true)
  assert.equal(byName.comfyui_generate.parameters.properties.lora_text.type, 'string')
  assert.deepEqual(byName.comfyui_queue.parameters.properties.action.enum, ['status', 'interrupt', 'clear'])
  assert.ok(byName.comfyui_list_models.parameters.properties.folder.enum.includes('models'))
  assert.ok(byName.comfyui_list_models.parameters.properties.folder.enum.includes('loras'))
  // defineTool installs the argument-validation wrapper
  await assert.rejects(byName.comfyui_node_info.execute({}), /invalid arguments/)
  const rendered = byName.comfyui_get_model_guide.output.render({}, ANIMA_GUIDE)
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, /anima-base-v1\.0/)
})

test('ANIMA_GUIDE keeps the upstream section names', async () => {
  assert.deepEqual(Object.keys(ANIMA_GUIDE), ['models', 'generation_settings', 'prompting', 'lora_tips', 'limitations', 'license'])
  assert.equal(ANIMA_GUIDE.models.length, 3)
  assert.deepEqual(ANIMA_GUIDE.models.map((model) => model.name), ['anima-base-v1.0', 'anima-aesthetic-v1.1', 'anima-turbo-v1.0'])
  assert.equal(await tools.find((tool) => tool.name === 'comfyui_get_model_guide').execute({}), ANIMA_GUIDE)
})

test('extract_image_info reads a real file through the tool', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-comfyui-tool-'))
  try {
    const path = join(dir, 'shot.png')
    writeFileSync(path, pngBytes({ prompt: JSON.stringify(COMFY_PROMPT), workflow: JSON.stringify({ nodes: [] }) }))
    const tool = tools.find((entry) => entry.name === 'comfyui_extract_image_info')
    const info = await tool.execute({ image_path: path }, {})
    assert.equal(info.format, 'png')
    assert.equal(info.generation.model, 'anima-base-v1.0.safetensors')
    const rendered = tool.output.render({}, info)
    assert.match(rendered[0].text, /anima-base-v1\.0/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- live smoke

async function comfyuiReachable() {
  try {
    const response = await fetch(`${COMFYUI_URL}/system_stats`, { signal: AbortSignal.timeout(3000) })
    return response.ok
  } catch {
    return false
  }
}

const skipLive = (await comfyuiReachable()) ? false : `ComfyUI unreachable at ${COMFYUI_URL}`

test('live: system stats, model listing and queue', { skip: skipLive }, async () => {
  const signal = AbortSignal.timeout(30000)
  const stats = await systemStats({ signal })
  assert.ok(stats.system || stats.devices)
  const names = await modelNames('diffusion_models', { signal })
  assert.ok(names.length > 0)
  const queue = await queueView({ signal })
  assert.equal(Number.isInteger(queue.running_count), true)
  assert.equal(Number.isInteger(queue.pending_count), true)
})

test('live: comfyui_status reports the local server online', { skip: skipLive }, async () => {
  const status = await tools.find((tool) => tool.name === 'comfyui_status').execute({}, { signal: AbortSignal.timeout(60000) })
  assert.equal(status.comfyui, 'online')
  assert.equal(status.pipeline_exists, true)
  assert.equal(status.ready, true, `missing: ${JSON.stringify(status.missing)}`)
  assert.equal(existsSync(PIPELINE), true)
  assert.equal(basename(status.pipeline), 'pipeline.json')
})

test('live: queue actions answer on an idle queue', { skip: skipLive }, async () => {
  // /interrupt and POST /queue reply with an empty 200, which must not be read
  // as JSON. Only exercised when the queue is idle so a test run never
  // interrupts or clears somebody's job.
  const signal = AbortSignal.timeout(30000)
  const queue = await queueView({ signal })
  if (queue.running_count !== 0 || queue.pending_count !== 0) return
  const queueTool = tools.find((tool) => tool.name === 'comfyui_queue')
  assert.equal((await queueTool.execute({ action: 'interrupt' }, { signal })).ok, true)
  assert.equal((await queueTool.execute({ action: 'clear' }, { signal })).ok, true)
})
