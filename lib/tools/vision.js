/**
 * Image description + 小番茄 de-obfuscation tools.
 *
 * `comfyui_describe_image` has two routes, and the tool is **off by default**:
 * the session's own model is usually multimodal, so the caller is expected to
 * read the image itself (`read_image`) unless it explicitly turns this tool on.
 * When enabled, the host vision model (`deepseek-v4.1-flash` on `opencode-go`,
 * falling back to other vision-capable host models) is preferred; an explicit
 * Ollama model name keeps the upstream path (default qwen3-vl:8b, which answers
 * Chinese but refuses NSFW, with an automatic llava:7b retry).
 *
 * `comfyui_deconfuse_image` is a port of the upstream `deconfuse_image` plus the
 * full `xfq_tool.py` surface it drives: the Gilbert-curve permutation in
 * lib/xfq.js, `--times`, `--mode` and `--preserve-meta`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { OLLAMA_URL, STATE_DIR, outputDir, resolveUserPath } from '../env.js'
import { HttpError, postJson } from '../http.js'
import { decodePng, encodePng, parsePng } from '../png.js'
import { hostAttachments, hostLlm } from '../services.js'
import { defineTool } from '../tool.js'
import { transformTimes } from '../xfq.js'

const MAIN_MODEL = 'qwen3-vl:8b'
const FALLBACK_MODEL = 'llava:7b'
/** Upstream's detail path refuses on all six keywords; its single-question path omits 健康积极. */
const REFUSAL_KEYWORDS = ['无法提供', '不能', '抱歉', '不当内容', '公序良俗', '健康积极']
/** The single-question path uses upstream's five keywords; 健康积极 is detail-mode only. */
const REFUSAL_KEYWORDS_SINGLE = ['无法提供', '不能', '抱歉', '不当内容', '公序良俗']
const DEFAULT_QUESTION = '请详细描述这张图片，用中文：1) 角色外貌（发型、发色、瞳色、体型）2) 服装 3) 姿势/动作 4) 场景背景 5) 视角构图 6) 画风。'
const FALLBACK_QUESTION = 'Describe this image in detail: character appearance, clothing, pose, background, art style.'
const DETAIL_SUFFIX = '请详细列举，不要省略任何细节，分点回答。'
const DETAIL_QUESTIONS = [
  '头发：发色（含渐变层次）、发型、长度、发饰配件（蝴蝶结/发夹/猫耳等）？',
  '眼睛：瞳色、眼型、表情细节（眼神、眉毛、嘴型）？',
  '体型与皮肤：体型特征、肤色、特殊标记（纹身/伤痕/痣）？',
  '服装：从上到下逐件描述（上衣/下装/袜子/鞋子）、材质、颜色、装饰、配饰（首饰/项圈/腰带）？',
  '手持物与道具：角色拿着或身边有什么道具？',
  '姿势：全身姿势细节（手/腿/头的位置和角度）、重心？',
  '场景：环境（室内/室外、具体场所、家具/建筑）、光线来源与方向、色调？',
  '背景分层：前景/中景/背景各有什么元素？虚化程度如何？',
  '构图：视角（俯视/仰视/平视）、景别（特写/近景/中景/全景）、人物在画面中的位置、留白情况？',
  '画风：具体风格（赛璐璐/厚涂/水彩/3D渲染）、线条特点、上色方式？',
  '画面文字/水印/特效：有没有文字、水印、光效、粒子、飘落物？',
]
const DETAIL_FALLBACK_QUESTIONS = [
  'Hair: exact hair color, hairstyle, length, any hair accessories?',
  'Eyes: eye color, eye shape, expression?',
  'Body: body type, skin details, what is she wearing exactly (top, bottom, shoes)?',
  'Pose: exact body position, what is she doing with her hands, legs, head?',
  'Objects: list every object visible in the image (furniture, props, food, toys)?',
  'Scene: indoor or outdoor, what room, background details, lighting?',
  'Art style: 2D anime, 3D, painterly, line art? Color palette?',
  'Camera angle: is the camera at eye level, looking up from below (low angle), or looking down from above (high angle)?',
  'Zoom level: is it a close-up, medium shot, waist-up, full body, or wide shot?',
  'Framing: where is the character positioned in the frame (center, left, right)? Is there much empty space around her?',
  'Perspective: is she seen from the front, side, three-quarter view, or from behind?',
]
/** The upstream gives each Ollama request 900 seconds. */
const REQUEST_TIMEOUT_MS = 900_000
/** Upper bound on de-obfuscation passes; each one is a full synchronous pixel walk. */
const MAX_TIMES = 64

