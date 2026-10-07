/**
 * Civitai LoRA search engine — a faithful port of good-comfyui-mcp's
 * `lora_search.py`.
 *
 * The web search endpoint (`search-new.civitai.com/multi-search`, index
 * `models_v9`) indexes published models that the public API search misses, so
 * candidate discovery goes through it and the API is only used for model
 * details and the by-hash reverse lookup. Every network call takes an optional
 * `{signal, deps}` so tests can stub `fetch` and the endpoints.
 */
import { createHash } from 'node:crypto'
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { CIVITAI_HOST, CIVITAI_SEARCH_KEY, CIVITAI_SEARCH_URL, CIVITAI_TOKEN } from './env.js'
import { sleep } from './http.js'

/** Confirmed exact versions, kept verbatim from upstream to skip a re-search. */
export const KNOWN_EXACT = {
  'ushikani_kassen_lora-000013.safetensors': ['2760349', '3106457', 'zhihu'],
  'anima-darklight-style-v1-000194.safetensors': ['2765580', '3112882', 'O_oo_O'],
  'RealSkin SliderV2.safetensors': ['2682590', '3068784', 'JIngGGYIIII'],
  'surtr945_v1.safetensors': ['2692601', '3023314', 'umina'],
  'anima-base-1-photo-background-v4.safetensors': ['1252497', '2959007', 'motimalu'],
}

/** Files are read in 1 MiB chunks; the first chunk also holds the header. */
const CHUNK = 1 << 20
const HASH_BYTE_LIMIT = 100_000
const MODEL_FILE_TYPE = 'Model'
/** Per-request deadlines, mirroring upstream's httpx timeouts. */
const SEARCH_TIMEOUT_MS = 30_000
const DETAIL_TIMEOUT_MS = 30_000
const HASH_TIMEOUT_MS = 60_000
const DOWNLOAD_TIMEOUT_MS = 600_000

function engineDeps(deps = {}) {
  return {
    host: deps.host ?? CIVITAI_HOST,
    searchUrl: deps.searchUrl ?? CIVITAI_SEARCH_URL,
    token: deps.token ?? CIVITAI_TOKEN,
    searchKey: deps.searchKey ?? CIVITAI_SEARCH_KEY,
    fetchImpl: deps.fetchImpl ?? fetch,
    sleepMs: deps.sleepMs ?? 0,
  }
}

/**
 * Fuse the caller's signal with a per-request deadline.
 *
 * A deadline is not optional here: without one a stalled Civitai response makes
 * the tool — and with it the agent turn — wait forever.
 */
