/**
 * The ComfyUI control tools: server status, model listing, Anima/Krea2
 * generation, arbitrary workflows, history, queue control, node schemas and
 * image metadata extraction.
 *
 * Behaviour mirrors good-comfyui-mcp's generate / server_info /
 * extract_image_info and the comfyui-lewd preset's control surface.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { defineTool } from '../tool.js'
import { CACHE_DIR, CAMOFOX_URL, CIVITAI_SEARCH_KEY, CIVITAI_TOKEN, COMFYUI_URL, DEFAULT_PIPELINE, OLLAMA_URL, listFiles, outputDir, readJsonFile, resolveUserPath } from '../env.js'
import { HttpError, getJson, tryJson } from '../http.js'
import {
  KREA2_UNET,
  clearQueue,
  executionError,
  findNodes,
  historyToRuns,
  historyView,
  interrupt,
  loadPipeline,
  makeView,
  modelNames,
  nodeInfo,
  queueView,
  recentRunSources,
  requireResource,
  runGraph,
  runKrea2,
  runPipeline,
  systemStats,
  viewUrl,
} from '../comfyui.js'

const DEFAULT_UNET = 'anima-base-v1.0.safetensors'
const DEFAULT_NEGATIVE = '(score_4, score_5, score_6:1.2), worst quality, low quality, normal quality, bad hands, bad feet, bad anatomy, '
  + 'bad proportions, cropped, missing fingers, jpeg artifacts, signature, watermark, username, artist name, extra digit, fewer digits, artistic error'

/** The default 5-LoRA set attached when `lora_text` is omitted. */
const DEFAULT_LORAS = [
  { name: 'ushikani_kassen_lora-000013.safetensors', strength: 0.3 },
  { name: 'anima-darklight-style-v1-000194.safetensors', strength: 0.3 },
  { name: 'anima-base-1-photo-background-v4.safetensors', strength: 0.6 },
  { name: 'RealSkin SliderV2.safetensors', strength: 0.8 },
  { name: 'surtr945_v1.safetensors', strength: 0.8 },
]
const DEFAULT_LORA_TEXT = DEFAULT_LORAS
  .map((lora) => `<lora:${lora.name}:${lora.strength}>`)
  .join(', ')

const MODEL_FOLDERS = [
  'checkpoints', 'diffusion_models', 'loras', 'vae', 'text_encoders', 'clip', 'upscale_models', 'controlnet',
  'clip_vision', 'style_models', 'photomaker', 'gligen', 'hypernetworks', 'unet', 'embeddings', 'models',
]

const MAX_FILE_BYTES = 64 * 1024 * 1024

/** Official Anima model usage guide, verbatim from the circlestone-labs/Anima README. */
export const ANIMA_GUIDE = {
  models: [
    {
      name: 'anima-base-v1.0',
      desc: '预训练基础版：风格最中性、多样性最高。角色 LoRA 的训练和使用推荐底模。',
      prompt: '默认风格朴素，必须用 quality tags 和 artist tags 才有表现',
    },
    {
      name: 'anima-aesthetic-v1.1',
      desc: '美学微调版（base + 美学数据微调 + 内置风格/稳定化调整）：默认画风更精致。',
      prompt: '提示词不需要 quality tags（可留 masterpiece, best quality）；不要用 score_* tags（会把画面推过头）；适合无 LoRA 直出',
    },
    {
      name: 'anima-turbo-v1.0',
      desc: '蒸馏加速版：CFG 1、8-12 步出图，快且稳定，多样性略低',
      prompt: '强默认风格，适合快速迭代',
    },
  ],
  generation_settings: {
    resolution: '512^2 ~ 1536^2 像素（工作流默认 1024x1536）',
    steps_cfg: '30-50 步 / CFG 4-5（Turbo 版：CFG 1、8-12 步）',
    samplers: [
      'er_sde（中性风格/平涂/锐线，官方默认）',
      'euler_a（更软更细的线）',
      'dpmpp_2m_sde_gpu（更有创意但可能太野）',
      'euler（基本采样器，配 Turbo/Aesthetic 更稳）',
    ],
    scheduler_note: '官方未限定 scheduler；本环境实测 simple 调度器效果更好',
  },
  prompting: {
    style: 'Danbooru 风格 tag + 自然语言可混用；tag 用英文小写、空格代替下划线（score_* 除外）；Gelbooru 版优先',
    positive_prefix: 'masterpiece, best quality, score_7, safe, ',
    recommended_negative: 'worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, chromatic aberration',
    tag_order: '[quality/meta/year/safety] [1girl/1boy] [角色] [系列] [@画师] [通用 tags]',
    artist_tag: '画师标签必须加 @ 前缀（如 @big chungus），否则几乎无效',
    weighting: '权重语法可用但要比 SDXL 更高，如 (chibi:2)',
    quality_tags: ['人类评分：masterpiece/best quality/good/normal/low/worst', 'PonyV7 审美模型：score_9..score_1（可混用也可都不用）'],
    safety_tags: ['safe', 'sensitive', 'nsfw', 'explicit'],
    time_tags: ['year 2025 / newest / recent / mid / early / old'],
    natural_language: '角色名+系列名用标准英文大小写；纯自然语言至少 2 句；多角色时逐个描述外貌',
  },
  lora_tips: {
    train_base: 'LoRA 用 base 版训练（官方原话）；aesthetic 版内置风格调整会干扰 LoRA',
    use: '角色 LoRA 搭配 base 使用效果最干净；搭配 aesthetic 会串味',
    hyperparams: 'rank 32 起步 lr 2e-5；不要训练 LLM adapter（llm_adapter_lr=0）',
  },
  limitations: ['不适合写实（动漫/插画特化）', '长文字渲染弱（单词可以，长句不行）', 'base 版默认风格很朴素，需要 quality/artist tags'],
  license: '非商用许可（模型权重不能商用，生成的图片可商用）；基于 NVIDIA Cosmos-Predict2 的衍生模型',
}

