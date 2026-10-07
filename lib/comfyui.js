/**
 * The ComfyUI engine: pipeline loading and rewriting, submission and polling,
 * the web-API surface (system stats, models, object_info, queue, history) and
 * the compare viewer.
 *
 * Ported from good-comfyui-mcp's pipeline / krea2 / server_info sections. Every
 * request goes through lib/http.js; this module never shells out.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { COMPARE_DIR, COMFYUI_URL, DEFAULT_PIPELINE, MCP_MARK, VIEW_BASE, ensureDir, modelsDir, outputDir } from './env.js'
import { getJson, postJson, sleep, HttpError } from './http.js'

/** Client id every submission carries; the same string stamps each node's `_meta`. */
const CLIENT_ID = MCP_MARK
/** How often the history of a submitted prompt is polled, and the default request timeout. */
const POLL_MS = 2000
const REQUEST_TIMEOUT_MS = 30000

/** Loaders used to list a folder when ComfyUI has no /models/{folder} route. */
const FOLDER_LOADERS = {
  checkpoints: 'CheckpointLoaderSimple',
  diffusion_models: 'UNETLoader',
  unet: 'UNETLoader',
  loras: 'LoraLoader',
  vae: 'VAELoader',
  text_encoders: 'CLIPLoader',
  clip: 'CLIPLoader',
  upscale_models: 'UpscaleModelLoader',
  controlnet: 'ControlNetLoader',
  clip_vision: 'CLIPVisionLoader',
  style_models: 'StyleModelLoader',
  photomaker: 'PhotoMakerLoader',
  gligen: 'GLIGENLoader',
  hypernetworks: 'HypernetworkLoader',
}

/** The default Krea2/Dasiwa finetune; official int8 is krea2_turbo_int8_convrot.safetensors. */
export const KREA2_UNET = 'DasiwaKrea2TurboRaw_cutedisasterV2Turbo.safetensors'

/** ComfyUI did not finish the prompt before the caller's deadline. */
export class ComfyTimeoutError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ComfyTimeoutError'
  }
}

function randomSeed() {
  return Math.floor(Math.random() * 2 ** 53)
}

function cap(text, limit) {
  if (typeof text !== 'string') return text
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

// ---------------------------------------------------------------- pipeline

/**
 * Read the pipeline workflow (defaults to `PIPELINE` / the shipped copy).
 * @throws when the file is missing or is not a JSON object.
 */
export function loadPipeline(path = DEFAULT_PIPELINE) {
  if (!existsSync(path)) throw new Error(`pipeline not found: ${path}`)
  const graph = JSON.parse(readFileSync(path, 'utf8'))
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) throw new Error(`pipeline is not a node graph: ${path}`)
  return graph
}

/**
 * Every node of `classType` whose `_meta.title` contains `titlePart` (all
 * matches when `titlePart` is omitted), as `[nodeId, node]` pairs in graph order.
 */
export function findNodes(graph, classType, titlePart) {
  const found = []
  for (const [id, node] of Object.entries(graph ?? {})) {
    if (!node || node.class_type !== classType) continue
    if (titlePart !== undefined && titlePart !== null && !String(node._meta?.title ?? '').includes(titlePart)) continue
    found.push([id, node])
  }
  return found
}

/** The first node matching `classType` / `titlePart`, or an error naming both. */
export function findNode(graph, classType, titlePart) {
  const [hit] = findNodes(graph, classType, titlePart)
  if (!hit) throw new Error(`node not found: ${classType}${titlePart ? ` (${titlePart})` : ''}`)
  return hit
}

/** Parse `<lora:name:strength>` tags into `{name, strength}` in prompt order. */
export function parseLoraText(loraText) {
  const parsed = []
  for (const match of String(loraText ?? '').matchAll(/<lora:([^:>]+):([\d.]+)>/g)) {
    parsed.push({ name: match[1], strength: Number.parseFloat(match[2]) })
  }
  return parsed
}