/**
 * Vision is off unless the caller turns it on.
 *
 * The session's own model is usually already multimodal, so paying for a second
 * vision route on every describe call is the wrong default. `DSH_COMFYUI_VISION=1`
 * turns it on for a deployment without changing how the model calls the tool.
 */
function visionEnabled(args) {
  if (args.enable_vision === true) return true
  if (args.enable_vision === false) return false
  return /^(1|true|yes|on)$/i.test(process.env.DSH_COMFYUI_VISION ?? '')
}

const VISION_DISABLED_MESSAGE = [
  '视觉服务默认关闭，没有发起任何识图请求。',
  '你（当前会话模型）很可能已经是多模态模型：直接调用宿主的 read_image 看图，比走第二个视觉服务更快也更准。',
  '确实需要这个工具代识别图时，显式传 enable_vision=true（或在 DSH 进程里设 DSH_COMFYUI_VISION=1）。',
].join('\n')

/** Ordered vision routes: the named host model first, then any other vision-capable host model. */
export const HOST_VISION_CANDIDATES = [
  { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
  { provider: 'deepseek-official', model: 'deepseek-flash' },
  { provider: 'deepseek-account', model: 'deepseek-flash' },
]

/**
 * Resolve the ordered routes to try: an explicit provider/model wins, then the
 * preferred host models that actually exist and accept images, then nothing
 * (which leaves the Ollama path in charge).
 *
 * `resolveModelInfo` is the host's own way to answer "can this model see
 * images"; `listModels` is the fallback for an older adapter.
 */
async function resolveVisionRoutes(llm, override) {
  if (override) {
    if (override.includes('/')) {
      const [provider, ...rest] = override.split('/')
      return [{ provider, model: rest.join('/') }]
    }
    return HOST_VISION_CANDIDATES.filter((route) => route.model === override)
  }
  const routes = []
  for (const candidate of HOST_VISION_CANDIDATES) {
    if (await hostModelSeesImages(llm, candidate)) routes.push(candidate)
  }
  return routes
}

async function hostModelSeesImages(llm, { provider, model }) {
  try {
    const info = await llm.resolveModelInfo(provider, model)
    const modalities = info?.inputModalities
    if (Array.isArray(modalities)) return modalities.includes('image')
  } catch {
    // fall through to the list
  }
  try {
    const models = await llm.listModels(provider)
    const hit = models.find((entry) => entry.id === model)
    return (hit?.inputModalities ?? []).includes('image')
  } catch {
    return false
  }
}

/** One host vision turn; images are admitted by the attachment service first. */
async function askHost(llm, attachments, route, imagePath, question, signal) {
  const data = readFileSync(imagePath)
  const mediaType = imageMediaType(imagePath)
  const ref = await attachments.saveImage({ data, mediaType, name: basename(imagePath) })
  const chunks = llm.stream({
    provider: route.provider,
    model: route.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: question }, { type: 'image', attachment: ref }] }],
    signal,
  })
  let text = ''
  for await (const chunk of chunks) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'block-end' && chunk.block?.type === 'text') text += chunk.block.text
    else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
      throw new Error(`vision model ${route.provider}/${route.model} failed: ${chunk.reason.failure?.message ?? 'unknown error'}`)
    }
  }
  return text
}