function textBlock(text) {
  return [{ type: 'text', text }]
}

function timeoutMs(seconds, fallbackSeconds) {
  return Math.min(Math.max(seconds ?? fallbackSeconds, 30), 3600) * 1000
}

/** Split `<type>/<subfolder>/<filename>` (or a bare name) for local path lookup. */
function splitRef(ref) {
  const parts = String(ref).replace(/\\/g, '/').split('/').filter(Boolean)
  const filename = parts.pop() ?? ''
  return { type: parts.shift() ?? 'output', subfolder: parts.join('/'), filename }
}

/** Output images as `{filename, subfolder, type, path?, view_url}` for the caller. */
function imageItems(outputs) {
  return (outputs ?? []).map((ref) => {
    const image = splitRef(ref)
    const item = { ...image, view_url: viewUrl(image) }
    if (image.type === 'output') {
      const path = join(outputDir(), image.subfolder, image.filename)
      if (existsSync(path)) item.path = path
    }
    return item
  })
}

/** Anima / Krea2 / whatever the file name suggests — for LoRA metadata searches. */
function deriveBaseModel(unetName) {
  const name = String(unetName ?? '')
  if (/anima/i.test(name)) return 'Anima'
  if (/krea/i.test(name)) return 'Krea2'
  return name || undefined
}

/** The unet the pipeline actually loads, so `base_model` reflects the workflow. */
function pipelineUnet(fallbackName) {
  try {
    return findNodes(loadPipeline(), 'UNETLoader')[0]?.[1]?.inputs?.unet_name || fallbackName
  } catch {
    return fallbackName
  }
}

/** The danbooru-style character tag (e.g. `varesa_(genshin_impact)`) in a prompt. */
function characterFromPrompt(prompt) {
  const match = /\b([a-z0-9_]+)\(([a-z0-9_ ]+)\)/.exec(String(prompt ?? ''))
  return match ? match[0].trim() : undefined
}

/** A cached Danbooru lookup matching by canonical tag or by the original query. */
function findCachedCharacter(name) {
  const query = String(name).toLowerCase()
  for (const file of listFiles(CACHE_DIR)) {
    if (!file.endsWith('.json') || file.endsWith('.appearance.json') || file.startsWith('.')) continue
    const cached = readJsonFile(join(CACHE_DIR, file))
    if (!cached || typeof cached !== 'object') continue
    if (String(cached.canonical_tag ?? '').toLowerCase() === query || String(cached.query ?? '').toLowerCase() === query) return cached
  }
  return undefined
}

/** Attach `character_info` exactly like upstream: cached, freshly looked up, or a warning. */
async function lookupCharacterInfo(character) {
  if (findCachedCharacter(character)) return { character, looked_up: false }
  try {
    const { lookupCharacter } = await import('../danbooru.js')
    return { ...(await lookupCharacter(character)), looked_up: true }
  } catch (error) {
    return { character, looked_up: false, warning: `auto lookup failed: ${error?.message ?? error}` }
  }
}

// ---------------------------------------------------------------- image metadata

function readU32BE(bytes, pos) {
  return ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0
}

function utf8(bytes) {
  return bytes ? new TextDecoder('utf-8', { fatal: false }).decode(bytes) : ''
}

function latin1(bytes) {
  return new TextDecoder('latin1').decode(bytes)
}

function inflate(bytes) {
  try {
    return inflateSync(bytes)
  } catch {
    return undefined
  }
}

/** `[width, height]` from the IHDR chunk. */
export function pngDimensions(bytes) {
  if (bytes.length < 24) return undefined
  return [readU32BE(bytes, 16), readU32BE(bytes, 20)]
}

function decodePngText(type, data) {
  const split = data.indexOf(0)
  if (split <= 0) return undefined
  if (type === 'tEXt') return { key: latin1(data.subarray(0, split)), value: utf8(data.subarray(split + 1)) }
  if (type === 'zTXt') return split + 2 > data.length ? undefined : { key: latin1(data.subarray(0, split)), value: utf8(inflate(data.subarray(split + 2))) }
  if (type !== 'iTXt' || split + 3 > data.length) return undefined
  const language = data.indexOf(0, split + 3)
  const translated = language < 0 ? -1 : data.indexOf(0, language + 1)
  if (translated < 0) return undefined
  const body = data.subarray(translated + 1)
  return { key: latin1(data.subarray(0, split)), value: utf8(data[split + 1] === 1 ? inflate(body) : body) }
}

/** Every text chunk (tEXt / iTXt / zTXt) of a PNG, keyed by keyword. */
export function parsePngText(bytes) {
  const text = {}
  let pos = 8
  while (pos + 8 <= bytes.length) {
    const length = readU32BE(bytes, pos)
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7])
    const start = pos + 8
    if (length > 1 << 24 || start + length > bytes.length) break
    const entry = decodePngText(type, bytes.subarray(start, start + length))
    if (entry) text[entry.key] = entry.value
    pos = start + length + 4
  }
  return text
}

/** `{size, comment}` of a JPEG: dimensions from the SOF marker, text from COM. */
export function parseJpegInfo(bytes) {
  const info = {}
  let pos = 2
  while (pos + 4 <= bytes.length) {
    if (bytes[pos] !== 0xff) {
      pos += 1
      continue
    }
    const marker = bytes[pos + 1]
    if (marker === 0xff) {
      pos += 1
      continue
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2
      continue
    }
    const length = (bytes[pos + 2] << 8) | bytes[pos + 3]
    if (length < 2 || pos + 2 + length > bytes.length) break
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc && length >= 7) {
      info.size ??= [((bytes[pos + 7] << 8) | bytes[pos + 8]), ((bytes[pos + 5] << 8) | bytes[pos + 6])]
    }
    if (marker === 0xfe && info.comment === undefined) info.comment = utf8(bytes.subarray(pos + 4, pos + 2 + length))
    if (marker === 0xda) break
    pos += 2 + length
  }
  return info
}