function deadline(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/** Uppercase hex SHA256 of a file, streamed in 1 MiB chunks. */
export function sha256File(path) {
  const hash = createHash('sha256')
  const fd = openSync(path, 'r')
  try {
    const chunk = Buffer.allocUnsafe(CHUNK)
    for (;;) {
      const read = readSync(fd, chunk, 0, CHUNK, null)
      if (read === 0) break
      hash.update(chunk.subarray(0, read))
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex').toUpperCase()
}

function bearer(token) {
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function apiPath(host, path) {
  return `${host}${path}`
}

async function readJson(response) {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Upstream `norm`: drop the extension and a leading `@`, keep [a-z0-9] only. */
export function norm(value) {
  const stripped = String(value ?? '')
    .replace(/\.safetensors$/, '')
    .replace(/^@/, '')
    .toLowerCase()
  let kept = ''
  for (const char of stripped) {
    const code = char.charCodeAt(0)
    if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) kept += char
  }
  return kept
}

/** Upstream `exact_name`: drop the extension and `@`, keep case and separators. */
export function exactName(value) {
  return String(value ?? '')
    .replace(/\.safetensors$/, '')
    .replace(/^@/, '')
}

/** Multi-keyword variants for one filename, in upstream insertion order. */
export function genQueries(filename) {
  const core = String(filename ?? '').replace(/\.safetensors$/, '')
  const queries = new Set()
  queries.add(core)
  queries.add(core.replace(/-(?:step)?\d+$/, ''))
  queries.add(core.replace(/[_-]+/g, ' ').trim())
  if (core.startsWith('@')) {
    const trigger = core.split('_')[0]
    queries.add(trigger)
    queries.add(trigger.replace(/^@/, ''))
  }
  const match = /^(?:anima[-_ ]?base[-_ ]?1[-_ ]?)?(.*)$/is.exec(core)
  if (match[1] !== core) {
    queries.add(match[1])
    queries.add(match[1].replace(/[_-]+/g, ' ').trim())
  }
  queries.add(core.replace(/[_ ]?v\d[\d.]*$/i, ''))
  return [...queries].filter((query) => query !== '')
}

/** Prepared trigger-word descriptor for one filename (upstream inline logic). */
function triggerInfo(filename) {
  const bare = exactName(filename).toLowerCase()
  return {
    bare,
    norm: norm(bare),
    isAnima: bare.includes('anima'),
    coreNorm: norm(exactName(filename)),
  }
}

/** A trained word counts as a trigger on equality, or on prefix when long enough. */
function trainedWordHits(trainedWords, info) {
  for (const word of trainedWords) {
    if (word === undefined || word === null) continue
    const text = String(word).toLowerCase().trim().replace(/^[ ,]+/, '').replace(/[ ,]+$/, '').replace(/^@+/, '')
    const textNorm = norm(text)
    if (text === info.bare || textNorm === info.norm) return true
    if (info.norm.length >= 5 && (info.norm.startsWith(textNorm) || textNorm.startsWith(info.norm))) return true
  }
  return false
}

/** Upstream candidate ordering: files present, filename match, base preference. */
function matchScore(entry, details, info, baseModel) {
  const { version } = entry
  const detail = details[entry.modelId] ?? {}
  const files = []
  for (const candidate of detail.modelVersions ?? []) {
    for (const file of candidate.files ?? []) if (file.type === MODEL_FILE_TYPE) files.push(file)
  }
  let score = files.length > 0 ? 2 : 0
  for (const file of files) {
    const name = norm(file.name ?? '')
    if (name && (name === info.coreNorm || info.coreNorm.endsWith(name) || name.endsWith(info.coreNorm))) score += 4
  }
  const base = String(version.baseModel ?? '')
  if (baseModel && base.toLowerCase().includes('anima')) score += 5
  else if (info.isAnima && base.toLowerCase().includes('anima')) score += 1
  if (baseModel && !base.toLowerCase().includes(String(baseModel).toLowerCase())) score -= 3
  return score
}

/**
 * POST one query to the web search endpoint.
 * Retries 3 times with a 3s pause and returns [] when every attempt fails.
 */
export async function searchModels(query, { limit = 50, deps, signal } = {}) {
  const { searchUrl, searchKey, fetchImpl, sleepMs } = engineDeps(deps)
  const body = JSON.stringify({ queries: [{ q: query, indexUid: 'models_v9', limit, offset: 0 }] })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    signal?.throwIfAborted()
    let hits
    try {
      const response = await fetchImpl(searchUrl, {
        method: 'POST',
        headers: { ...bearer(searchKey), 'Content-Type': 'application/json' },
        body,
        signal: deadline(signal, SEARCH_TIMEOUT_MS),
      })
      const data = await readJson(response)
      hits = data?.results?.[0]?.hits ?? []
    } catch (error) {
      signal?.throwIfAborted()
      if (attempt === 2) return []
      await sleep(3000 + sleepMs, signal)
      continue
    }
    return hits.filter((hit) => hit?.type === 'LORA')
  }
  return []
}

/** GET a model detail from the public API; undefined on an error payload. */
export async function modelDetail(modelId, { deps, signal } = {}) {
  const { host, token, fetchImpl, sleepMs } = engineDeps(deps)
  for (let attempt = 0; attempt < 5; attempt += 1) {
    signal?.throwIfAborted()
    let data
    try {
      const response = await fetchImpl(apiPath(host, `/api/v1/models/${modelId}`), {
        headers: bearer(token),
        signal: deadline(signal, DETAIL_TIMEOUT_MS),
      })
      data = await readJson(response)
      // A non-JSON body (an HTML 502 page, a proxy error) is as retriable as a
      // thrown request, which is what upstream's api_get did.
      if (data === undefined) throw new Error(`model ${modelId} returned a non-JSON body`)
    } catch (error) {
      signal?.throwIfAborted()
      if (attempt === 4) return undefined
      await sleep(3000 + sleepMs, signal)
      continue
    }
    if (isRecord(data) && data.error) {
      if (String(data.error).includes('overload')) {
        if (attempt === 4) return undefined
        await sleep(5000 * (attempt + 1) + sleepMs, signal)
        continue
      }
      return undefined
    }
    return data
  }
  return undefined
}

/**
 * Reverse-lookup a local file by SHA256.
 * by-hash is public; an empty `Authorization` breaks the protocol, so the
 * header is only sent when a token is configured.
 */
export async function lookupByHash(localPath, { deps, signal } = {}) {
  const { host, token, fetchImpl } = engineDeps(deps)
  const sha256 = sha256File(localPath)
  const url = apiPath(host, `/api/v1/model-versions/by-hash/${sha256}`)
  try {
    signal?.throwIfAborted()
    const response = await fetchImpl(url, { headers: bearer(token), signal: deadline(signal, HASH_TIMEOUT_MS) })
    if (response.status !== 200) return { sha256, hit: false }
    const data = await readJson(response)
    if (!isRecord(data)) return { sha256, hit: false }
    const files = (data.files ?? []).filter((file) => file?.type === MODEL_FILE_TYPE).map((file) => file.name)
    return {
      sha256,
      hit: true,
      model_id: data.modelId,
      version_id: data.id,
      base_model: data.baseModel,
      status: data.status,
      model_name: data.model?.name,
      files,
    }
  } catch (error) {
    signal?.throwIfAborted()
    return { sha256, hit: false }
  }
}

/**
 * Resolve a filename to an exact Civitai version.
 * Precedence: KNOWN table → exact filename → trainedWords trigger (with the
 * short-word guard) → base_model preference → file presence. The returned dict
 * is the upstream shape and is what `comfyui_search_lora` hands to the model.
 */
export async function findExactData(filename, { fresh = false, baseModel, deps, signal } = {}) {
  const { fetchImpl } = engineDeps(deps)
  const network = { deps: { ...deps, fetchImpl }, signal }
  const saved = { ...KNOWN_EXACT }
  if (fresh) for (const key of Object.keys(KNOWN_EXACT)) delete KNOWN_EXACT[key]
  const result = {
    exact: false,
    kind: null,
    model_id: null,
    version_id: null,
    author: null,
    base: null,
    trained_words: null,
    candidates: [],
  }
  try {
    if (KNOWN_EXACT[filename]) {
      const [modelId, versionId, author] = KNOWN_EXACT[filename]
      return { ...result, exact: true, kind: 'KNOWN', model_id: modelId, version_id: versionId, author }
    }
    const seen = new Map()
    for (const query of genQueries(filename)) {
      for (const hit of await searchModels(query, network)) seen.set(String(hit.id), hit)
    }
    const details = {}
    for (const modelId of [...seen.keys()].slice(0, 20)) {
      const detail = await modelDetail(modelId, network)
      if (detail) details[modelId] = detail
    }
    const target = exactName(filename)
    for (const [modelId, detail] of Object.entries(details)) {
      for (const version of detail.modelVersions ?? []) {
        for (const file of version.files ?? []) {
          if (file.type === MODEL_FILE_TYPE && exactName(file.name) === target) {
            return {
              ...result,
              exact: true,
              kind: 'EXACT',
              model_id: modelId,
              version_id: String(version.id),
              author: detail.creator?.username ?? '?',
              base: version.baseModel,
              trained_words: version.trainedWords ?? null,
            }
          }
        }
      }
    }
    const info = triggerInfo(filename)
    const matches = []
    for (const [modelId, hit] of seen) {
      for (const version of hit.versions ?? []) {
        if (!trainedWordHits(version.trainedWords ?? [], info)) continue
        if (baseModel) {
          const base = String(version.baseModel ?? '').toLowerCase()
          if (!base.includes(String(baseModel).toLowerCase())) continue
        }
        matches.push({ modelId, version, hit })
      }
    }
    if (matches.length > 0) {
      matches.sort((left, right) => matchScore(right, details, info, baseModel) - matchScore(left, details, info, baseModel))
      const best = matches[0]
      return {
        ...result,
        exact: true,
        kind: 'EXACT-TRIGGER',
        model_id: best.modelId,
        version_id: String(best.version.id),
        author: best.hit.user?.username ?? '?',
        base: best.version.baseModel,
        trained_words: best.version.trainedWords,
      }
    }
    for (const [modelId, hit] of [...seen.entries()].slice(0, 10)) {
      for (const version of (hit.versions ?? []).slice(0, 2)) {
        result.candidates.push({
          model_id: modelId,
          name: hit.name,
          author: hit.user?.username ?? '?',
          base: version.baseModel,
          version_id: String(version.id),
          trained_words: version.trainedWords,
        })
      }
    }
    return result
  } catch (error) {
    signal?.throwIfAborted()
    return result
  } finally {
    for (const key of Object.keys(KNOWN_EXACT)) delete KNOWN_EXACT[key]
    Object.assign(KNOWN_EXACT, saved)
  }
}

/**
 * GET a model version download. The caller owns writing the body; redirects are
 * followed by `fetch` itself. Rejects on a non-200 status or a body under
 * 100 KB (an HTML error page), and on a stalled transfer.
 */
export async function downloadVersion(versionId, { deps, signal, timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
  const { host, token, fetchImpl } = engineDeps(deps)
  const query = new URLSearchParams({ token: token ?? '' })
  const response = await fetchImpl(apiPath(host, `/api/download/models/${versionId}?${query}`), { signal: deadline(signal, timeoutMs) })
  if (response.status !== 200) throw new Error(`download failed http=${response.status}`)
  const body = Buffer.from(await response.arrayBuffer())
  if (body.length < HASH_BYTE_LIMIT) throw new Error(`download failed http=${response.status} size=${body.length}`)
  return { bytes: body, contentType: response.headers.get('content-type') }
}

/**
 * Parse the 8-byte little-endian length plus JSON header of a safetensors file.
 * A path reads only the head of the file; a buffer is parsed in place.
 */
export function safetensorsHeader(source) {
  let head = source
  let total = source?.length ?? 0
  if (typeof source === 'string') {
    const fd = openSync(source, 'r')
    try {
      total = statSync(source).size
      head = Buffer.allocUnsafe(Math.min(total, CHUNK))
      const read = readSync(fd, head, 0, head.length, 0)
      head = head.subarray(0, read)
    } finally {
      closeSync(fd)
    }
  }
  try {
    if (!head || head.length < 8) throw new Error('short header')
    const headerBytes = Number(head.readBigUInt64LE(0))
    if (headerBytes <= 0 || 8 + headerBytes > head.length) throw new Error('truncated header')
    const header = JSON.parse(head.subarray(8, 8 + headerBytes).toString('utf8'))
    if (!isRecord(header)) throw new Error('header is not an object')
    const metadata = header.__metadata__
    const metadataKeys = isRecord(metadata) && Object.keys(metadata).length > 0 ? Object.keys(metadata).length : Object.keys(header).length
    return { ok: headerBytes > 0 && headerBytes < total, keys: metadataKeys, headerBytes }
  } catch {
    return { ok: false, keys: 0, headerBytes: 0 }
  }
}