function imageMediaType(path) {
  const extension = extname(path).toLowerCase()
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.webp') return 'image/webp'
  if (extension === '.gif') return 'image/gif'
  return 'image/png'
}

/** One non-streaming vision turn; a missing model is reported as an install hint. */
async function ask(model, image, question, numCtx, signal) {
  try {
    const body = await postJson(OLLAMA_URL, '/api/chat', {
      model,
      messages: [{ role: 'user', content: question, images: [image] }],
      stream: false,
      options: { num_gpu: 99, num_ctx: numCtx },
    }, { timeoutMs: REQUEST_TIMEOUT_MS, signal })
    return body?.message?.content || body?.error || ''
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) throw new Error(`Ollama model "${model}" is not installed — run: ollama pull ${model}`)
    throw error
  }
}

/**
 * Refusal detection. Upstream uses a wider keyword list for the detail mode's
 * Chinese questions (which enumerate body detail) than for a single free-form
 * question, so a benign answer containing 健康积极 does not trigger the
 * uncensored fallback there.
 */
function refused(answer, keywords = REFUSAL_KEYWORDS) {
  return !answer || keywords.some((keyword) => answer.includes(keyword))
}

async function describe(imagePath, question, detail, model, signal, enableVision) {
  const path = resolveUserPath(imagePath)
  if (!existsSync(path)) throw new Error(`file not found: ${imagePath}`)
  if (!enableVision) return VISION_DISABLED_MESSAGE
  const route = await pickVisionRoute(model)
  if (route) return describeWithHost(path, question, detail, route, signal)
  if (model && !model.includes('/')) return describeWithOllama(path, question, detail, model, signal)
  return describeWithOllama(path, question, detail, undefined, signal)
}

/**
 * Pick the host vision route. An explicit `provider/model` wins; an explicit
 * model id is matched against the known routes; otherwise the first known route
 * that exists and accepts images wins. `undefined` means "use Ollama".
 */
async function pickVisionRoute(model) {
  const llm = hostLlm()
  if (!llm) return undefined
  if (model && model.includes('/')) {
    const [provider, ...rest] = model.split('/')
    return { provider, model: rest.join('/') }
  }
  const routes = await resolveVisionRoutes(llm, model)
  return routes[0]
}

function describeWithHost(path, question, detail, route, signal) {
  const llm = hostLlm()
  const attachments = hostAttachments()
  if (!attachments?.saveImage) {
    throw new Error('视觉服务需要宿主的 attachments 服务来提交图片，但它不可用；改用当前会话模型自带的 read_image 看图，或把 model 设为 ollama 的模型名以走本地 Ollama')
  }
  if (detail) {
    return (async () => {
      const parts = []
      for (let i = 0; i < DETAIL_QUESTIONS.length; i++) {
        const asked = `${DETAIL_QUESTIONS[i]} ${DETAIL_SUFFIX}`
        const answer = (await askHost(llm, attachments, route, path, asked, signal)).trim()
        parts.push(`${i + 1}. ${asked}\n   → ${answer}`)
      }
      return parts.join('\n\n')
    })()
  }
  return askHost(llm, attachments, route, path, question || DEFAULT_QUESTION, signal).then((answer) => answer.trim())
}

async function describeWithOllama(path, question, detail, model, signal) {
  const image = readFileSync(path).toString('base64')
  const main = model || MAIN_MODEL
  if (detail) {
    let parts = []
    let blocked = false
    for (let i = 0; i < DETAIL_QUESTIONS.length; i++) {
      const asked = `${DETAIL_QUESTIONS[i]} ${DETAIL_SUFFIX}`
      const answer = (await ask(main, image, asked, 8192, signal)).trim()
      if (refused(answer)) {
        blocked = true
        break
      }
      parts.push(`${i + 1}. ${asked}\n   → ${answer}`)
    }
    if (blocked) {
      parts = []
      for (let i = 0; i < DETAIL_FALLBACK_QUESTIONS.length; i++) {
        const answer = (await ask(FALLBACK_MODEL, image, DETAIL_FALLBACK_QUESTIONS[i], 2048, signal)).trim()
        parts.push(`${i + 1}. ${DETAIL_FALLBACK_QUESTIONS[i]}\n   → ${answer}`)
      }
    }
    return parts.join('\n\n')
  }
  const asked = question || DEFAULT_QUESTION
  const answer = (await ask(main, image, asked, 8192, signal)).trim()
  if (refused(answer, REFUSAL_KEYWORDS_SINGLE)) return (await ask(FALLBACK_MODEL, image, FALLBACK_QUESTION, 2048, signal)).trim()
  return answer
}