/** Container family from the file magic. */
export function detectImageFormat(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (bytes.length >= 3 && String.fromCharCode(bytes[0], bytes[1], bytes[2]) === 'GIF') return 'gif'
  if (bytes.length >= 12 && String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === 'RIFF' && String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) === 'WEBP') return 'webp'
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'bmp'
  return 'unknown'
}

function appendLora(generation, entry) {
  if (!generation.loras) generation.loras = []
  generation.loras.push(entry)
}

/**
 * Generation settings from a ComfyUI `prompt` graph: sampler/widgets, model,
 * size, the longest caption text and every LoRA flavour (standard LoraLoader,
 * rgthree `loras.__value__`, legacy `lora_N` slots, ZML `lora_loader_data`).
 */
export function parseComfyPrompt(promptGraph) {
  const generation = {}
  for (const node of Object.values(promptGraph ?? {})) {
    if (!node || typeof node !== 'object') continue
    const type = node.class_type ?? ''
    const inputs = node.inputs ?? {}
    if (type === 'KSampler') {
      generation.sampler = { seed: inputs.seed, steps: inputs.steps, cfg: inputs.cfg, sampler_name: inputs.sampler_name, scheduler: inputs.scheduler, denoise: inputs.denoise }
    } else if (type === 'UNETLoader') {
      generation.model = inputs.unet_name
    } else if (type === 'EmptyLatentImage') {
      generation.size = [inputs.width, inputs.height]
    } else if (type === 'CLIPTextEncode') {
      const text = typeof inputs.text === 'string' ? inputs.text : ''
      if (text.length > 80 && generation.prompt_text === undefined) generation.prompt_text = text
    } else if (/lora/i.test(type)) {
      if (inputs.lora_name) appendLora(generation, { node: type, lora: inputs.lora_name, strength: inputs.strength_model || inputs.strength })
      if (Array.isArray(inputs.loras?.__value__)) {
        for (const entry of inputs.loras.__value__) {
          if (entry?.lora) appendLora(generation, { node: type, lora: entry.lora, strength: entry.strength, enabled: !!entry.on })
        }
      }
      for (const [key, entry] of Object.entries(inputs)) {
        if (key.startsWith('lora_') && entry && typeof entry === 'object' && entry.lora) appendLora(generation, { node: type, lora: entry.lora, strength: entry.strength, enabled: !!entry.on })
      }
      if (typeof inputs.lora_loader_data === 'string' && inputs.lora_loader_data.trimStart().startsWith('{')) {
        try {
          for (const entry of JSON.parse(inputs.lora_loader_data).entries ?? []) {
            if (entry.item_type === 'lora' && entry.lora_name) appendLora(generation, { node: type, lora: entry.lora_name, strength: entry.weight, enabled: !!entry.enabled })
          }
        } catch {
          // a malformed widget value is not worth failing the whole extraction
        }
      }
    }
  }
  return Object.keys(generation).length > 0 ? generation : undefined
}

function sameLora(left, right) {
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (left[key] !== right[key]) return false
  }
  return true
}

/**
 * Fill settings a `workflow` JSON has but the `prompt` graph lacks: LoRA widgets
 * (ZML JSON / rgthree `__value__`), the UNETLoader model and KSampler widgets.
 */
export function applyWorkflowWidgets(workflow, generation = {}) {
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : []
  const loras = []
  for (const node of nodes) {
    const type = String(node?.type ?? '')
    const widgets = node?.widgets_values
    if (!/lora/i.test(type) || !Array.isArray(widgets) || widgets.length === 0) continue
    if (typeof widgets[0] === 'string' && widgets[0].trimStart().startsWith('{')) {
      try {
        for (const entry of JSON.parse(widgets[0]).entries ?? []) {
          if (entry.item_type === 'lora' && entry.lora_name) loras.push({ node: type, lora: entry.lora_name, strength: entry.weight, enabled: !!entry.enabled })
        }
      } catch {
        // keep the other nodes parseable
      }
    } else if (widgets[0] && typeof widgets[0] === 'object') {
      for (const entry of widgets[0].__value__ ?? []) {
        if (entry && typeof entry === 'object' && entry.lora) loras.push({ node: type, lora: entry.lora, strength: entry.strength, enabled: !!entry.on })
      }
    }
  }
  if (loras.length > 0) {
    const known = generation.loras ?? []
    generation.loras = [...known, ...loras.filter((entry) => !known.some((other) => sameLora(entry, other)))]
  }
  if (generation.model === undefined) {
    const loader = nodes.find((node) => node?.type === 'UNETLoader' && Array.isArray(node.widgets_values))
    if (loader) generation.model = loader.widgets_values[0]
  }
  if (generation.sampler === undefined) {
    for (const node of nodes) {
      const widgets = node?.widgets_values
      if (!Array.isArray(widgets)) continue
      if (node.type === 'KSampler') {
        generation.sampler = { seed: widgets[0], steps: widgets[2], cfg: widgets[3], sampler_name: widgets[4], scheduler: widgets[5], denoise: widgets[6] }
        break
      }
      if (node.type === 'KSamplerAdvanced') {
        generation.sampler = { seed: widgets[1], steps: widgets[3], cfg: widgets[4], sampler_name: widgets[5], scheduler: widgets[6] }
        break
      }
    }
  }
  return generation
}

/**
 * Parse one image's bytes for embedded generation metadata: ComfyUI
 * prompt/workflow JSON, WebUI `parameters`. PNG text chunks only; other
 * containers report their format and any text they do carry.
 */
