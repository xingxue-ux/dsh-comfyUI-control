/**
 * Local vision + 小番茄 de-obfuscation tools.
 *
 * `comfyui_describe_image` is a port of the upstream `describe_image`: one
 * question to Ollama's `/api/chat` on the GPU (default qwen3-vl:8b, which
 * answers Chinese but refuses NSFW) with an automatic llava:7b retry on
 * refusal, and an 11-question Chinese report for `detail`.
 *
 * `comfyui_deconfuse_image` is a port of the upstream `deconfuse_image` plus the
 * full `xfq_tool.py` surface it drives: the Gilbert-curve permutation in
 * lib/xfq.js, `--times`, `--mode` and `--preserve-meta`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { OLLAMA_URL, resolveUserPath } from '../env.js'
import { HttpError, postJson } from '../http.js'
import { decodePng, encodePng, parsePng } from '../png.js'
import { defineTool } from '../tool.js'
import { transformTimes } from '../xfq.js'

const MAIN_MODEL = 'qwen3-vl:8b'
const FALLBACK_MODEL = 'llava:7b'
/** Upstream's detail path refuses on all six keywords; its single-question path omits 健康积极. */
const REFUSAL_KEYWORDS = ['无法提供', '不能', '抱歉', '不当内容', '公序良俗', '健康积极']
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

function refused(answer) {
  return !answer || REFUSAL_KEYWORDS.some((keyword) => answer.includes(keyword))
}

async function describe(imagePath, question, detail, model, signal) {
  const path = resolveUserPath(imagePath)
  if (!existsSync(path)) throw new Error(`file not found: ${imagePath}`)
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
  if (refused(answer)) return (await ask(FALLBACK_MODEL, image, FALLBACK_QUESTION, 2048, signal)).trim()
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
  const preserveMeta = args.preserve_meta === true
  const raw = readFileSync(src)
  const textChunks = preserveMeta ? parsePng(raw).textChunks : []
  const input = decodePng(raw)
  const result = transformTimes(toRgb(input), mode, times)
  const out = args.out_path
    ? resolveUserPath(args.out_path)
    : join(dirname(src), `${basename(src, extname(src))}_${mode === 'enc' ? 'enc' : 'dec'}.png`)
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
    description: 'Describe a local image file with a local Ollama vision model on the GPU. The default model qwen3-vl:8b is accurate and answers Chinese but refuses NSFW; the tool then automatically retries with llava:7b (English, no filter). Pass `question` for one specific question, or detail=true for the 11-question Chinese report (hair, eyes, body, clothing, props, pose, scene, background layering, composition, art style, on-image text/watermark) assembled into a full description. `model` overrides the default. Use this to inspect a generated or referenced image instead of guessing its content.',
    timeoutMs: 2 * 60 * 60 * 1000,
    parameters: {
      image_path: { type: 'string', required: true, description: 'Path to a local image file (PNG/JPEG/WebP).' },
      question: { type: 'string', description: 'One question to ask about the image. Defaults to a thorough Chinese description request.' },
      detail: { type: 'boolean', default: false, description: 'Run the 11-question Chinese detail report instead of a single question. Slow: 11 sequential model calls.' },
      model: { type: 'string', description: `Ollama model to use. Defaults to ${MAIN_MODEL}.` },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      return describe(args.image_path, args.question, args.detail === true, args.model, exec?.signal)
    },
  }),
  defineTool({
    name: 'comfyui_deconfuse_image',
    description: 'Undo 小番茄 (xiaofanqie) obfuscation, a reversible Gilbert-curve pixel permutation. Detection clue: neighbouring pixels stay strongly correlated but the picture looks like scattered fragments. mode=dec (default) restores an obfuscated image, mode=enc applies the obfuscation, and times repeats the pass (an image obfuscated N times needs N passes to come back). Reads PNG (8/16-bit, gray/RGB/palette/RGBA, not interlaced) and writes 8-bit RGB PNG. out_path defaults to <stem>_dec.png next to the input. preserve_meta copies the input PNG tEXt/iTXt/zTXt text chunks onto the output, so a prompt stored before obfuscation survives the round trip. Obfuscated images that were JPEG-compressed or rescaled may not restore exactly, because the curve positions shift.',
    timeoutMs: 10 * 60 * 1000,
    parameters: {
      image_path: { type: 'string', required: true, description: 'Path to the obfuscated (or original) PNG image.' },
      times: { type: 'integer', default: 1, description: 'How many passes to apply. Use the same count that was used to obfuscate.' },
      out_path: { type: 'string', description: 'Output file path. Defaults to <stem>_dec.png (or _enc.png) next to the input.' },
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