/** PIL's `convert('RGB')`: drop the alpha channel, keep the colour channels. */
function toRgb(image) {
  if (image.channels === 3) return image
  const data = new Uint8Array(image.width * image.height * 3)
  for (let i = 0, o = 0; i < image.data.length; i += 4) {
    data[o++] = image.data[i]
    data[o++] = image.data[i + 1]
    data[o++] = image.data[i + 2]
  }
  return { width: image.width, height: image.height, channels: 3, data }
}

async function deconfuse(args) {
  const src = resolveUserPath(args.image_path)
  if (!existsSync(src)) throw new Error(`file not found: ${args.image_path}`)
  const mode = args.mode ?? 'dec'
  const times = args.times ?? 1
  // Each pass is CPU-bound in the host process, so an unbounded count would
  // block the harness long past the tool's own timeout (which is only consulted
  // after the body settles). 小番茄 images in the wild are single- or
  // double-obfuscated; anything beyond MAX_TIMES is a mistake, not a workload.
  if (!Number.isInteger(times) || times < 1) throw new Error(`times must be a positive integer: ${args.times}`)
  if (times > MAX_TIMES) throw new Error(`times is limited to ${MAX_TIMES} passes, got ${times}`)
  const preserveMeta = args.preserve_meta === true
  const raw = readFileSync(src)
  const textChunks = preserveMeta ? parsePng(raw).textChunks : []
  const input = decodePng(raw)
  const result = transformTimes(toRgb(input), mode, times)
  // out_path is a caller-supplied write target, so an explicit one must stay in
  // a directory this plugin owns. The default keeps upstream's behaviour of
  // writing beside the input; when the input's directory is not writable by
  // policy, it falls back to the state directory.
  const allowed = [outputDir(), STATE_DIR].map((dir) => resolve(dir) + sep)
  const besideInput = join(dirname(src), `${basename(src, extname(src))}_${mode === 'enc' ? 'enc' : 'dec'}.png`)
  let out
  if (args.out_path) {
    out = resolveUserPath(args.out_path)
    if (!allowed.some((prefix) => out.startsWith(prefix))) {
      throw new Error(`out_path must stay inside ${outputDir()} or ${STATE_DIR}: ${args.out_path}`)
    }
  } else {
    out = allowed.some((prefix) => besideInput.startsWith(prefix)) ? besideInput : join(STATE_DIR, basename(besideInput))
  }
  mkdirSync(dirname(out), { recursive: true })
  const log = [`输入: ${src} (${input.width}x${input.height})`]
  for (let i = 0; i < times; i++) log.push(`  第${i + 1}次${mode === 'dec' ? '解混淆' : '混淆'}完成`)
  if (preserveMeta && textChunks.length === 0) log.push('警告: 输入无文本元数据，直接保存')
  writeFileSync(out, encodePng(result, { textChunks }))
  log.push(textChunks.length > 0 ? `输出: ${out}（元数据已保留）` : `输出: ${out}`)
  return { input: src, output: out, times, mode, log: log.join('\n') }
}