export function extractImageInfo(bytes, file) {
  const result = { file, size_bytes: bytes.length, metadata: {} }
  const format = detectImageFormat(bytes)
  result.format = format
  if (format === 'png') {
    const size = pngDimensions(bytes)
    if (size) result.size = size
    for (const [key, value] of Object.entries(parsePngText(bytes))) {
      result.metadata[key] = key === 'prompt' || key === 'workflow' ? value : value.slice(0, 2000)
    }
  } else if (format === 'jpeg') {
    const info = parseJpegInfo(bytes)
    if (info.size) result.size = info.size
    if (info.comment) result.metadata.Comment = info.comment.slice(0, 2000)
    result.note = 'JPEG 的 EXIF/WebUI 元数据未解析（本工具只解析 PNG 文本块）'
  } else {
    result.note = `无法解析 ${format} 容器的文本元数据（本工具只解析 PNG 文本块）`
  }
  const metadata = result.metadata
  const generation = {}
  if (typeof metadata.prompt === 'string' && metadata.prompt.trimStart().startsWith('{')) {
    try {
      Object.assign(generation, parseComfyPrompt(JSON.parse(metadata.prompt)) ?? {})
    } catch {
      // an unparseable prompt chunk still leaves the raw metadata available
    }
  }
  if (typeof metadata.workflow === 'string' && metadata.workflow.trimStart().startsWith('{')) {
    try {
      applyWorkflowWidgets(JSON.parse(metadata.workflow), generation)
    } catch {
      // same for the workflow chunk
    }
  }
  if (typeof metadata.parameters === 'string') generation.parameters_head = metadata.parameters.slice(0, 600)
  if (Object.keys(generation).length > 0) result.generation = generation
  return result
}

/** Read one image file and parse its metadata. */
export function readImageInfo(imagePath) {
  const path = resolveUserPath(imagePath)
  let stats
  try {
    stats = statSync(path)
  } catch {
    return { file: path, metadata: {}, error: `cannot open image: ${path}` }
  }
  if (!stats.isFile()) return { file: path, metadata: {}, error: `not a file: ${path}` }
  if (stats.size > MAX_FILE_BYTES) return { file: path, metadata: {}, error: `file too large: ${stats.size} bytes (max ${MAX_FILE_BYTES})` }
  return extractImageInfo(readFileSync(path), path)
}

// ---------------------------------------------------------------- rendering

function renderStatus(value) {
  const lines = [`ComfyUI ${value.comfyui} — ${value.url}`]
  if (value.comfyui_version) lines.push(`版本: ${value.comfyui_version}${value.python_version ? ` / python ${value.python_version}` : ''}${value.os ? ` / ${value.os}` : ''}`)
  lines.push(`pipeline: ${value.pipeline}${value.pipeline_exists ? '' : '（缺失）'}`)
  lines.push(`models_ok: ${value.models_ok}${value.models_ok ? '' : '（见下方缺失项）'}`)
  for (const device of value.devices ?? []) {
    lines.push(`设备: ${device.name} (${device.type}) VRAM ${device.vram_free_gb}GB / ${device.vram_total_gb}GB`)
  }
  if (value.queue) lines.push(`队列: 运行中 ${value.queue.running_count} / 排队 ${value.queue.pending_count}`)
  lines.push(`ollama: ${typeof value.ollama === 'string' ? value.ollama : JSON.stringify(value.ollama)}`)
  lines.push(`camofox: ${value.camofox}`)
  lines.push(`civitai: token=${value.civitai?.token} search_key=${value.civitai?.search_key}`)
  for (const item of value.missing ?? []) lines.push(`[缺] ${item}`)
  for (const item of value.on_demand ?? []) lines.push(`[按需] ${item}`)
  for (const check of value.checks ?? []) lines.push(`${check.found ? '[有]' : '[缺]'} ${check.resource}${check.error ? ` — ${check.error}` : ''}`)
  lines.push(`ready: ${value.ready}`)
  if (value.recent_runs?.length) lines.push(`最近任务: ${value.recent_runs.map((run) => `${run.source}:${run.prompt_id}`).join(', ')}`)
  return lines.join('\n')
}

function renderGenerate(value) {
  const lines = [`已生成（engine=${value.engine}, prompt_id=${value.prompt_id}, seed=${value.seed}, 用时 ${value.elapsed_s}s）`]
  for (const image of value.images ?? []) lines.push(`- ${image.path ?? image.view_url}`)
  if (value.view_url) lines.push(`查看: ${value.view_url}`)
  if (value.character_info) lines.push(`角色: ${JSON.stringify(value.character_info).slice(0, 400)}`)
  return lines.join('\n')
}

function renderHistory(value) {
  if (value.runs) {
    const lines = value.runs.map((run) => {
      const outputs = run.outputs.map((output) => output.ref).join(', ')
      return `- ${run.prompt_id.slice(0, 12)} [${run.source}] ${run.status}${outputs ? ` → ${outputs}` : ''}`
    })
    return `${value.count} 条历史记录\n${lines.join('\n')}`
  }
  const lines = [`prompt ${value.prompt_id}: ${value.found ? `${value.status} [${value.source}]` : '未找到'}`]
  if (value.error) lines.push(`错误: ${value.error}`)
  if (value.timing?.elapsed_s !== undefined) lines.push(`用时: ${value.timing.elapsed_s}s`)
  for (const output of value.outputs ?? []) lines.push(`- 节点 ${output.node}: ${output.ref}`)
  if (value.generation) lines.push(`参数: ${JSON.stringify(value.generation).slice(0, 800)}`)
  return lines.join('\n')
}

function renderImageInfo(value) {
  const lines = [value.file]
  if (value.error) lines.push(`错误: ${value.error}`)
  if (value.format) lines.push(`格式: ${value.format}${value.size ? ` ${value.size[0]}x${value.size[1]}` : ''}${value.size_bytes ? `（${value.size_bytes} bytes）` : ''}`)
  if (value.note) lines.push(value.note)
  const keys = Object.keys(value.metadata ?? {})
  if (keys.length) lines.push(`元数据键: ${keys.join(', ')}`)
  if (value.generation) lines.push(`生成参数: ${JSON.stringify(value.generation).slice(0, 1200)}`)
  return lines.join('\n')
}

