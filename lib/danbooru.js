/**
 * Danbooru character lookup driven through a local camofox-browser.
 *
 * Every Danbooru request is issued from inside the browser page (danbooru
 * refuses plain scripted clients), so the flow is always: make sure camofox is
 * up, open a tab, navigate, evaluate a fetch expression, close the tab.
 * Lookups are cached per character for 30 days.
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { CAMOFOX_URL, CACHE_DIR, CACHE_TTL_DAYS, readJsonFile, writeJsonFile } from './env.js'
import { getJson, postJson, sleep } from './http.js'

/** camofox identity: every request carries it, and the session key gets a random suffix. */
export const DANBOORU_CAMOFOX_USER = 'dsh_comfyui_control'
export const DANBOORU_CAMOFOX_SESSION = 'main'

/** Tag category 4 is danbooru's "character" category. */
const CHARACTER_CATEGORY = 4
/** Candidates handed back to the model for a human-readable disambiguation. */
const MAX_CANDIDATES = 8
/** Danbooru pages are long; only the head of each page is parsed. */
const WIKI_TEXT_LIMIT = 6000
/** Appearance ranking: tags co-occurring in at least this share of the sample. */
const APPEARANCE_THRESHOLD = 0.3
/** Tags never useful as appearance description (the upstream skip set). */
const APPEARANCE_SKIP = new Set([
  'solo', '1girl', '1boy', 'genshin_impact', 'absurdres', 'highres', 'commentary',
  'commentary_request', 'translated', 'multiple_girls', 'multi_girl',
])
const POSTS_PER_PAGE = 500

/** Host of a URL, used to tell "page is elsewhere" from "page is still loading". */
function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/**
 * The camofox HTTP surface used by every lookup, in one place so tests can
 * drive the cache and retry paths without a browser. Lookups read these
 * properties per call, so a test may replace individual entries.
 */
export const camofox = {
  healthy: (...args) => camofoxHealthy(...args),
  ensure: (...args) => ensureCamofox(...args),
  tab: (...args) => camofoxTab(...args),
  close: (...args) => camofoxClose(...args),
  navigate: (...args) => camofoxNavigate(...args),
  evaluate: (...args) => camofoxEval(...args),
}

// ---------------------------------------------------------------- camofox lifecycle

/** True when camofox-browser answers its health probe with `{ok: true}`. */
export async function camofoxHealthy() {
  try {
    return (await getJson(CAMOFOX_URL, '/health', { timeoutMs: 5000 })).ok === true
  } catch {
    return false
  }
}

/** The `camofox-browser` shim and its JS entry as installed on this machine. */
function camofoxEntry() {
  const pathExt = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  for (const dir of (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':')) {
    if (!dir) continue
    for (const ext of pathExt) {
      const shim = join(dir, `camofox-browser${ext}`)
      if (!existsSync(shim)) continue
      const entry = join(dir, 'node_modules', '@askjo', 'camofox-browser', 'bin', 'camofox-browser.js')
      if (existsSync(entry)) return entry
    }
  }
  throw new Error('camofox-browser not found in PATH; install it or start it manually')
}

/**
 * Start camofox-browser detached. Its stdio is dropped on purpose: the browser
 * daemon keeps running after this call, and nothing it prints may reach the
 * agent's own output stream.
 */
