# Implementation brief — dsh-comfyUI-control

Shared contract for every module in this package. Read this before writing code.

## What this package is

A DeepSeek Harness (DSH) plugin that completely replicates the 13 tools of the
MCP server `xingxue-ux/good-comfyui-mcp`
(`good_comfyui_mcp.py`, `lora_search.py`, `xfq_tool.py`, `pipeline.json`).
A clone of the upstream reference lives at `E:\AI\ComfyUI\temp\good-comfyui-mcp`
— read it, port its behaviour, do not copy its Python structure.

The plugin is a host-plane plugin mounted by ONE agent preset (`绘图模式`). It
registers tools on `ctx.tools`; every tool must be scoped to that preset, so no
module may register anything at import time or reach outside the plugin.

## Hard rules

- Plain ESM JavaScript, `"type": "module"`, **zero runtime dependencies**
  (Node builtins + global `fetch` only). Node >= 20.
- No TypeScript, no build step, no formatting pass. Write code that matches the
  repository style: 2-space indent, no semicolons, single quotes, short module
  comments, sparse comments. Keep lines under ~200 columns.
- Tools must never import from `@deepseek-ai/*`. Use `lib/tool.js`.
- Every tool's definition must come from `defineTool` in `lib/tool.js`; the
  harness implementation is swapped in at plugin load when resolvable.
- Do not edit files outside your task's write scope. The shared scaffold
  (`index.js`, `lib/tool.js`, `lib/env.js`, `lib/http.js`, `lib/service.js`,
  `preset/`, `tools/`, `README.md`) is owned by the Lead.
- Non-trivial pure logic must be exported and unit-tested with `node:test`
  (`node --test test/` must pass from the package root).

## Scaffold API you code against

```js
// lib/tool.js
import { defineTool } from '../tool.js'
```

```js
// lib/env.js  — resolved once per process
PLUGIN_DIR, DSH_HOME, COMFYUI_ROOT, DEFAULT_PIPELINE, COMFYUI_URL, OLLAMA_URL,
CAMOFOX_URL, VIEW_BASE, CIVITAI_HOST, CIVITAI_SEARCH_URL, CIVITAI_TOKEN,
CIVITAI_SEARCH_KEY, STATE_DIR, CACHE_DIR, COMPARE_DIR, CACHE_TTL_DAYS, MCP_MARK,
modelsDir(), outputDir(), ensureDir(dir), readJsonFile(path), writeJsonFile(path, value),
cacheAgeMs(path), listFiles(dir), resolveUserPath(path)
```

```js
// lib/http.js
HttpError, getJson(base, path, options), getText(...), getRaw(...),
postJson(base, path, body, options), tryJson(...), tryRaw(...), sleep(ms, signal)
// options: { query, headers, timeoutMs, signal, text, raw }
// getJson/postJson parse JSON and throw HttpError on non-2xx.
// tryJson returns undefined only when the peer is unreachable (HttpError still throws).
// getRaw resolves the Response for streams/downloads; non-2xx throws HttpError.
```

```js
// lib/service.js
comfy     // live ComfyUI web API (object_info, queue, history, prompt, models)
ollama    // local vision models (tags, chat with images)
camofox   // camofox-browser session driver (health, tabs, navigate, evaluate)
```

## Tool definition contract

```js
export const tools = [
  defineTool({
    name: 'comfyui_generate',
    description: '<model-facing description, English or Chinese, precise>',
    parameters: {
      prompt: { type: 'string', required: true, description: '...' },
      seed: { type: 'integer', description: '...' },
      lora_list: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        name: { type: 'string', required: true }, strength: { type: 'number' } } } },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        prompt_id: { type: 'string', required: true }, status: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: renderText(value) }],
      presentationMeta: (_args, value) => ({ /* optional UI payload, JSON */ }),
    },
    async execute(args, exec) { /* exec.signal, exec.agent, exec.callId */ return value },
  }),
]
```

- `parameters` uses the DSL of the harness: per-property `required: true`,
  types `string|number|integer|boolean|null|array|object|json|oneOf`.
  An `object` parameter needs `additionalProperties` explicitly.
- `output.schema` is mandatory. Use `{ type: 'json' }` when the shape is open
  (it compiles to an unconstrained schema). Prefer `type: 'json'` for tools
  whose result mirrors an upstream MCP dict; use an explicit object schema when
  the model benefits from it.
- `output.render` receives the validated value and returns harness
  `ContentBlock`s (`[{ type: 'text', text }]`). Keep the rendered text compact
  and readable — it is what the model sees.
- Pass the caller's `exec.signal` into every network call.

## Why the harness package is not imported

A user preset lives under `<dshHome>/.agent-presets/<id>/`, which is outside the
harness's `node_modules` upward walk, so `import '@deepseek-ai/dsh-tools'` fails
there (verified on this machine). The plugin therefore defines tools through
`lib/tool.js`, and `test/harness-schema.test.js` proves the compiled schemas and
the validation results are identical to the harness implementation.

## Tool names (the full catalog is 18)

comfyui_status, comfyui_setup_guide, comfyui_get_model_guide, comfyui_list_models,
comfyui_generate, comfyui_run_workflow, comfyui_history, comfyui_queue,
comfyui_node_info, comfyui_extract_image_info, comfyui_describe_image,
comfyui_deconfuse_image, comfyui_lookup_character_tags,
comfyui_lookup_character_appearance, comfyui_list_cached_characters,
comfyui_search_lora, comfyui_download_lora, comfyui_lookup_lora_hash

## Replica fidelity

Port behaviour, not cosmetics. Where the upstream returns a dict, the tool
returns the same fields with the same names (`prompt_id`, `outputs`,
`view_url`, `character_info`, `canonical_tag`, `appearance_tags`, `exact`,
`kind`, `model_id`, `version_id`, `sha256`, `valid_safetensors`, ...). Where the
upstream has a documented tuning (sampler lists, prompt rules, default 5-LoRA
set, cache TTL, refusal keywords) keep it.

## Verification

- `node --test test/` from the package root.
- Test pure logic; keep one live smoke test per external service guarded by a
  reachability probe so the suite still passes when a service is down.
- Services available on this machine: ComfyUI `127.0.0.1:8188`, Ollama
  `127.0.0.1:11434`, camofox-browser `127.0.0.1:9377`. Civitai has no
  credentials, so only credential-free endpoints (by-hash) can be exercised.
