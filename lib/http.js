/**
 * HTTP helpers over the platform `fetch`.
 *
 * Every outbound call in this plugin goes through here: timeouts are ours,
 * non-2xx responses are errors carrying the status and a body excerpt, and
 * `tryJson` is the variant for reachability probes that must not throw.
 */

/** An HTTP response that was received but not ok. */
export class HttpError extends Error {
  constructor(url, status, body) {
    super(`HTTP ${status} from ${url}${body ? ': ' + body.slice(0, 300) : ''}`)
    this.name = 'HttpError'
    this.status = status
    this.body = body
  }
}

function withTimeout(signal, timeoutMs) {
  if (!timeoutMs) return signal
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

function url(base, path, query) {
  let target = base + path
  if (query) {
    const parts = []
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    }
    if (parts.length > 0) target += (target.includes('?') ? '&' : '?') + parts.join('&')
  }
  return target
}

async function request(base, path, options) {
  const target = url(base, path, options.query)
  const init = { method: options.method ?? 'GET', signal: withTimeout(options.signal, options.timeoutMs) }
  if (options.headers) init.headers = options.headers
  if (options.body !== undefined) {
    init.headers = { 'Content-Type': 'application/json', ...(options.headers ?? {}) }
    init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
  }
  const response = await fetch(target, init)
  if (options.raw) {
    if (!response.ok) throw new HttpError(target, response.status, await response.text())
    return response
  }
  const text = await response.text()
  if (!response.ok) throw new HttpError(target, response.status, text)
  if (!options.text) {
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`invalid JSON from ${target}: ${text.slice(0, 200)}`)
    }
  }
  return text
}

export function getJson(base, path, options = {}) {
  return request(base, path, { ...options, method: 'GET' })
}

export function getText(base, path, options = {}) {
  return request(base, path, { ...options, method: 'GET', text: true })
}

export function getRaw(base, path, options = {}) {
  return request(base, path, { ...options, method: 'GET', raw: true })
}

export function goRaw(base, path, options = {}) {
  return request(base, path, { ...options, raw: true })
}

export function postJson(base, path, body, options = {}) {
  return request(base, path, { ...options, method: 'POST', body })
}

/** A GET that returns undefined instead of throwing when the peer is unreachable. */
export async function tryJson(base, path, options = {}) {
  try {
    return await getJson(base, path, options)
  } catch (error) {
    if (error instanceof HttpError) throw error
    return undefined
  }
}

export async function tryRaw(base, path, options = {}) {
  try {
    return await getRaw(base, path, options)
  } catch (error) {
    if (error instanceof HttpError) throw error
    return undefined
  }
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
