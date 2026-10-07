/**
 * Upstream repro samples.
 *
 * `good-comfyui-mcp` ships two example configs plus their reference images and a
 * MAE comparison. This plugin keeps the samples but drops the scoring: it
 * regenerates each sample with the upstream metadata verbatim and lays the result
 * beside the upstream original so the user can judge the match by eye.
 *
 * The reference images are ~5MB each and are **not** shipped in the package; they
 * are fetched from the upstream repo at the pinned commit only when the caller
 * passes `allow_download`, then verified against the manifest's sha256 so a
 * changed upstream file cannot slip in silently.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { PLUGIN_DIR, STATE_DIR, ensureDir, readJsonFile } from './env.js'

/** Samples shipped with this package. */
export const SAMPLES_FILE = join(PLUGIN_DIR, 'repro', 'samples.json')

/** Where the fetched upstream references live, keyed by file name. */
export const REFERENCE_DIR = join(STATE_DIR, 'repro')

/** Manifest of the upstream samples. */
export function loadSamples() {
  const manifest = readJsonFile(SAMPLES_FILE)
  if (!manifest?.samples?.length) throw new Error(`no repro samples in ${SAMPLES_FILE}`)
  return manifest
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** A verified local copy of one sample's upstream reference image. */
export function referencePath(sample) {
  return join(REFERENCE_DIR, basename(sample.reference.url))
}

/**
 * Return the local reference image, fetching it from upstream when allowed.
 *
 * A cached file is trusted only when its bytes match the manifest hash; a
 * mismatch replaces it. Without `allowDownload` a missing or stale file is
 * reported rather than fetched, because these are multi-megabyte downloads the
 * user has to authorize.
 */
export async function ensureReference(sample, { allowDownload = false, signal } = {}) {
  const path = referencePath(sample)
  if (existsSync(path)) {
    const bytes = readFileSync(path)
    if (sha256(bytes) === sample.reference.sha256) return path
    if (!allowDownload) {
      throw new Error(`本地参考图与清单不一致：${path}（重新下载需 allow_download=true）`)
    }
  } else if (!allowDownload) {
    throw new Error(`缺少上游参考图 ${basename(path)}（约 ${Math.round(sample.reference.bytes / 1024 / 1024)}MB，需要你同意下载：allow_download=true）`)
  }
  const response = await fetch(sample.reference.url, { signal })
  if (!response.ok) throw new Error(`下载参考图失败 (${response.status}): ${sample.reference.url}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const digest = sha256(bytes)
  if (digest !== sample.reference.sha256) {
    throw new Error(`参考图 sha256 不匹配：期望 ${sample.reference.sha256}，实际 ${digest}（上游文件已变化？）`)
  }
  ensureDir(REFERENCE_DIR)
  writeFileSync(path, bytes)
  return path
}