export function launchCamofox() {
  const entry = camofoxEntry()
  const child = spawn(process.execPath, [entry], {
    cwd: join(entry, '..', '..', '..', '..', '..'),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
}

export async function ensureCamofox({ timeoutMs = 60000, signal } = {}) {
  if (await camofoxHealthy()) return 'online'
  launchCamofox()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(2000, signal)
    if (await camofoxHealthy()) return 'launched'
  }
  throw new Error(`camofox-browser did not become healthy within ${Math.round(timeoutMs / 1000)}s`)
}

// ---------------------------------------------------------------- camofox

/**
 * Open a tab for one lookup. The session key is unique so concurrent lookups
 * cannot share page state; callers must close the tab with `camofoxClose`.
 */
export async function camofoxTab() {
  const sessionKey = `${DANBOORU_CAMOFOX_USER}-${randomUUID().replace(/-/g, '').slice(0, 8)}`
  const tab = await postJson(CAMOFOX_URL, '/tabs', { userId: DANBOORU_CAMOFOX_USER, sessionKey }, { timeoutMs: 30000 })
  return tab.tabId
}

export async function camofoxClose(tabId) {
  try {
    // A stalled browser must not hang the lookup's finally block.
    await fetch(`${CAMOFOX_URL}/tabs/${tabId}?userId=${encodeURIComponent(DANBOORU_CAMOFOX_USER)}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(15000),
    })
  } catch {
    // a tab that is already gone must not mask the lookup result
  }
}

/** Wait until the tab's document matches `url` and has finished loading. */
async function camofoxReady(tabId, url) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    try {
      const ready = await camofox.evaluate(tabId, 'document.readyState')
      const href = String(await camofox.evaluate(tabId, 'location.href'))
      if (ready === 'complete' && (hostOf(href) === hostOf(url) || href === '')) return
    } catch {
      // the tab is mid-navigation; keep polling
    }
    await sleep(500)
  }
}

export async function camofoxNavigate(tabId, url) {
  await postJson(CAMOFOX_URL, `/tabs/${tabId}/navigate`, { userId: DANBOORU_CAMOFOX_USER, url }, { timeoutMs: 60000 })
  await camofoxReady(tabId, url)
}

export async function camofoxEval(tabId, expression) {
  const data = await postJson(CAMOFOX_URL, `/tabs/${tabId}/evaluate`, { userId: DANBOORU_CAMOFOX_USER, expression }, { timeoutMs: 60000 })
  if (data && 'result' in data) return data.result
  throw new Error(`camofox evaluate failed: ${JSON.stringify(data)}`)
}

// ---------------------------------------------------------------- danbooru lookup

/**
 * Parse a camofox evaluate result that the page produced with JSON.stringify.
 *
 * A payload that is not valid JSON means the page side failed, so it must raise
 * a distinct error: silently returning a fallback would report it as "no tags
 * found for this character" and send the caller looking for a typo.
 */
function parsePageJson(raw, what) {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`camofox ${what} returned malformed JSON: ${raw.slice(0, 200)}`)
  }
}

/** Tag autocomplete for a free-text query. */
export async function danbooruAutocomplete(tabId, query) {
  const expression = "fetch('https://danbooru.donmai.us/autocomplete.json?search%5Bquery%5D=" +
    encodeURIComponent(query) + "&search%5Btype%5D=tag')" +
    '.then(r=>r.json()).then(d=>JSON.stringify(d))'
  const raw = await camofox.evaluate(tabId, expression)
  const parsed = parsePageJson(raw, 'tag autocomplete')
  if (!Array.isArray(parsed)) throw new Error(`Danbooru autocomplete returned ${typeof parsed} for '${query}'`)
  return parsed
}

/** Open the wiki page for a canonical tag and read its two text bodies. */
export async function danbooruWiki(tabId, canonical) {
  await camofox.navigate(tabId, `https://danbooru.donmai.us/wiki_pages/${canonical}`)
  const expression = '(() => {' +
    "  const body = document.querySelector('#wiki-page-body');" +
    "  const content = document.querySelector('#content');" +
    '  return JSON.stringify({' +
    `    body: body ? body.innerText.slice(0, ${WIKI_TEXT_LIMIT}) : '',` +
    `    content: content ? content.innerText.slice(0, ${WIKI_TEXT_LIMIT}) : ''` +
    '  });' +
    '})()'
  const parsed = parsePageJson(await camofox.evaluate(tabId, expression), 'wiki page')
  return { body: parsed?.body ?? '', content: parsed?.content ?? '' }
}

/** Parse a wiki page into the fields a prompt cares about. */
export function parseWiki(wiki, canonical) {
  let description = String(wiki?.body ?? '').replace(/\n+/g, '\n').trim()
  for (const marker of ['Posts\nTerms', 'See also', 'External links']) {
    if (description.includes(marker)) description = description.split(marker)[0].trim()
  }
  const content = String(wiki?.content ?? '')
  const aliases = [...content.matchAll(/aliased to this tag:\s*([a-z0-9_]+)/g)].map((match) => match[1])
  const implicates = [...content.matchAll(/implicate this tag:\s*([a-z0-9_()]+)/g)].map((match) => match[1])
  // localized names: the lines directly under the title line, up to a blank line or "Default"
  const localizedNames = []
  const lines = content.split(/\r?\n/)
  const title = canonical.replace(/_/g, ' ')
  const titleIndex = lines.findIndex((line) => line.trim() === title)
  if (titleIndex >= 0) {
    for (const line of lines.slice(titleIndex + 1)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed === 'Default') break
      localizedNames.push(trimmed)
    }
  }
  return { description, aliases, implicates, localized_names: localizedNames }
}

/**
 * Cache filename slug. CJK is kept so Chinese and Japanese character names do
 * not collapse into one shared empty slug; pure-symbol input falls back to a
 * stable hash of the original name.
 */
export function cacheSlug(name) {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '_').replace(/^_+|_+$/g, '')
  return slug || createHash('sha1').update(String(name), 'utf8').digest('hex').slice(0, 12)
}

function characterCacheFile(character) {
  return join(CACHE_DIR, `${cacheSlug(character)}.json`)
}

/**
 * Look up one character on Danbooru, through a fresh camofox tab. Returns the
 * upstream result shape: canonical tag, label, post count, candidate tags,
 * wiki fields and the wiki URL.
 */
export async function lookupCharacter(character, forceRefresh = false) {
  const cacheFile = characterCacheFile(character)
  if (!forceRefresh && existsSync(cacheFile)) {
    if (Date.now() - statSync(cacheFile).mtimeMs < CACHE_TTL_DAYS * 86400000) {
      const cached = readJsonFile(cacheFile)
      // consistency check: the cached entry must be for this character
      if (String(cached?.query ?? '').toLowerCase() === character.toLowerCase()) return cached
    }
  }

  await camofox.ensure()
  const tabId = await camofox.tab()
  let result
  try {
    let candidates = await danbooruAutocomplete(tabId, character)
    // full name missed (typo / misremembered surname) -> retry with the first word
    let matchedQuery = character
    if ((!Array.isArray(candidates) || candidates.length === 0) && character.trim().includes(' ')) {
      const firstWord = character.trim().split(/\s+/)[0]
      candidates = await danbooruAutocomplete(tabId, firstWord)
      if (Array.isArray(candidates) && candidates.length > 0) matchedQuery = firstWord
    }
    const characters = candidates.filter((entry) => entry.category === CHARACTER_CATEGORY)
    const ranked = characters.length > 0 ? characters : candidates
    if (!Array.isArray(ranked) || ranked.length === 0) throw new Error(`Danbooru: no tags found for '${character}'`)
    const best = ranked[0]
    const canonical = best.value
    result = {
      query: character,
      matched_query: matchedQuery,
      canonical_tag: canonical,
      label: best.label ?? '',
      post_count: best.post_count ?? 0,
      category: best.category,
      candidates: ranked.slice(0, MAX_CANDIDATES).map((entry) => ({
        label: entry.label,
        value: entry.value,
        post_count: entry.post_count,
      })),
    }
    Object.assign(result, parseWiki(await danbooruWiki(tabId, canonical), canonical))
    result.wiki_url = `https://danbooru.donmai.us/wiki_pages/${canonical}`
  } finally {
    await camofox.close(tabId)
  }

  writeJsonFile(cacheFile, result)
  return result
}

// ---------------------------------------------------------------- cache readers

/**
 * Return the cached entry for a character, matching the canonical tag or the
 * original query so a Chinese query hits the cache written under an English one.
 */
export function findCachedCharacter(name) {
  const wanted = String(name).toLowerCase()
  if (!existsSync(CACHE_DIR)) return undefined
  for (const file of readdirSync(CACHE_DIR).sort()) {
    if (file.endsWith('.appearance.json') || file.startsWith('.') || !file.endsWith('.json')) continue
    const entry = readJsonFile(join(CACHE_DIR, file))
    if (!entry) continue
    if (String(entry.canonical_tag ?? '').toLowerCase() === wanted || String(entry.query ?? '').toLowerCase() === wanted) return entry
  }
  return undefined
}

/** Extract the danbooru-style character tag (e.g. `varesa_(genshin_impact)`) from a prompt. */
export function characterFromPrompt(prompt) {
  const match = /\b([a-z0-9_]+)\(([a-z0-9_ ]+)\)/.exec(String(prompt))
  return match ? match[0].trim() : undefined
}

// ---------------------------------------------------------------- appearance

async function danbooruPosts(tabId, tags, sample) {
  const pages = Math.max(1, Math.ceil(sample / POSTS_PER_PAGE))
  const posts = []
  for (let page = 1; page <= pages; page++) {
    const expression = "fetch('https://danbooru.donmai.us/posts.json?tags=" + encodeURIComponent(tags) +
      `&limit=${POSTS_PER_PAGE}&page=${page}')` +
      '.then(r=>r.json()).then(d=>JSON.stringify(d))'
    const chunk = parsePageJson(await camofox.evaluate(tabId, expression), 'post page')
    if (!Array.isArray(chunk) || chunk.length === 0) break
    posts.push(...chunk)
    if (chunk.length < POSTS_PER_PAGE) break
  }
  return posts.slice(0, sample)
}

/** Rank appearance tags in `posts` by how many of them carry each tag. */
export function rankAppearance(posts, canonical, sample) {
  const counts = new Map()
  for (const post of posts) {
    for (const tag of String(post.tag_string ?? '').split(/\s+/)) {
      if (!tag) continue
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }
  const skip = new Set([...APPEARANCE_SKIP, canonical])
  const ranked = [...counts.entries()].filter(([tag]) => !skip.has(tag)).sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count }))
  return {
    canonical_tag: canonical,
    sample_size: posts.length,
    appearance_tags: ranked.filter(({ count }) => count >= sample * APPEARANCE_THRESHOLD).map(({ tag }) => tag),
    top_tags: ranked.slice(0, 25),
  }
}