/** Pipeline model references checked by comfyui_status. */
const PIPELINE_RESOURCES = [
  ['UNETLoader', 'unet_name', 'diffusion_models', '模型'],
  ['CLIPLoader', 'clip_name', 'text_encoders', 'CLIP'],
  ['VAELoader', 'vae_name', 'vae', 'VAE'],
  ['UpscaleModelLoader', 'model_name', 'upscale_models', '放大模型'],
]

export const tools = [
  defineTool({
    name: 'comfyui_status',
    description: '依赖自检：ComfyUI 是否在线（/system_stats）、pipeline.json 是否存在及其引用的模型（UNET/CLIP/VAE/放大模型）是否齐全、'
      + 'Ollama 识图模型是否已装、camofox-browser 是否健康、Civitai 凭据是否配置、最近几次运行是 agent'
      + '（comfyui_generate / comfyui_run_workflow）还是手动提交。每次会话开始先调用一次，按 missing[] 逐项补齐依赖；'
      + '模型缺失时用 comfyui_list_models 查可用文件名，每步操作见 comfyui_setup_guide。',
    parameters: {
      models: {
        type: 'array',
        items: { type: 'string' },
        description: '可选：额外校验的模型文件列表，格式 "目录/文件名"，如 ["diffusion_models/anima-base-v1.0.safetensors", "loras/surtr945_v1.safetensors"]；结果在 checks[] 中返回。',
      },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => textBlock(renderStatus(value)) },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const info = { url: COMFYUI_URL, pipeline: DEFAULT_PIPELINE, pipeline_exists: existsSync(DEFAULT_PIPELINE), comfyui: 'offline (Error)', missing: [], ready: false }
      let stats
      try {
        stats = await systemStats({ signal: exec.signal })
        info.comfyui = 'online'
      } catch (error) {
        info.comfyui = error instanceof HttpError ? `http ${error.status}` : `offline (${error?.name ?? 'Error'})`
      }
      if (info.comfyui !== 'online') info.missing.push('ComfyUI 未运行（启动 ComfyUI，默认 127.0.0.1:8188；启动后用 comfyui_status 复查）')
      if (stats) {
        info.comfyui_version = stats.system?.comfyui_version
        info.python_version = String(stats.system?.python_version ?? '').split(' ')[0] || undefined
        info.os = stats.system?.os
        info.devices = (stats.devices ?? []).map((device) => ({
          name: device.name,
          type: device.type,
          vram_total: device.vram_total,
          vram_free: device.vram_free,
          vram_total_gb: typeof device.vram_total === 'number' ? Math.round((device.vram_total / 1e9) * 100) / 100 : undefined,
          vram_free_gb: typeof device.vram_free === 'number' ? Math.round((device.vram_free / 1e9) * 100) / 100 : undefined,
        }))
        if (stats.memory && typeof stats.memory === 'object') info.memory = stats.memory
      }
      try {
        info.queue = await queueView({ signal: exec.signal })
      } catch {
        // the queue is a convenience: an unreachable server already shows above
      }
      let modelsOk = true
      if (info.pipeline_exists) {
        try {
          const graph = loadPipeline()
          for (const [classType, inputName, folder, label] of PIPELINE_RESOURCES) {
            for (const [, node] of findNodes(graph, classType)) {
              const name = node.inputs?.[inputName]
              if (!name) continue
              try {
                await requireResource(folder, name, { signal: exec.signal })
              } catch {
                modelsOk = false
                info.missing.push(`${label}缺失: ${name}（放 models/${folder}/，可用 comfyui_list_models 确认文件名）`)
              }
            }
          }
        } catch {
          modelsOk = false
          info.missing.push('pipeline.json 解析失败（用 comfyui_setup_guide 检查安装步骤）')
        }
      }
      info.models_ok = modelsOk
      try {
        const tags = await getJson(OLLAMA_URL, '/api/tags', { timeoutMs: 5000, signal: exec.signal })
        const have = new Set((tags?.models ?? []).map((model) => model.name))
        info.ollama = {}
        for (const need of ['qwen3-vl:8b', 'llava:7b']) {
          info.ollama[need] = have.has(need)
          if (!have.has(need)) {
            if (!info.on_demand) info.on_demand = []
            info.on_demand.push(`Ollama 模型 ${need} 未装（首次识图时提醒用户安装：ollama pull ${need}）`)
          }
        }
      } catch (error) {
        info.ollama = `offline (${error?.name ?? 'Error'})`
        if (!info.on_demand) info.on_demand = []
        info.on_demand.push('Ollama 未运行（comfyui_describe_image 按需：首次识图时再安装/启动 Ollama，默认 127.0.0.1:11434）')
      }
      try {
        const health = await tryJson(CAMOFOX_URL, '/health', { timeoutMs: 5000, signal: exec.signal })
        info.camofox = health?.ok === true ? 'online' : `offline (${JSON.stringify(health ?? 'unreachable').slice(0, 80)})`
      } catch (error) {
        info.camofox = error instanceof HttpError ? `offline (http ${error.status})` : `offline (${error?.name ?? 'Error'})`
      }
      if (info.camofox !== 'online') info.missing.push('camofox-browser 未运行（必需：comfyui_lookup_character_tags / comfyui_lookup_character_appearance 不可用；启动 camofox-browser，默认 127.0.0.1:9377）')
      info.civitai = { token: !!CIVITAI_TOKEN, search_key: !!CIVITAI_SEARCH_KEY }
      if (!CIVITAI_TOKEN) info.missing.push('CIVITAI_TOKEN 未配置（comfyui_download_lora 不可用；可选）')
      if (!CIVITAI_SEARCH_KEY) info.missing.push('CIVITAI_SEARCH_KEY 未配置（comfyui_search_lora 不可用；可选）')
      info.ready = info.comfyui === 'online' && modelsOk
      if (info.missing.length > 0) info.guidance = '按 missing[] 逐项补齐依赖；每一步的操作与验证见 comfyui_setup_guide，模型文件名用 comfyui_list_models 确认。'
      try {
        info.recent_runs = recentRunSources(await historyView({ limit: 5, signal: exec.signal }))
      } catch {
        info.recent_runs = []
      }
      if (args.models?.length) {
        info.checks = []
        for (const resource of args.models) {
          const slash = resource.indexOf('/')
          const folder = slash > 0 ? resource.slice(0, slash) : 'checkpoints'
          const name = slash > 0 ? resource.slice(slash + 1) : resource
          const check = { resource, found: false }
          try {
            await requireResource(folder, name, { signal: exec.signal })
            check.found = true
          } catch (error) {
            check.error = String(error?.message ?? error)
          }
          info.checks.push(check)
        }
      }
      return info
    },
  }),

  defineTool({
    name: 'comfyui_list_models',
    description: '列出本地 ComfyUI 某个模型目录下的文件名（checkpoints / diffusion_models / loras / vae / text_encoders / '
      + 'upscale_models / controlnet / clip_vision / embeddings 等），folder="models" 时列出所有目录。'
      + '用 search 按子串过滤、limit 截断。写 comfyui_generate 的 unet_name/lora_text 或 comfyui_run_workflow 的模型名之前先用本工具确认真实文件名。',
    parameters: {
      folder: { type: 'string', enum: MODEL_FOLDERS, description: '模型目录；默认 checkpoints，models = 列出全部目录。' },
      search: { type: 'string', description: '按文件名子串过滤（不区分大小写）。' },
      limit: { type: 'integer', description: '每个目录最多返回多少个文件名（默认 500）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          folder: { type: 'string', required: true },
          count: { type: 'integer', required: true },
          names: { type: 'array', required: true, items: { type: 'string' } },
          folders: { type: 'object', additionalProperties: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => textBlock([
        `models/${value.folder}: ${value.count} 个文件${value.error ? `（${value.error}）` : ''}`,
        ...(value.names ?? []),
        ...Object.entries(value.folders ?? {}).map(([folder, names]) => `[${folder}] ${names.length}`),
      ].join('\n')),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const folder = args.folder ?? 'checkpoints'
      const limit = Math.max(args.limit ?? 500, 1)
      const filter = (names) => {
        const matched = args.search ? names.filter((name) => name.toLowerCase().includes(args.search.toLowerCase())) : names
        return { count: matched.length, names: matched.slice(0, limit) }
      }
      if (folder === 'models') {
        const folders = {}
        for (const name of MODEL_FOLDERS.filter((entry) => entry !== 'models')) {
          try {
            folders[name] = await modelNames(name, { signal: exec.signal })
          } catch {
            folders[name] = []
          }
        }
        return { folder, count: Object.values(folders).reduce((total, names) => total + names.length, 0), names: [], folders }
      }
      try {
        return { folder, ...filter(await modelNames(folder, { signal: exec.signal })) }
      } catch (error) {
        return { folder, count: 0, names: [], error: String(error?.message ?? error) }
      }
    },
  }),

  defineTool({
    name: 'comfyui_generate',
    description: '在本地 ComfyUI 上生成图像并等待完成。engine="anima"（默认）：pipeline.json 管线（UNETLoader anima-base-v1.0 + '
      + 'CLIPLoader qwen_3_06b_base + VAELoader qwen_image_vae，832x1216，30 步 CFG 4，euler_ancestral/simple，'
      + 'RealESRGAN_x2plus 2x 放大，仅内置节点）；lora_text 省略时自动挂默认 5 件套 LoRA（传 "" 空载），'
      + '用 <lora:文件名:权重> 语法，动态插入标准 LoraLoader 链。engine="krea2"：Krea2/Dasiwa 自然语言模型'
      + '（CLIPLoader qwen3vl_4b_fp8_scaled type krea2，8 步 CFG 1，er_sde/simple，默认 1024x1536），'
      + 'lora_list 按顺序挂载，upscale=true 加 RealESRGAN_x2plus 2x。提交前校验 unet/LoRA 文件是否存在（comfyui_list_models 可查名）。'
      + 'character 或提示词中的 danbooru 角色标签（如 varesa_(genshin_impact)）会自动查缓存、缺失时经 camofox 查 Danbooru 并附带 character_info。'
      + '传 reference_image（参考图路径）时额外生成对比页并返回 view_url。IMPORTANT: 提示词必须先与用户确认再调用；冷启动首次运行可能需要 10-20 分钟。',
    parameters: {
      prompt: { type: 'string', required: true, description: '正向提示词（anima 用 danbooru tag，krea2 可自然语言）。' },
      negative_prompt: { type: 'string', description: '负面提示词；省略或空串时使用默认质量黑名单。' },
      seed: { type: 'integer', description: '随机种子；省略时随机（2^53 以内）。' },
      width: { type: 'integer', description: '宽度；anima 默认 832，krea2 默认 1024。必须 0 < width <= 4096。' },
      height: { type: 'integer', description: '高度；anima 默认 1216，krea2 默认 1536。必须 0 < height <= 4096。' },
      unet_name: { type: 'string', description: `diffusion_models 下的 UNET 文件名；anima 默认 ${DEFAULT_UNET}，krea2 默认 ${KREA2_UNET}。`
        + '本机没有默认 krea2 底模时用 comfyui_list_models folder=diffusion_models 查可用文件（官方 int8 版为 krea2_turbo_int8_convrot.safetensors）。' },
      lora_text: { type: 'string', description: 'LoRA 文本（<lora:文件名:权重>，逗号分隔）；省略时挂默认 5 件套 LoRA，传 "" 空载。' },
      scheduler: { type: 'string', description: 'anima 调度器（默认 simple）。' },
      character: { type: 'string', description: '角色名或 danbooru 标签；省略时从 prompt 中提取 xxx_(series) 形式的标签。' },
      timeout: { type: 'integer', description: '等待秒数，覆盖排队+生成（默认 600，范围 30-3600）。队列前面有任务时调大。' },
      engine: { type: 'string', enum: ['anima', 'krea2'], description: '生成引擎，默认 anima。' },
      steps: { type: 'integer', description: 'anima 采样步数（默认 30；krea2 固定 8）。' },
      cfg: { type: 'number', description: 'anima 的 CFG（默认 4.0；krea2 固定 1.0）。' },
      sampler_name: { type: 'string', description: 'anima 采样器（默认 euler_ancestral）。' },
      lora_list: {
        type: 'array',
        description: 'krea2 的 LoRA 列表（按顺序挂载到 model 与 clip）；anima 请用 lora_text。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: { name: { type: 'string', required: true, description: 'models/loras/ 下的文件名。' }, strength: { type: 'number', description: '权重，默认 1.0。' } },
        },
      },
      upscale: { type: 'boolean', description: 'krea2 是否加 RealESRGAN_x2plus 2x 放大（anima 管线自带放大）。' },
      reference_image: { type: 'string', description: '可选：参考图（原图）绝对路径；给出时生成后返回原图 vs 生成的对比页 view_url。' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => textBlock(renderGenerate(value)) },
    async execute(args, exec) {
      const engine = args.engine ?? 'anima'
      const negative = args.negative_prompt || DEFAULT_NEGATIVE
      const loraText = args.lora_text === undefined ? DEFAULT_LORA_TEXT : args.lora_text
      const character = args.character || characterFromPrompt(args.prompt)
      const characterInfo = character ? await lookupCharacterInfo(character) : undefined
      const seed = args.seed ?? Math.floor(Math.random() * 2 ** 53)
      let unetName = args.unet_name
      if (engine === 'krea2' && (!unetName || unetName === DEFAULT_UNET)) unetName = KREA2_UNET
      const started = Date.now()
      let run
      let baseModel
      if (engine === 'krea2') {
        baseModel = deriveBaseModel(unetName)
        run = await runKrea2({
          prompt: args.prompt,
          negativePrompt: negative,
          seed,
          width: args.width ?? 1024,
          height: args.height ?? 1536,
          unetName,
          loraList: args.lora_list,
          upscale: !!args.upscale,
          timeoutMs: timeoutMs(args.timeout, 900),
          signal: exec.signal,
        })
      } else {
        baseModel = deriveBaseModel(pipelineUnet(unetName))
        run = await runPipeline({
          prompt: args.prompt,
          negativePrompt: negative,
          seed,
          width: args.width,
          height: args.height,
          unetName: unetName || DEFAULT_UNET,
          loraText,
          scheduler: args.scheduler || 'simple',
          steps: args.steps,
          cfg: args.cfg,
          samplerName: args.sampler_name,
          timeoutMs: timeoutMs(args.timeout, 600),
          signal: exec.signal,
        })
      }
      const result = {
        prompt_id: run.prompt_id,
        status: run.status,
        outputs: run.outputs,
        images: imageItems(run.outputs),
        seed,
        engine,
        base_model: baseModel,
        elapsed_s: Math.max(1, Math.round((Date.now() - started) / 1000)),
      }
      if (characterInfo) result.character_info = characterInfo
      return makeView(result, args.reference_image)
    },
  }),

  defineTool({
    name: 'comfyui_run_workflow',
    description: '提交任意 API 格式的 workflow（prompt 图：{"节点id": {"class_type": "...", "inputs": {...}}}）并等待执行完成，'
      + '返回 prompt_id、输出图片与各节点输出摘要。节点输入名/类型用 comfyui_node_info 查询，模型名用 comfyui_list_models 查询。'
      + '提交时自动在每个节点 _meta 打上标记，便于 comfyui_history 区分 agent 提交与手动提交。graph_json 可以是 JSON 字符串或直接的对象。',
    parameters: {
      graph_json: { type: 'json', required: true, description: 'API 格式的 prompt 图（JSON 字符串或对象），每个值必须是含 class_type 的节点对象。' },
      timeout: { type: 'integer', description: '等待秒数，覆盖排队+生成（默认 600，范围 30-3600）。' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const images = (value.images ?? []).map((image) => `- ${image.path ?? image.view_url}`).join('\n')
        return textBlock(`workflow 执行完成（prompt_id=${value.prompt_id}, 用时 ${value.elapsed_s}s, 图片 ${value.images.length} 张）\n${images}`)
      },
    },
    async execute(args, exec) {
      let graph = args.graph_json
      if (typeof graph === 'string') {
        try {
          graph = JSON.parse(graph)
        } catch (error) {
          throw new Error(`graph_json 不是合法 JSON: ${error?.message ?? error}`)
        }
      }
      if (!graph || typeof graph !== 'object' || Array.isArray(graph)) throw new Error('graph_json 必须是 {"节点id": {"class_type": ..., "inputs": ...}} 形式的对象')
      for (const [nodeId, node] of Object.entries(graph)) {
        if (!node || typeof node !== 'object' || typeof node.class_type !== 'string') throw new Error(`节点 ${nodeId} 缺少 class_type`)
      }
      const started = Date.now()
      const run = await runGraph(graph, { timeoutMs: timeoutMs(args.timeout, 600), signal: exec.signal })
      return { ...run, images: imageItems(run.outputs), elapsed_s: Math.max(1, Math.round((Date.now() - started) / 1000)) }
    },
  }),

  defineTool({
    name: 'comfyui_history',
    description: '查询 ComfyUI 运行历史：给 prompt_id 返回该次运行的状态、起止时间/耗时、输出图片（含产出节点）、生成参数与 '
      + 'source（mcp = agent 通过本插件提交，manual = 网页手动提交）；不给 prompt_id 则返回最近 limit 条记录。'
      + '排查失败、找回 seed/参数、确认输出文件位置时使用。',
    parameters: {
      limit: { type: 'integer', description: '不给 prompt_id 时返回最近多少条（默认 5）。' },
      prompt_id: { type: 'string', description: 'ComfyUI prompt_id；给出时只返回这一条。' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => textBlock(renderHistory(value)) },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (args.prompt_id) {
        let entry
        try {
          entry = await historyView({ promptId: args.prompt_id, signal: exec.signal })
        } catch (error) {
          return { prompt_id: args.prompt_id, found: false, error: String(error?.message ?? error) }
        }
        if (!entry) return { prompt_id: args.prompt_id, found: false }
        const [run] = historyToRuns({ [args.prompt_id]: entry })
        const result = { prompt_id: args.prompt_id, found: true, ...run }
        if (run.status === 'error' || run.status === 'failed') result.error = executionError(entry.status)
        const prompt = Array.isArray(entry.prompt) && entry.prompt.length > 2 ? entry.prompt[2] : entry.prompt
        result.generation = parseComfyPrompt(prompt)
        return result
      }
      let history
      try {
        history = await historyView({ limit: args.limit ?? 5, signal: exec.signal })
      } catch (error) {
        return { found: false, count: 0, runs: [], error: String(error?.message ?? error) }
      }
      const runs = historyToRuns(history)
      return { found: true, count: runs.length, runs }
    },
  }),

  defineTool({
    name: 'comfyui_queue',
    description: '查看或控制 ComfyUI 队列：status（默认）返回运行中/排队中的任务数与 prompt_id；interrupt 中断当前正在执行的任务；clear 清空排队中（未开始）的任务。任务卡住或想插队时使用。',
    parameters: {
      action: { type: 'string', enum: ['status', 'interrupt', 'clear'], description: '操作，默认 status。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          ok: { type: 'boolean', required: true },
          error: { type: 'string' },
          running_count: { type: 'integer' },
          pending_count: { type: 'integer' },
          running: { type: 'array', items: { type: 'string' } },
          pending: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const head = `队列 ${value.action}: ${value.ok ? '成功' : '失败'}${value.error ? ` — ${value.error}` : ''}`
        if (value.running_count === undefined) return textBlock(head)
        const running = value.running.length ? `\n运行中: ${value.running.join(', ')}` : ''
        const pending = value.pending.length ? `\n排队: ${value.pending.join(', ')}` : ''
        return textBlock(`${head}\n运行中 ${value.running_count} / 排队 ${value.pending_count}${running}${pending}`)
      },
    },
    async execute(args, exec) {
      const action = args.action ?? 'status'
      try {
        if (action === 'interrupt') {
          await interrupt({ signal: exec.signal })
          return { action, ok: true }
        }
        if (action === 'clear') {
          await clearQueue({ signal: exec.signal })
          return { action, ok: true }
        }
        return { action, ok: true, ...(await queueView({ signal: exec.signal })) }
      } catch (error) {
        return { action, ok: false, error: String(error?.message ?? error) }
      }
    },
  }),

  defineTool({
    name: 'comfyui_node_info',
    description: '查询 ComfyUI 某节点类型的输入/输出定义（/object_info/{class_type}）：必填/可选输入名、类型、combo 选项、默认值与范围、输出名。用 comfyui_run_workflow 搭 workflow 前用它确认输入名与可用值。',
    parameters: {
      class_type: { type: 'string', required: true, description: '节点类型名，如 KSampler、SaveImage、LoraLoader、UNETLoader。' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => textBlock(value.error
      ? `${value.class_type} — ${value.error}`
      : `${value.class_type}${value.display_name ? ` (${value.display_name})` : ''}${value.output_node ? ' [输出节点]' : ''}`
        + (value.description ? `\n${value.description}` : '')
        + `\n必填输入: ${Object.keys(value.input?.required ?? {}).join(', ')}`
        + `\n可选输入: ${Object.keys(value.input?.optional ?? {}).join(', ')}`
        + `\n输出: ${(value.output ?? []).join(', ')}`
        + `\n输入详情: ${JSON.stringify(value.input ?? {}).slice(0, 2000)}`) },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      try {
        const node = await nodeInfo(args.class_type, { signal: exec.signal })
        return node ?? { class_type: args.class_type, error: `未找到节点类型 ${args.class_type}（/object_info 未返回定义）` }
      } catch (error) {
        return { class_type: args.class_type, error: String(error?.message ?? error) }
      }
    },
  }),

  defineTool({
    name: 'comfyui_extract_image_info',
    description: '解析图片中内嵌的生成元数据：ComfyUI 的 prompt/workflow JSON（模型、seed、steps/cfg/sampler、尺寸、LoRA 链——含标准 '
      + 'LoraLoader、rgthree Power Lora Loader、ZML Power Lora Loader、提示词文本）、WebUI 的 parameters。'
      + 'PNG 走 tEXt/iTXt/zTXt 文本块；其他容器（JPEG 等）只报告格式与能取到的文本，不猜测。用于复刻图片或追溯参数。',
    parameters: {
      image_path: { type: 'string', required: true, description: '图片文件路径（PNG/JPEG；相对路径按当前工作目录解析）。' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => textBlock(renderImageInfo(value)) },
    isConcurrencySafe: () => true,
    execute(args) {
      return readImageInfo(args.image_path)
    },
  }),

  defineTool({
    name: 'comfyui_get_model_guide',
    description: 'Anima 模型官方使用指南（来自 circlestone-labs/Anima README）：三个版本（base/aesthetic/turbo）的差异与选择、'
      + '推荐分辨率/步数/CFG/采样器、提示词规则（tag 顺序、画师 @ 前缀、quality tags、aesthetic 版差异）、'
      + 'LoRA 训练与使用建议、已知限制与许可。组装提示词或选生成参数前先查这里，不要凭猜测。',
    parameters: {},
    output: { schema: { type: 'json' }, render: (_args, value) => textBlock(JSON.stringify(value, null, 1).slice(0, 4000)) },
    isConcurrencySafe: () => true,
    execute() {
      return ANIMA_GUIDE
    },
  }),
]