/** Every distinct lora name mentioned in `loraText`, including malformed tags. */
export function loraNamesFromText(loraText) {
  const names = new Set()
  for (const match of String(loraText ?? '').matchAll(/<lora:([^:>]+)/g)) names.add(match[1])
  return [...names]
}

/** Tag every node so a history entry can be attributed to this plugin. */
export function stampSource(graph) {
  for (const node of Object.values(graph ?? {})) {
    if (!node || typeof node !== 'object') continue
    node._meta = { ...(node._meta ?? {}), [MCP_MARK]: true }
  }
  return graph
}

/** Whether a prompt graph carries this plugin's stamp. */
export function isStamped(graph) {
  return Object.values(graph ?? {}).some((node) => node?._meta?.[MCP_MARK] === true)
}

/**
 * Inject a standard LoraLoader chain (no rgthree dependency) between the model
 * loaders and the sampler/caption nodes. The first LoRA takes CLIPLoader output
 * 0; the rest chain from the previous LoraLoader's CLIP output 1. An empty
 * `loraText` leaves the graph untouched.
 */
export function injectLoraChain(graph, loraText) {
  const parsed = parseLoraText(loraText)
  if (parsed.length === 0) return graph
  const clipId = findNode(graph, 'CLIPLoader')[0]
  const samplers = findNodes(graph, 'KSampler').map(([, node]) => node)
  if (samplers.length === 0) throw new Error('pipeline has no KSampler node')
  let nextId = 1 + Object.keys(graph).filter((id) => /^\d+$/.test(id)).reduce((max, id) => Math.max(max, Number(id)), -1)
  let prevModel = findNodes(graph, 'UNETLoader')[0]?.[0] ?? '1'
  let prevClip = clipId
  for (const { name, strength } of parsed) {
    const id = String(nextId)
    nextId += 1
    graph[id] = {
      class_type: 'LoraLoader',
      inputs: {
        model: [prevModel, 0],
        clip: [prevClip, prevClip === clipId ? 0 : 1],
        lora_name: name,
        strength_model: strength,
        strength_clip: strength,
      },
    }
    prevModel = id
    prevClip = id
  }
  for (const sampler of samplers) sampler.inputs.model = [prevModel, 0]
  for (const node of Object.values(graph)) {
    if (node.class_type === 'CLIPTextEncode') node.inputs.clip = [prevClip, 1]
  }
  return graph
}

// ---------------------------------------------------------------- resources

function modelNameMatches(name, folder, names) {
  if (names.includes(name)) return true
  if (folder !== 'loras' || name.includes('.')) return false
  return names.some((listed) => listed.startsWith(`${name}.`))
}

function diskCandidates(folder, name) {
  const candidates = [name]
  if (folder === 'loras' && !name.includes('.')) candidates.push(`${name}.safetensors`, `${name}.sft`)
  return candidates
}

/**
 * Raise unless `name` exists in `models/<folder>`: the live `/models/<folder>`
 * listing first, the filesystem under `modelsDir()` as the fallback.
 */
export async function requireResource(folder, name, options = {}) {
  if (!name) return
  const candidates = diskCandidates(folder, name)
  let listed
  try {
    listed = await modelNames(folder, options)
  } catch {
    listed = undefined
  }
  if (listed && modelNameMatches(name, folder, listed)) return
  if (candidates.some((candidate) => existsSync(join(modelsDir(), folder, candidate)))) return
  const hint = listed?.length ? `（ComfyUI 现有: ${listed.slice(0, 10).join(', ')}）` : ''
  throw new Error(`resource not found: models/${folder}/${name}${hint}`)
}

/**
 * Validate a submission before it reaches ComfyUI: referenced model files exist
 * and 0 < width/height <= 4096.
 */
export async function validateResources({ unet, loras, width, height, signal } = {}) {
  await requireResource('diffusion_models', unet, { signal })
  for (const lora of loras ?? []) {
    const name = typeof lora === 'string' ? lora : lora?.name
    await requireResource('loras', name, { signal })
  }
  if (width !== undefined && width !== null && !(width > 0 && width <= 4096)) throw new Error(`invalid width: ${width}`)
  if (height !== undefined && height !== null && !(height > 0 && height <= 4096)) throw new Error(`invalid height: ${height}`)
}