/**
 * Statistically derive a character's appearance tags from their most recent
 * solo posts on Danbooru. Cached for 30 days like the tag lookup.
 */
export async function lookupCharacterAppearance(character, sample = 50) {
  const info = await lookupCharacter(character)
  const canonical = info.canonical_tag
  const slug = String(canonical).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  const cacheFile = join(CACHE_DIR, `${slug}.appearance.json`)
  const size = Number.isFinite(sample) && sample > 0 ? Math.floor(sample) : 50
  if (existsSync(cacheFile) && Date.now() - statSync(cacheFile).mtimeMs < CACHE_TTL_DAYS * 86400000) {
    const cached = readJsonFile(cacheFile)
    if (cached?.canonical_tag === canonical) return cached
  }

  await camofox.ensure()
  const tabId = await camofox.tab()
  let posts
  try {
    posts = await danbooruPosts(tabId, `${canonical} solo`, size)
  } finally {
    await camofox.close(tabId)
  }
  if (!Array.isArray(posts) || posts.length === 0) throw new Error(`no solo posts found for ${canonical}`)
  const result = rankAppearance(posts, canonical, size)
  writeJsonFile(cacheFile, result)
  return result
}

// ---------------------------------------------------------------- cache listing

/** List the characters already looked up, from the cache only (no network). */
export function listCachedCharacters() {
  const out = []
  if (!existsSync(CACHE_DIR)) return out
  for (const file of readdirSync(CACHE_DIR).sort()) {
    if (file.endsWith('.appearance.json') || file.startsWith('.') || !file.endsWith('.json')) continue
    const entry = readJsonFile(join(CACHE_DIR, file))
    if (!entry?.query || !entry?.canonical_tag) continue
    out.push({ query: entry.query, canonical_tag: entry.canonical_tag, post_count: entry.post_count })
  }
  return out
}