export const tools = [
  defineTool({
    name: 'comfyui_describe_image',
    description: `Describe a local image file. **Off by default**: you are usually a multimodal model already, so read the image yourself with the host's read_image tool instead of paying for a second vision route — that is faster, sees the original pixels, and costs no extra call. Call this tool only when you explicitly want a second opinion from a vision service, and then pass enable_vision=true (or set DSH_COMFYUI_VISION=1 in the DSH environment to make it the default for a deployment).
When enabled, the host vision model is preferred: deepseek-v4.1-flash on opencode-go, then deepseek-flash on deepseek-official/deepseek-account — whichever exists and accepts images. An explicit model id picks a route: "provider/model" or a known host model id uses the host service, a bare Ollama model name (e.g. qwen3-vl:8b) keeps the local Ollama path, and "ollama" forces it. The Ollama path is the port of the upstream tool: qwen3-vl:8b is accurate and answers Chinese but refuses NSFW, so it retries once with llava:7b (English, no filter).
Pass \`question\` for one specific question, or detail=true for the 11-question Chinese report (hair, eyes, body, clothing, props, pose, scene, background layering, composition, art style, on-image text/watermark).`,
    timeoutMs: 2 * 60 * 60 * 1000,
    parameters: {
      image_path: { type: 'string', required: true, description: 'Path to a local image file (PNG/JPEG/WebP).' },
      enable_vision: { type: 'boolean', default: false, description: 'Turn the vision service on for this call. Defaults to off (and to DSH_COMFYUI_VISION when set): with a multimodal session model, read the image yourself instead.' },
      question: { type: 'string', description: 'One question to ask about the image. Defaults to a thorough Chinese description request.' },
      detail: { type: 'boolean', default: false, description: 'Run the 11-question Chinese detail report instead of a single question. Slow: 11 sequential model calls.' },
      model: { type: 'string', description: 'Vision route override: "provider/model" or a known host model id uses the host service; a bare name such as qwen3-vl:8b keeps the local Ollama path.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      return describe(args.image_path, args.question, args.detail === true, args.model, exec?.signal, visionEnabled(args))
    },
  }),
  defineTool({
    name: 'comfyui_deconfuse_image',
    description: 'Undo 小番茄 (xiaofanqie) obfuscation, a reversible Gilbert-curve pixel permutation. Detection clue: neighbouring pixels stay strongly correlated but the picture looks like scattered fragments. mode=dec (default) restores an obfuscated image, mode=enc applies the obfuscation, and times repeats the pass (an image obfuscated N times needs N passes to come back, at most 64). Reads PNG (8/16-bit, gray/RGB/palette/RGBA, not interlaced) and writes 8-bit RGB PNG; JPEG input is refused because there is no JPEG decoder in this plugin — convert to PNG first. out_path defaults to <stem>_dec.png next to the input, and must stay inside the ComfyUI output directory or the plugin state directory. preserve_meta copies the input PNG tEXt/iTXt/zTXt text chunks onto the output, so a prompt stored before obfuscation survives the round trip. Obfuscated images that were JPEG-compressed or rescaled may not restore exactly, because the curve positions shift.',
    timeoutMs: 10 * 60 * 1000,
    parameters: {
      image_path: { type: 'string', required: true, description: 'Path to the obfuscated (or original) PNG image.' },
      times: { type: 'integer', default: 1, description: `How many passes to apply (1..${MAX_TIMES}). Use the same count that was used to obfuscate.` },
      out_path: { type: 'string', description: `Output file path; must stay inside ${outputDir()} or ${STATE_DIR}. Defaults to <stem>_dec.png (or _enc.png) next to the input.` },
      mode: { type: 'string', enum: ['dec', 'enc'], default: 'dec', description: 'dec = de-obfuscate (default), enc = obfuscate.' },
      preserve_meta: { type: 'boolean', default: false, description: 'Carry the input PNG tEXt/iTXt/zTXt text chunks onto the output (PNG input only).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          input: { type: 'string', required: true },
          output: { type: 'string', required: true },
          times: { type: 'integer', required: true },
          mode: { type: 'string', required: true },
          log: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `${value.mode} x${value.times}: ${value.input} -> ${value.output}\n${value.log}` }],
    },
    execute: deconfuse,
  }),
]