// ---------------------------------------------------------------- submission

/** `<type>/<subfolder>/<filename>` with forward slashes (ComfyUI returns `\` on Windows). */
function imageRef(image) {
  return [image.type, image.subfolder ?? '', image.filename].filter(Boolean).join('/').replace(/\\/g, '/')
}

function outputRefs(outputs) {
  const refs = []
  for (const nodeOut of Object.values(outputs ?? {})) {
    for (const image of nodeOut?.images ?? []) refs.push(imageRef(image))
  }
  return refs
}

/** Upstream-style message for a history entry ComfyUI marked as failed. */
export function executionError(status) {
  for (const message of status?.messages ?? []) {
    const [type, payload] = Array.isArray(message) ? message : [message?.type, message?.message]
    if (type !== 'execution_error' || !payload || typeof payload !== 'object') continue
    return `ComfyUI execution error: ${payload.exception_message ?? JSON.stringify(payload)} (node=${payload.node_id ?? '?'}, type=${payload.exception_type ?? '?'})`
  }
  return `ComfyUI execution failed: ${JSON.stringify(status).slice(0, 500)}`
}

/**
 * Submit an API-format node graph, then poll `/history/{prompt_id}` every 2s
 * until ComfyUI reports success or failure. The graph is stamped first, so the
 * history entry is attributable to this plugin. Returns
 * `{prompt_id, status, outputs}` with each output as
 * `<type>/<subfolder>/<filename>`.
 */
export async function runGraph(graph, { timeoutMs = 600000, signal, clientId = CLIENT_ID } = {}) {
  stampSource(graph)
  let promptId
  try {
    const submitted = await postJson(COMFYUI_URL, '/prompt', { prompt: graph, client_id: clientId }, { signal, timeoutMs: REQUEST_TIMEOUT_MS })
    promptId = submitted.prompt_id
  } catch (error) {
    if (error instanceof HttpError) throw new Error(`ComfyUI submit failed (${error.status}): ${String(error.body ?? '').slice(0, 500)}`)
    throw error
  }
  const started = Date.now()
  for (;;) {
    if (Date.now() - started >= timeoutMs) {
      throw new ComfyTimeoutError(`generation timed out after ${Math.floor((Date.now() - started) / 1000)}s (prompt_id=${promptId})`)
    }
    try {
      await sleep(POLL_MS, signal)
    } catch {
      throw new Error(`cancelled while waiting for ${promptId}`)
    }
    let entry
    try {
      entry = await historyView({ promptId, signal })
    } catch {
      continue
    }
    if (!entry) continue
    const status = entry.status ?? {}
    if (status.completed || status.status_str === 'success') {
      return { prompt_id: promptId, status: 'completed', outputs: outputRefs(entry.outputs) }
    }
    if (status.status_str === 'error' || status.status_str === 'failed') throw new Error(executionError(status))
  }
}

/**
 * Run the Anima pipeline: inject the prompts, sampler settings and LoRA chain
 * into `pipeline.json`, submit, and wait. `timeoutMs` covers queue wait plus
 * generation; raise it when other jobs are ahead.
 */