// ---------------------------------------------------------------- setup guide

/**
 * The initialization checklist of this plugin, one entry per thing a fresh
 * install needs. `step`, `title`, `action`, `required` and `verify` are the
 * upstream fields; the actions name this plugin's tools.
 */
export const SETUP_STEPS = [
  { step: 1, title: '安装插件（无 Python 依赖）',
    action: '把 dsh-comfyUI-control 挂载到 DSH profile 的绘图模式预设（index.js/plugin.js 即生效），本插件是纯 ESM，不装任何 Python 包',
    required: true, verify: '绘图模式预设里能看到 comfyui_* 工具，且 comfyui_status 可调用' },
  { step: 2, title: '启动 ComfyUI',
    action: '启动本地 ComfyUI（默认 http://127.0.0.1:8188）',
    required: true, verify: 'comfyui_status 返回 comfyui=online' },
  { step: 3, title: '放置管线模型',
    action: '按 pipeline.json 引用放置：anima-base-v1.0（diffusion_models）、qwen_3_06b_base（text_encoders）、qwen_image_vae（vae）、RealESRGAN_x2plus（upscale_models）',
    required: true, verify: 'comfyui_status 返回 models_ok=true' },
  { step: 4, title: '放置默认 5 件套 LoRA',
    action: 'comfyui_generate 不传 lora_text 时会自动挂这 5 个，缺任何一个都会提交失败：ushikani_kassen_lora-000013 / anima-darklight-style-v1-000194 / anima-base-1-photo-background-v4 / RealSkin SliderV2 / surtr945_v1，全部放进 models/loras/。补齐方式：先配 CIVITAI_TOKEN，然后 comfyui_search_lora(filename=…) 查精确版 → comfyui_download_lora(version_id=…) 下载 → comfyui_lookup_lora_hash 核对来源；不想用默认套时显式传 lora_text="" 空载，或用自定义 <lora:名:权重>',
    required: true, verify: 'comfyui_status 返回 default_loras.missing=[]（models_ok 也会因此为 true）；comfyui_generate 能提交成功' },
  { step: 5, title: '确认管线模型就绪（无自定义节点依赖）',
    action: 'pipeline.json 只用 ComfyUI 内置节点（UNETLoader/CLIPLoader/VAELoader/LoraLoader/KSampler/RealESRGAN）',
    required: true, verify: 'comfyui_generate 能提交成功' },
  { step: 6, title: '8899 对比页服务器（必需）',
    action: '在插件目录启动对比页服务器：node tools/serve-compare.mjs（或 npm run serve-compare），默认 http://127.0.0.1:8899；它只读服务 <DSH_HOME>/storages/dsh-comfyui-control/compare/',
    required: true, verify: 'comfyui_status 返回 view_server=online；comfyui_generate 返回的 view_url 能在浏览器打开' },
  { step: 7, title: '启动 camofox-browser',
    action: 'npm install -g camofox-browser && camofox-browser（默认 127.0.0.1:9377）',
    required: true, verify: 'comfyui_status 返回 camofox=online；缺了角色 tag/外貌查询不可用' },
  { step: 8, title: '配置 Civitai（可选）',
    action: '设置 CIVITAI_TOKEN（下载）和 CIVITAI_SEARCH_KEY（搜索），获取方法见 README 5b',
    required: false, verify: 'comfyui_search_lora / comfyui_download_lora 可用；不配不影响生成/识图' },
  { step: 9, title: '视觉服务（默认关闭，可选）',
    action: 'comfyui_describe_image 默认不发请求：当前会话模型通常已支持图片，直接读图即可。需要第二个视觉服务时传 enable_vision=true（或在 DSH 进程设 DSH_COMFYUI_VISION=1），届时优先用宿主视觉模型（opencode-go 的 deepseek-v4.1-flash）；想走本地 Ollama 则显式传 model=qwen3-vl:8b 并先 ollama pull qwen3-vl:8b',
    required: false, verify: 'comfyui_describe_image 默认返回「视觉服务默认关闭」说明；传 enable_vision=true 后能返回描述' },
  { step: 10, title: '跑一遍真实出图验证',
    action: '用 comfyui_generate 出一张小图（如 512x512、steps 8）：提示词用默认 5 件套 LoRA，出图后用 comfyui_extract_image_info 回读 PNG 元数据；也可在源码目录跑 node tools/verify-live.mjs 一次性验证所有实时工具',
    required: true, verify: 'comfyui_generate 返回 status=completed 与 view_url；元数据里能看到 KSampler 参数与 5 个 LoraLoader' },
  { step: 11, title: '复刻自检（可选，需要你同意下载）',
    action: 'comfyui_repro_check 用上游两个样例的元数据原样出图（1216 宽 / 30 步 / CFG 4 / 5 件套 LoRA），把结果与上游原图并排展示给你自己目视对比，不做自动评分。上游参考原图约 5MB/张、不随包发布：首次要传 allow_download=true 下载并按 sha256 校验缓存；用 sample 参数可只跑一张',
    required: false, verify: '返回 view_url 能打开并排对比页；两张图的构图/光影/风格强度与上游原图接近，说明本地底模与 LoRA 版本与上游参考环境一致' },
]

export { APPEARANCE_SKIP, CHARACTER_CATEGORY, WIKI_TEXT_LIMIT }
