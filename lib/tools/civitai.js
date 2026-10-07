/**
 * Civitai LoRA tools: exact-version search, download + safetensors validation,
 * and by-hash reverse lookup.
 *
 * Replica of good-comfyui-mcp's `search_lora`, `download_lora` and
 * `lookup_lora_hash`; the search/scoring engine lives in `lib/lora-search.js`.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { COMFYUI_ROOT } from '../env.js'
import { downloadVersion, findExactData, lookupByHash, safetensorsHeader } from '../lora-search.js'
import { defineTool } from '../tool.js'

/** `models/loras`, optionally nested one level deeper by `subdir`. */
function loraTarget(filename, subdir) {
  if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('\0')) {
    throw new Error(`invalid filename: ${filename}`)
  }
  const loras = join(COMFYUI_ROOT, 'models', 'loras')
  if (subdir !== undefined && (isAbsolute(subdir) || subdir.includes(':') || subdir.split(/[\\/]/).includes('..'))) {
    throw new Error(`invalid subdir: ${subdir}`)
  }
  const dir = subdir ? join(loras, subdir) : loras
  const target = resolve(dir, filename)
  const root = resolve(loras) + sep
  if (!target.startsWith(root)) throw new Error(`path escapes models/loras: ${filename}`)
  return target
}

/**
 * A version id from the model. `comfyui_search_lora` returns it as a string (the
 * upstream dict shape) while a human pastes it as a number, so both are accepted.
 */
function versionId(value) {
  const id = typeof value === 'string' ? Number(value.trim()) : value
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`invalid version_id: ${JSON.stringify(value)}`)
  return id
}

/** Compact model-facing rendering of a search result or a by-hash result. */
function renderText(value) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export const tools = [
  defineTool({
    name: 'comfyui_search_lora',
    description:
      'Exhaustively search civitai.red for the exact version of a LoRA file (the web search endpoint over the models_v9 index is broader than the API search: published models such as surtr945 2692601 or Hentai Studio Quality 1459030 are missing from /api/v1/models?query=). Precedence: known confirmed table → filename exact match → trainedWords trigger match (equality or prefix, short words only count on equality) → preferred base model → presence of a Model file. ' +
      'Returns {"exact", "kind" (KNOWN/EXACT/EXACT-TRIGGER), "model_id", "version_id", "author", "base", "trained_words", "candidates"}. ' +
      'Pass fresh=true to ignore the known table and search again. Download the result with comfyui_download_lora using the returned version_id.',
    parameters: {
      filename: { type: 'string', required: true, description: 'LoRA file name, with or without the .safetensors suffix and the @ trigger prefix, e.g. "surtr945_v1.safetensors".' },
      fresh: { type: 'boolean', description: 'Skip the confirmed exact-version table and search from scratch. Default false.' },
      base_model: { type: 'string', description: 'Preferred base model (e.g. "Anima", usually taken from the UNETLoader of the workflow). Matching versions are ranked first; with a value set, versions whose baseModel does not contain it are dropped.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderText(value) }],
    },
    execute(args, exec) {
      return findExactData(args.filename, { fresh: args.fresh === true, baseModel: args.base_model, signal: exec?.signal })
    },
  }),

  defineTool({
    name: 'comfyui_download_lora',
    description:
      'Download a LoRA from civitai.red into <ComfyUI>/models/loras (optionally a subdirectory) and verify that the result is a valid safetensors file. Requires CIVITAI_TOKEN in the environment; without it the download is refused by Civitai. ' +
      'version_id is the model version id returned by comfyui_search_lora or comfyui_lookup_lora_hash. filename must be a bare file name — use subdir to nest, it is the only way to use a subdirectory. ' +
      'A response under 100 KB (usually an HTML error page) is rejected without writing anything; a saved file whose safetensors header cannot be parsed is flagged with valid_safetensors: false. Returns {"saved", "size_mb", "valid_safetensors", "metadata_keys"}.',
    parameters: {
      version_id: {
        oneOf: [
          { type: 'integer', description: 'Civitai model version id, e.g. 3023314.' },
          { type: 'string', description: 'The same id as a string, exactly as comfyui_search_lora returns it.' },
        ],
        required: true,
        description: 'Civitai model version id from comfyui_search_lora or comfyui_lookup_lora_hash. A string id is accepted because the search result carries one.',
      },
      filename: { type: 'string', required: true, description: 'File name to save as, including .safetensors. No path separators.' },
      subdir: { type: 'string', description: 'Optional subdirectory under models/loras, e.g. "krea2/style". A drive-qualified component is rejected.' },
      timeout_ms: { type: 'integer', default: 600000, description: 'Download deadline in milliseconds. Default 600000 (10 minutes).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderText(value) }],
    },
    timeoutMs: 660000,
    async execute(args, exec) {
      const target = loraTarget(args.filename, args.subdir)
      const { bytes } = await downloadVersion(versionId(args.version_id), { signal: exec?.signal, timeoutMs: args.timeout_ms })
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, bytes)
      const header = safetensorsHeader(bytes)
      return {
        saved: target,
        size_mb: Math.round(bytes.length / 1048576 * 10) / 10,
        valid_safetensors: header.ok,
        metadata_keys: header.keys,
      }
    },
  }),

  defineTool({
    name: 'comfyui_lookup_lora_hash',
    description:
      'Compute the SHA256 of a local LoRA file and reverse-look it up on Civitai (/api/v1/model-versions/by-hash). This endpoint is public and far more reliable than searching by name: versions that the search index misses are still found by hash. ' +
      'Returns a miss as {"sha256", "hit": false}; on a hit it adds model_id, version_id, base_model, status, model_name and the list of Model file names. Use this before comfyui_search_lora when you already have the file on disk.',
    parameters: {
      local_path: { type: 'string', required: true, description: 'Path to the local LoRA file, e.g. "E:/AI/ComfyUI/models/loras/surtr945_v1.safetensors".' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderText(value) }],
    },
    execute(args, exec) {
      return lookupByHash(isAbsolute(args.local_path) ? args.local_path : resolve(process.cwd(), args.local_path), { signal: exec?.signal })
    },
  }),
]