export async function runPipeline({
  prompt,
  negativePrompt = '',
  seed,
  width,
  height,
  unetName,
  loraText = '',
  scheduler = 'simple',
  steps,
  cfg,
  samplerName,
  timeoutMs = 600000,
  signal,
} = {}) {
  const graph = loadPipeline()
  await validateResources({ unet: unetName, loras: loraNamesFromText(loraText), width, height, signal })
  findNode(graph, 'CLIPTextEncode', 'Positive')[1].inputs.text = prompt
  findNode(graph, 'CLIPTextEncode', 'Negative')[1].inputs.text = negativePrompt
  if (unetName) findNode(graph, 'UNETLoader')[1].inputs.unet_name = unetName
  const samplers = findNodes(graph, 'KSampler').map(([, node]) => node)
  if (samplers.length === 0) throw new Error('pipeline has no KSampler node')
  for (const sampler of samplers) sampler.inputs.scheduler = scheduler
  // only the main sampler gets the caller's seed; a hires-fix sampler keeps the
  // workflow-fixed one so its detail refinement stays reproducible
  const main = samplers[0]
  main.inputs.seed = seed ?? randomSeed()
  if (steps !== undefined && steps !== null) main.inputs.steps = steps
  if (cfg !== undefined && cfg !== null) main.inputs.cfg = cfg
  if (samplerName) main.inputs.sampler_name = samplerName
  const latent = findNodes(graph, 'EmptyLatentImage')[0]?.[1]
  if (latent) {
    if (width) latent.inputs.width = width
    if (height) latent.inputs.height = height
  }
  injectLoraChain(graph, loraText)
  return runGraph(graph, { timeoutMs, signal })
}

/**
 * Build a Krea2/Dasiwa text-to-image graph: CLIPLoader (qwen3vl, type krea2) ->
 * UNETLoader -> optional LoRA chain -> KSampler (8 steps, CFG 1, er_sde/simple)
 * -> optional RealESRGAN_x2plus 2x -> SaveImage under `Krea2/<date>/krea`.
 */
export function buildKrea2Workflow({
  prompt,
  negativePrompt = '',
  seed,
  width = 1024,
  height = 1536,
  unetName = KREA2_UNET,
  loraList,
  upscale = false,
} = {}) {
  const graph = {
    1: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen3vl_4b_fp8_scaled.safetensors', type: 'krea2' } },
    2: { class_type: 'UNETLoader', inputs: { unet_name: unetName, weight_dtype: 'default' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } },
    4: { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 0], text: prompt } },
    5: { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 0], text: negativePrompt } },
    6: { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    7: {
      class_type: 'KSampler',
      inputs: {
        seed,
        steps: 8,
        cfg: 1.0,
        sampler_name: 'er_sde',
        scheduler: 'simple',
        denoise: 1.0,
        model: ['2', 0],
        positive: ['4', 0],
        negative: ['5', 0],
        latent_image: ['6', 0],
      },
    },
    8: { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
  }
  let prev = '2'
  for (const [index, lora] of (loraList ?? []).entries()) {
    const id = String(20 + index)
    const strength = lora.strength ?? 1.0
    graph[id] = {
      class_type: 'LoraLoader',
      inputs: { model: [prev, 0], clip: ['1', 0], lora_name: lora.name, strength_model: strength, strength_clip: strength },
    }
    prev = id
  }
  graph['7'].inputs.model = [prev, 0]
  let imageSource = '8'
  if (upscale) {
    graph['48'] = { class_type: 'UpscaleModelLoader', inputs: { model_name: 'RealESRGAN_x2plus.pth' } }
    graph['50'] = { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['48', 0], image: ['8', 0] } }
    imageSource = '50'
  }
  graph['9'] = { class_type: 'SaveImage', inputs: { images: [imageSource, 0], filename_prefix: 'Krea2/%year%-%month%-%day%/krea' } }
  return graph
}

/** Run a Krea2/Dasiwa job. `loraList` entries are `{name, strength}` applied in order. */
export async function runKrea2({
  prompt,
  negativePrompt = '',
  seed,
  width = 1024,
  height = 1536,
  unetName = KREA2_UNET,
  loraList,
  upscale = false,
  timeoutMs = 900000,
  signal,
} = {}) {
  await validateResources({ unet: unetName, loras: (loraList ?? []).map((lora) => lora.name), signal })
  const graph = buildKrea2Workflow({ prompt, negativePrompt, seed: seed ?? randomSeed(), width, height, unetName, loraList, upscale })
  return runGraph(graph, { timeoutMs, signal, clientId: `${CLIENT_ID}-krea2` })
}

