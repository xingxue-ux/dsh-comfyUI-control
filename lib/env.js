/**
 * Environment and path resolution for the plugin.
 *
 * Everything the tools touch on disk (the pipeline, the ComfyUI models tree,
 * the character cache, the compare/ viewer directory) is resolved once per
 * process from the environment, so the plugin works both from its own checkout
 * and from a copy installed next to a 绘图模式 preset.
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This package's root directory. */
export const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

/** The .dsh home that owns profiles and agent presets. */
export const DSH_HOME = process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh')

function envPath(name) {
  const value = process.env[name]
  if (!value || value.trim() === '') return undefined
  return resolve(value)
}

/**
 * The ComfyUI installation the plugin drives: models/, output/ and the
 * workflow referenced by `comfyui_pipeline` live under it. `COMFYUI_ROOT` (or
 * the good-comfyui-mcp spelling `MODELS_ROOT`) wins; otherwise the checkout
 * that contains the plugin is probed, which is the layout of an in-tree
 * install.
 */
export const COMFYUI_ROOT = (() => {
  const declared = envPath('COMFYUI_ROOT') ?? envPath('MODELS_ROOT')
  const candidate = declared ?? resolve(PLUGIN_DIR, '..')
  return existsSync(join(candidate, 'models')) ? candidate : declared ?? candidate
})()

/** Default workflow for the Anima pipeline. */
export const DEFAULT_PIPELINE = (() => {
  const declared = envPath('PIPELINE')
  if (declared) return declared
  const shipped = join(PLUGIN_DIR, 'pipeline.json')
  return existsSync(shipped) ? shipped : join(COMFYUI_ROOT, 'pipeline.json')
})()

export const COMFYUI_URL = (process.env.COMFYUI_URL || 'http://127.0.0.1:8188').replace(/\/+$/, '')
export const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '')
export const CAMOFOX_URL = (process.env.CAMOFOX_URL || 'http://127.0.0.1:9377').replace(/\/+$/, '')
export const VIEW_BASE = (process.env.COMFYUI_VIEW_BASE || 'http://127.0.0.1:8899').replace(/\/+$/, '')
export const CIVITAI_HOST = (process.env.CIVITAI_HOST || 'https://civitai.red').replace(/\/+$/, '')
export const CIVITAI_SEARCH_URL = process.env.CIVITAI_SEARCH_URL || 'https://search-new.civitai.com/multi-search'
export const CIVITAI_TOKEN = process.env.CIVITAI_TOKEN || ''
export const CIVITAI_SEARCH_KEY = process.env.CIVITAI_SEARCH_KEY || ''

/** Where the plugin keeps the character cache and the compare/ viewer files. */
export const STATE_DIR = envPath('DSH_COMFYUI_STATE') ?? join(DSH_HOME, 'storages', 'dsh-comfyui-control')
export const CACHE_DIR = join(STATE_DIR, 'cache')
export const COMPARE_DIR = join(STATE_DIR, 'compare')

/** Character lookups are cached for this long. */
export const CACHE_TTL_DAYS = 30
/** Marker written into every submitted graph so its history entry is attributable. */
export const MCP_MARK = 'dsh_comfyui_control'

export function modelsDir() {
  return join(COMFYUI_ROOT, 'models')
}

export function outputDir() {
  return process.env.COMFYUI_OUTPUT ? resolve(process.env.COMFYUI_OUTPUT) : join(COMFYUI_ROOT, 'output')
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Read and parse a JSON file, returning undefined when it is absent or malformed. */
export function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

export function writeJsonFile(path, value) {
  ensureDir(dirname(path))
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8')
}

/** Cache age in milliseconds, or Infinity when the file does not exist. */
export function cacheAgeMs(path) {
  try {
    return Date.now() - statSync(path).mtimeMs
  } catch {
    return Infinity
  }
}

export function listFiles(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

export function resolveUserPath(path) {
  return isAbsolute(path) ? path : resolve(process.cwd(), path)
}
