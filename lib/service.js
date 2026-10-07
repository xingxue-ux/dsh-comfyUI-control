/**
 * Live service clients for the three local servers the plugin drives:
 * ComfyUI, Ollama and camofox-browser.
 *
 * Each client is a thin wrapper over `lib/http.js`, so its methods return the
 * server's own JSON and never swallow an error the tool must report. Only
 * reachability probes are non-throwing.
 */
import { CAMOFOX_URL, COMFYUI_URL, OLLAMA_URL } from './env.js'
import { getJson, getRaw, postJson, sleep, tryJson } from './http.js'

/** The camofox-browser user id every tab is opened under. */
const CAMOFOX_USER = 'dsh_comfyui_control'

export const comfy = {
  /** Queue + device status; undefined when ComfyUI is unreachable. */
  systemStats(signal) {
    return tryJson(COMFYUI_URL, '/system_stats', { timeoutMs: 5000, signal })
  },

  objectInfo(classType, signal) {
    return getJson(COMFYUI_URL, `/object_info/${encodeURIComponent(classType)}`, { timeoutMs: 60000, signal })
  },

  /** One model folder's file names, or undefined when ComfyUI does not answer. */
  models(folder, signal) {
    return tryJson(COMFYUI_URL, `/models/${encodeURIComponent(folder)}`, { timeoutMs: 60000, signal })
  },

  queue(signal) {
    return getJson(COMFYUI_URL, '/queue', { timeoutMs: 30000, signal })
  },

  clearQueue(signal) {
    return postJson(COMFYUI_URL, '/queue', { clear: true }, { timeoutMs: 30000, signal })
  },

  history({ limit = 20, promptId } = {}, signal) {
    const path = promptId ? `/history/${encodeURIComponent(promptId)}` : '/history'
    return getJson(COMFYUI_URL, path, { query: promptId ? undefined : { max_items: limit }, timeoutMs: 30000, signal })
  },

  submit(graph, clientId, signal) {
    return postJson(COMFYUI_URL, '/prompt', { prompt: graph, client_id: clientId }, { timeoutMs: 60000, signal })
  },

  interrupt(signal) {
    return postJson(COMFYUI_URL, '/interrupt', {}, { timeoutMs: 30000, signal })
  },

  /** Delete one pending item or the whole queue. */
  deleteFromQueue(promptId, signal) {
    return postJson(COMFYUI_URL, '/queue', { delete: promptId ? [promptId] : undefined, clear: promptId ? undefined : true }, { timeoutMs: 30000, signal })
  },

  /** Raw image bytes for one `/view` reference. */
  async view({ filename, subfolder = '', type = 'output' }, signal) {
    return getRaw(COMFYUI_URL, '/view', { query: { filename, subfolder, type }, timeoutMs: 120000, signal })
  },
}

export const ollama = {
  /** Installed model tags; undefined when Ollama is unreachable. */
  async tags(signal) {
    const body = await tryJson(OLLAMA_URL, '/api/tags', { timeoutMs: 5000, signal })
    return body?.models?.map((model) => model.name) ?? (body ? [] : undefined)
  },

  /** One non-streaming chat turn; `images` are base64 strings. */
  async chat({ model, prompt, images = [], numCtx = 8192, numGpu = 99, timeoutMs = 900000 }, signal) {
    const body = await postJson(OLLAMA_URL, '/api/chat', {
      model,
      messages: [{ role: 'user', content: prompt, images }],
      stream: false,
      options: { num_gpu: numGpu, num_ctx: numCtx },
    }, { timeoutMs, signal })
    return body?.message?.content || body?.error || ''
  },
}

export const camofox = {
  async health(signal) {
    const body = await tryJson(CAMOFOX_URL, '/health', { timeoutMs: 5000, signal })
    return body?.ok === true
  },

  async openTab(sessionKey, signal) {
    const body = await postJson(CAMOFOX_URL, '/tabs', { userId: CAMOFOX_USER, sessionKey }, { timeoutMs: 30000, signal })
    return body.tabId
  },

  async closeTab(tabId, signal) {
    try {
      const response = await fetch(`${CAMOFOX_URL}/tabs/${encodeURIComponent(tabId)}?userId=${CAMOFOX_USER}`, {
        method: 'DELETE',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      })
      await response.text()
    } catch {
      // Closing a tab is best-effort: a dead browser must not fail the tool.
    }
  },

  async navigate(tabId, url, signal) {
    await postJson(CAMOFOX_URL, `/tabs/${encodeURIComponent(tabId)}/navigate`, { userId: CAMOFOX_USER, url }, { timeoutMs: 60000, signal })
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      try {
        if ((await this.evaluate(tabId, 'document.readyState', signal)) === 'complete') return
      } catch {
        // The page may not be attached yet; keep polling until the deadline.
      }
      await sleep(500, signal)
    }
  },

  async evaluate(tabId, expression, signal) {
    const body = await postJson(CAMOFOX_URL, `/tabs/${encodeURIComponent(tabId)}/evaluate`, { userId: CAMOFOX_USER, expression }, { timeoutMs: 60000, signal })
    if ('result' in body) return body.result
    throw new Error(`camofox evaluate failed: ${JSON.stringify(body).slice(0, 300)}`)
  },
}

export { CAMOFOX_URL, COMFYUI_URL, OLLAMA_URL }

/**
 * Open a dedicated camofox tab, run one job in it, and always close it.
 *
 * A unique session key per call keeps concurrent lookups from sharing state,
 * which is what the upstream server does per lookup.
 */
export async function withCamofoxTab(job) {
  const sessionKey = `${CAMOFOX_USER}-${Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')}`
  const tabId = await camofox.openTab(sessionKey)
  try {
    return await job(tabId)
  } finally {
    await camofox.closeTab(tabId)
  }
}