// ---------------------------------------------------------------- web API

/** `/system_stats`: ComfyUI version, OS and devices. */
export function systemStats(options = {}) {
  return getJson(COMFYUI_URL, '/system_stats', { timeoutMs: 10000, ...options })
}

function queueEntryId(entry) {
  if (Array.isArray(entry)) return entry[1]
  if (entry && typeof entry === 'object') return entry.prompt_id
  return undefined
}

/** Running/pending counts and prompt ids from `/queue`. */
export async function queueView(options = {}) {
  const data = await getJson(COMFYUI_URL, '/queue', { timeoutMs: REQUEST_TIMEOUT_MS, ...options })
  const keep = (entry) => typeof entry === 'string'
  const running = (data?.queue_running ?? []).map(queueEntryId).filter(keep)
  const pending = (data?.queue_pending ?? []).map(queueEntryId).filter(keep)
  return { running_count: running.length, pending_count: pending.length, running, pending }
}

/**
 * `/history/{prompt_id}` for one entry, or the most recent `limit` entries as a
 * `{prompt_id: entry}` map.
 */
export function historyView({ promptId, limit, signal, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  if (promptId !== undefined && promptId !== null && promptId !== '') {
    return getJson(COMFYUI_URL, `/history/${encodeURIComponent(promptId)}`, { signal, timeoutMs }).then((history) => history?.[promptId])
  }
  return getJson(COMFYUI_URL, '/history', { query: { max_items: limit }, signal, timeoutMs })
}

/** History entries carry the prompt graph in list form (`[num, id, graph, ...]`). */
function unwrapPrompt(prompt) {
  if (Array.isArray(prompt) && prompt.length > 2) return prompt[2]
  return prompt
}

function historyTiming(entry) {
  const timing = {}
  for (const message of entry?.status?.messages ?? []) {
    const [type, payload] = Array.isArray(message) ? message : [message?.type, message?.message]
    if (payload && typeof payload.timestamp === 'number' && (type === 'execution_start' || type === 'execution_success')) {
      timing[type === 'execution_start' ? 'started_at' : 'finished_at'] = payload.timestamp
    }
  }
  if (timing.started_at !== undefined && timing.finished_at !== undefined) {
    timing.elapsed_s = Math.round((timing.finished_at - timing.started_at) / 1000)
  }
  return timing
}

/**
 * Classify history entries into runs: `source` is `mcp` when the graph carries
 * this plugin's stamp and `manual` otherwise, and every output records the node
 * that produced it.
 */
export function historyToRuns(history) {
  const runs = []
  for (const [promptId, entry] of Object.entries(history ?? {})) {
    if (!entry || typeof entry !== 'object') continue
    const graph = unwrapPrompt(entry.prompt)
    const outputs = []
    for (const [node, nodeOut] of Object.entries(entry.outputs ?? {})) {
      for (const image of nodeOut?.images ?? []) {
        const ref = imageRef(image)
        outputs.push({ node, filename: image.filename, subfolder: (image.subfolder ?? '').replace(/\\/g, '/'), type: image.type ?? 'output', ref, view_url: viewUrl(ref) })
      }
    }
    runs.push({
      prompt_id: promptId,
      source: isStamped(graph) ? 'mcp' : 'manual',
      status: entry.status?.status_str ?? (entry.status?.completed ? 'success' : 'unknown'),
      completed: !!entry.status?.completed,
      timing: historyTiming(entry),
      outputs,
    })
  }
  return runs
}

/** The compact `recent_runs` view of server_info: source, first two files, short id. */
export function recentRunSources(history, limit = 5) {
  return historyToRuns(history)
    .slice(0, limit)
    .map((run) => ({ source: run.source, outputs: run.outputs.slice(0, 2).map((output) => output.filename), prompt_id: run.prompt_id.slice(0, 12) }))
}

/** File names in `models/<folder>`, via `/models/<folder>` with an object_info fallback. */
export async function modelNames(folder, { signal, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const routes = [async () => extractModelNames(await getJson(COMFYUI_URL, `/models/${encodeURIComponent(folder)}`, { signal, timeoutMs }))]
  const loader = FOLDER_LOADERS[folder]
  if (loader) {
    routes.push(async () => loaderModelNames((await getJson(COMFYUI_URL, `/object_info/${encodeURIComponent(loader)}`, { signal, timeoutMs }))?.[loader]))
  }
  let detail = 'no route'
  for (const route of routes) {
    try {
      const names = await route()
      if (names.length > 0) return names
      detail = 'empty listing'
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error)
    }
  }
  throw new Error(`cannot list models/${folder} (${detail})`)
}

function extractModelNames(json) {
  if (Array.isArray(json)) {
    return json.map((entry) => (entry && typeof entry === 'object' ? entry.name ?? entry.filename : entry)).filter((name) => typeof name === 'string')
  }
  if (json && typeof json === 'object') {
    if (Array.isArray(json.models)) return extractModelNames(json.models)
    const [first] = Object.values(json)
    if (first && typeof first === 'object' && Array.isArray(first.models)) return extractModelNames(first.models)
  }
  return []
}

function loaderModelNames(node) {
  for (const spec of Object.values(node?.input?.required ?? {})) {
    if (Array.isArray(spec) && Array.isArray(spec[0])) {
      const names = spec[0].filter((entry) => typeof entry === 'string')
      if (names.length > 0) return names
    }
  }
  return []
}

/** Raw `/object_info/{class_type}` map. */
export function objectInfo(classType, options = {}) {
  return getJson(COMFYUI_URL, `/object_info/${encodeURIComponent(classType)}`, { timeoutMs: REQUEST_TIMEOUT_MS, ...options })
}

function summarizeInput(spec) {
  const declared = Array.isArray(spec) ? spec[0] : spec && typeof spec === 'object' ? spec.type : spec
  const extra = (Array.isArray(spec) ? spec[1] : spec && typeof spec === 'object' ? spec : null) ?? {}
  const summary = { type: Array.isArray(declared) ? 'combo' : String(declared) }
  const choices = Array.isArray(declared) ? declared.filter((entry) => typeof entry === 'string') : Array.isArray(extra.options) ? extra.options.filter((entry) => typeof entry === 'string') : null
  if (choices) {
    summary.options = choices.length > 40 ? choices.slice(0, 40) : choices
    summary.options_count = choices.length
  }
  if (extra.default !== undefined) summary.default = cap(extra.default, 300)
  for (const key of ['min', 'max', 'step']) {
    if (typeof extra[key] === 'number') summary[key] = extra[key]
  }
  if (extra.multiline) summary.multiline = true
  if (typeof extra.tooltip === 'string' && extra.tooltip) summary.tooltip = cap(extra.tooltip, 300)
  return summary
}

function summarizeInputs(inputs) {
  const out = {}
  for (const [name, spec] of Object.entries(inputs ?? {})) out[name] = summarizeInput(spec)
  return out
}

/**
 * One node's `/object_info` entry, trimmed: input combos are capped, long
 * descriptions shortened, so a query cannot flood the model's context.
 */
export async function nodeInfo(classType, options = {}) {
  const node = (await objectInfo(classType, options))?.[classType]
  if (!node) return undefined
  return {
    class_type: classType,
    display_name: node.display_name,
    description: cap(node.description, 600),
    category: node.category,
    output_node: !!node.output_node,
    input: { required: summarizeInputs(node.input?.required), optional: summarizeInputs(node.input?.optional) },
    output: node.output ?? [],
    output_name: node.output_name ?? [],
    output_is_list: node.output_is_list ?? [],
  }
}

/**
 * Interrupt the running prompt (optionally only `promptId`). `/interrupt`
 * answers with an empty 200, so the response is read as text.
 */
export function interrupt({ promptId, signal } = {}) {
  return postJson(COMFYUI_URL, '/interrupt', promptId ? { prompt_id: promptId } : {}, { signal, timeoutMs: REQUEST_TIMEOUT_MS, text: true })
}

/** Drop one pending prompt from the queue. `POST /queue` also answers with an empty 200. */
export function cancelQueued(promptId, options = {}) {
  return postJson(COMFYUI_URL, '/queue', { delete: [promptId] }, { timeoutMs: REQUEST_TIMEOUT_MS, text: true, ...options })
}

/** Drop every pending prompt from the queue. */
export function clearQueue(options = {}) {
  return postJson(COMFYUI_URL, '/queue', { clear: true }, { timeoutMs: REQUEST_TIMEOUT_MS, text: true, ...options })
}

// ---------------------------------------------------------------- viewer

/** Split `<type>/<subfolder>/<filename>` (or a ComfyUI image object) apart. */
function imageParts(imageRef) {
  if (imageRef && typeof imageRef === 'object') {
    return { type: imageRef.type ?? 'output', subfolder: imageRef.subfolder ?? '', filename: imageRef.filename ?? '' }
  }
  const parts = String(imageRef ?? '').replace(/\\/g, '/').split('/').filter(Boolean)
  const filename = parts.pop() ?? ''
  return { type: parts.shift() ?? 'output', subfolder: parts.join('/'), filename }
}

/** A ComfyUI `/view` URL for an output image. */
export function viewUrl(imageRef) {
  const image = imageParts(imageRef)
  return `${COMFYUI_URL}/view?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(image.subfolder)}&type=${encodeURIComponent(image.type)}`
}

/** Local path an output ref points at (`output/x.png` -> `<output dir>/x.png`). */
function localOutputPath(ref) {
  const normalized = String(ref).replace(/\\/g, '/')
  const relative = normalized.startsWith('output/') ? normalized.slice('output/'.length) : normalized
  return join(outputDir(), relative)
}

const COMPARE_STYLE = 'body{margin:0;background:#1a1a2e;color:#eee;font-family:sans-serif;padding:15px}'
  + 'h1{text-align:center;font-size:18px}'
  + '.container{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}'
  + '.card{text-align:center}.card h2{font-size:14px}'
  + '.card img{height:80vh;max-width:46vw;object-fit:contain;border:2px solid #444;border-radius:8px;background:#222}'

function compareHtml(referenceName, generatedName) {
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>对比</title>'
    + `<style>${COMPARE_STYLE}</style></head><body>`
    + `<h1>原图 vs 复刻</h1><div class="container">`
    + `<div class="card"><h2>\u{1F5BC} 原图</h2><img src="${referenceName}"></div>`
    + `<div class="card"><h2>\u{1F3A8} 生成</h2><img src="${generatedName}"></div>`
    + '</div></body></html>'
}

/**
 * Copy the first output into the compare directory and attach a `view_url`
 * served by VIEW_BASE; with a reference image a side-by-side page is written
 * instead of a bare image link. Never throws — viewing is a convenience.
 */
export function makeView(result, referenceImage) {
  try {
    const [first] = result?.outputs ?? []
    if (!first) return result
    const source = localOutputPath(first)
    if (!existsSync(source)) return result
    ensureDir(COMPARE_DIR)
    const stem = basename(source).replace(/\.[^.]+$/, '').replace(/[^\w-]/g, '_').slice(0, 40)
    const generated = join(COMPARE_DIR, `${stem}.png`)
    copyFileSync(source, generated)
    if (referenceImage && existsSync(referenceImage)) {
      const reference = join(COMPARE_DIR, `${stem}_ref.png`)
      copyFileSync(referenceImage, reference)
      const page = join(COMPARE_DIR, `${stem}.html`)
      writeFileSync(page, compareHtml(basename(reference), basename(generated)), 'utf8')
      result.view_url = `${VIEW_BASE}/${basename(page)}`
    } else {
      result.view_url = `${VIEW_BASE}/${basename(generated)}`
    }
  } catch {
    // a failed copy must never fail a successful generation
  }
  return result
}
