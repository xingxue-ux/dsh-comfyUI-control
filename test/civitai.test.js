/**
 * Civitai LoRA tools: query variants, exact/trigger matching, scoring, by-hash
 * lookup, safetensors header parsing and download path containment.
 *
 * Every network interaction is stubbed; the only live case is the
 * credential-free by-hash smoke test, which is skipped when the LoRA file is
 * absent or the endpoint is unreachable.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

const LIVE_LORA = 'E:\\AI\\ComfyUI\\models\\loras\\surtr945_v1.safetensors'
const COMFY_ROOT = mkdtempSync(join(tmpdir(), 'dsh-comfyui-civitai-'))
const CACHE_DIR = mkdtempSync(join(tmpdir(), 'dsh-comfyui-civitai-cache-'))

process.env.COMFYUI_ROOT = COMFY_ROOT
process.env.DSH_COMFYUI_STATE = CACHE_DIR

const { genQueries, norm, exactName, KNOWN_EXACT, findExactData, searchModels, lookupByHash, safetensorsHeader, downloadVersion } = await import('../lib/lora-search.js')
const { tools } = await import('../lib/tools/civitai.js')

const byName = new Map(tools.map((tool) => [tool.name, tool]))

/** A fetch stub that also records every request it received. */
function stubFetch(routes, calls = []) {
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    for (const route of routes) {
      if (String(url).includes(route.match)) {
        return typeof route.response === 'function' ? route.response(String(url), init) : route.response
      }
    }
    throw new Error(`stub fetch: no route for ${url}`)
  }
  return { fetchImpl, calls }
}

function jsonResponse(body, status = 200, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => Buffer.from(JSON.stringify(body)).buffer,
  }
}

function modelDetailBody(creator, versions) {
  return { creator: { username: creator }, modelVersions: versions }
}

function searchBody(hits) {
  return jsonResponse({ results: [{ hits }] })
}

/** The detail fetch carries the id in the path, so one route serves all ids. */
function detailRoute(details) {
  return {
    match: '/api/v1/models/',
    response: (url) => {
      const id = String(url).split('/api/v1/models/')[1]
      return jsonResponse(details[id] ?? { error: 'NotFound' })
    },
  }
}

describe('norm / exactName', () => {
  test('strip the extension and the trigger prefix, norm folds separators', () => {
    assert.equal(exactName('@name.safetensors'), 'name')
    assert.equal(norm('@name.safetensors'), 'name')
    assert.equal(exactName('RealSkin SliderV2.safetensors'), 'RealSkin SliderV2')
    assert.equal(norm('RealSkin SliderV2.safetensors'), 'realskinsliderv2')
    assert.equal(norm('@4x0style---kedama-milk_V2.0_epoch45.safetensors'), '4x0stylekedamamilkv20epoch45')
    assert.equal(exactName('skintextureV1'), 'skintextureV1')
  })

  test('exactName keeps case, norm ignores it', () => {
    assert.equal(exactName('Kedama-Milk.safetensors'), 'Kedama-Milk')
    assert.notEqual(exactName('Kedama-Milk.safetensors'), exactName('kedama-milk.safetensors'))
    assert.equal(norm('Kedama-Milk.safetensors'), norm('kedama-milk.safetensors'))
  })
})

describe('genQueries', () => {
  test('@ trigger file: full name, separator fold, epoch-suffix strip, trigger split', () => {
    const queries = genQueries('@4x0style---kedama-milk_V2.0_epoch45.safetensors')
    assert.equal(queries[0], '@4x0style---kedama-milk_V2.0_epoch45')
    assert.equal(queries[1], '@4x0style kedama milk V2.0 epoch45')
    assert.ok(queries.includes('@4x0style---kedama-milk'))
    assert.ok(queries.includes('4x0style---kedama-milk'))
    assert.ok(!queries.includes(''))
  })

  test('anima-base-1 prefix is stripped as an extra variant pair', () => {
    const queries = genQueries('anima-base-1-photo-background-v4.safetensors')
    assert.equal(queries[0], 'anima-base-1-photo-background-v4')
    assert.ok(queries.includes('photo-background-v4'))
    assert.ok(queries.includes('photo background v4'))
  })

  test('trailing v<digits> suffix is stripped', () => {
    const queries = genQueries('skintextureV1.safetensors')
    assert.equal(queries[0], 'skintextureV1')
    assert.ok(queries.includes('skintexture'))
  })
})

describe('KNOWN_EXACT', () => {
  test('the five confirmed entries are verbatim', () => {
    assert.deepEqual(Object.keys(KNOWN_EXACT), [
      'ushikani_kassen_lora-000013.safetensors',
      'anima-darklight-style-v1-000194.safetensors',
      'RealSkin SliderV2.safetensors',
      'surtr945_v1.safetensors',
      'anima-base-1-photo-background-v4.safetensors',
    ])
    assert.deepEqual(KNOWN_EXACT['surtr945_v1.safetensors'], ['2692601', '3023314', 'umina'])
    assert.deepEqual(KNOWN_EXACT['anima-base-1-photo-background-v4.safetensors'], ['1252497', '2959007', 'motimalu'])
  })
})

describe('findExactData', () => {
  test('KNOWN hit resolves without any network', async () => {
    const { fetchImpl, calls } = stubFetch([])
    const result = await findExactData('surtr945_v1.safetensors', { deps: { fetchImpl } })
    assert.deepEqual(result, {
      exact: true,
      kind: 'KNOWN',
      model_id: '2692601',
      version_id: '3023314',
      author: 'umina',
      base: null,
      trained_words: null,
      candidates: [],
    })
    assert.equal(calls.length, 0)
  })

  test('EXACT filename match from a stubbed model list', async () => {
    const { fetchImpl } = stubFetch([
      { match: 'multi-search', response: searchBody([{ id: 42, type: 'LORA', name: 'Kedama' }]) },
      {
        match: '/api/v1/models/',
        response: jsonResponse(modelDetailBody('kedama', [
          { id: 7, baseModel: 'Illustrious', trainedWords: ['kedama'], files: [{ type: 'Model', name: '@4x0style---kedama-milk_V2.0_epoch45.safetensors' }] },
        ])),
      },
    ])
    const result = await findExactData('@4x0style---kedama-milk_V2.0_epoch45.safetensors', { deps: { fetchImpl } })
    assert.equal(result.exact, true)
    assert.equal(result.kind, 'EXACT')
    assert.equal(result.model_id, '42')
    assert.equal(result.version_id, '7')
    assert.equal(result.author, 'kedama')
    assert.equal(result.base, 'Illustrious')
  })

  test('EXACT-TRIGGER with base_model drops a version whose baseModel differs', async () => {
    const { fetchImpl } = stubFetch([
      {
        match: 'multi-search',
        response: searchBody([{
          id: 100,
          type: 'LORA',
          name: 'Kedama Milk',
          user: { username: 'kedama' },
          versions: [
            { id: 201, baseModel: 'Illustrious', trainedWords: ['@4x0style'], files: [{ type: 'Model', name: 'unrelated.safetensors' }] },
            { id: 200, baseModel: 'Anima', trainedWords: ['@4x0style'], files: [{ type: 'Model', name: 'kedama-milk_V2.0_epoch45.safetensors' }] },
          ],
        }]),
      },
      detailRoute({
        100: modelDetailBody('kedama', [
          { id: 201, baseModel: 'Illustrious', files: [{ type: 'Model', name: 'unrelated.safetensors' }] },
          { id: 200, baseModel: 'Anima', files: [{ type: 'Model', name: 'kedama-milk_V2.0_epoch45.safetensors' }] },
        ]),
      }),
    ])
    const name = '@4x0style---kedama-milk_V2.0_epoch45.safetensors'
    const unfiltered = await findExactData(name, { deps: { fetchImpl } })
    assert.equal(unfiltered.exact, true)
    assert.equal(unfiltered.kind, 'EXACT-TRIGGER')
    assert.equal(unfiltered.version_id, '201')
    const filtered = await findExactData(name, { baseModel: 'Anima', deps: { fetchImpl } })
    assert.equal(filtered.exact, true)
    assert.equal(filtered.kind, 'EXACT-TRIGGER')
    assert.equal(filtered.model_id, '100')
    assert.equal(filtered.version_id, '200')
    assert.equal(filtered.base, 'Anima')
    assert.deepEqual(filtered.trained_words, ['@4x0style'])
    assert.equal(filtered.author, 'kedama')
  })

  test('EXACT-TRIGGER scoring prefers base_model, then file presence', async () => {
    const { fetchImpl } = stubFetch([
      {
        match: 'multi-search',
        response: searchBody([
          {
            id: 300,
            type: 'LORA',
            name: 'Illus Only',
            user: { username: 'a' },
            versions: [{ id: 301, baseModel: 'Illustrious', trainedWords: ['@4x0style'], files: [{ type: 'Model', name: 'a.safetensors' }] }],
          },
          {
            id: 400,
            type: 'LORA',
            name: 'Anima Only',
            user: { username: 'b' },
            versions: [{ id: 401, baseModel: 'Anima', trainedWords: ['@4x0style'], files: [{ type: 'Model', name: 'b.safetensors' }] }],
          },
          {
            id: 500,
            type: 'LORA',
            name: 'No Files',
            user: { username: 'c' },
            versions: [{ id: 501, baseModel: 'Illustrious', trainedWords: ['@4x0style'], files: [] }],
          },
        ]),
      },
      detailRoute({
        300: modelDetailBody('a', [{ id: 301, baseModel: 'Illustrious', files: [{ type: 'Model', name: 'a.safetensors' }] }]),
        400: modelDetailBody('b', [{ id: 401, baseModel: 'Anima', files: [{ type: 'Model', name: 'b.safetensors' }] }]),
        500: modelDetailBody('c', [{ id: 501, baseModel: 'Illustrious', files: [] }]),
      }),
    ])
    const name = '@4x0style---kedama-milk_V2.0_epoch45.safetensors'
    const preferred = await findExactData(name, { baseModel: 'Anima', deps: { fetchImpl } })
    assert.equal(preferred.kind, 'EXACT-TRIGGER')
    assert.equal(preferred.model_id, '400')
    assert.equal(preferred.version_id, '401')
    assert.equal(preferred.base, 'Anima')
    assert.equal(preferred.author, 'b')
    const ranked = await findExactData(name, { deps: { fetchImpl } })
    assert.equal(ranked.kind, 'EXACT-TRIGGER')
    assert.equal(ranked.model_id, '300')
    assert.equal(ranked.version_id, '301')
  })

  test('no match returns exact:false with up to 10 candidates', async () => {
    const { fetchImpl } = stubFetch([
      {
        match: 'multi-search',
        response: searchBody([{
          id: 9,
          type: 'LORA',
          name: 'Something Else',
          user: { username: 'someone' },
          versions: [
            { id: 91, baseModel: 'SDXL', trainedWords: ['unrelated'], files: [{ type: 'Model', name: 'other.safetensors' }] },
            { id: 92, baseModel: 'Pony', trainedWords: [], files: [{ type: 'Model', name: 'other2.safetensors' }] },
            { id: 93, baseModel: 'Flux', trainedWords: [], files: [] },
          ],
        }]),
      },
      detailRoute({ 9: modelDetailBody('someone', [{ id: 91, baseModel: 'SDXL', files: [{ type: 'Model', name: 'other.safetensors' }] }]) }),
    ])
    const result = await findExactData('nothing-like-this.safetensors', { deps: { fetchImpl } })
    assert.equal(result.exact, false)
    assert.equal(result.kind, null)
    assert.equal(result.candidates.length, 2)
    assert.deepEqual(result.candidates[0], {
      model_id: '9',
      name: 'Something Else',
      author: 'someone',
      base: 'SDXL',
      version_id: '91',
      trained_words: ['unrelated'],
    })
  })
})

describe('searchModels', () => {
  test('posts the models_v9 query and keeps LORA hits only', async () => {
    const { fetchImpl, calls } = stubFetch([
      { match: 'multi-search', response: searchBody([{ id: 1, type: 'LORA' }, { id: 2, type: 'Checkpoint' }, { id: 3, type: 'LORA' }]) },
    ])
    const hits = await searchModels('surtr945', { limit: 7, deps: { fetchImpl, searchKey: 'key-1' } })
    assert.deepEqual(hits.map((hit) => hit.id), [1, 3])
    assert.deepEqual(JSON.parse(calls[0].init.body), { queries: [{ q: 'surtr945', indexUid: 'models_v9', limit: 7, offset: 0 }] })
    assert.equal(calls[0].init.headers.Authorization, 'Bearer key-1')
  })

  test('retries three times and returns [] when every attempt fails', async () => {
    let attempts = 0
    const fetchImpl = async () => {
      attempts += 1
      throw new Error('network down')
    }
    assert.deepEqual(await searchModels('x', { deps: { fetchImpl, sleepMs: -3000 } }), [])
    assert.equal(attempts, 3)
  })
})

describe('lookupByHash', () => {
  let file
  let sha

  before(() => {
    file = join(COMFY_ROOT, 'hash-fixture.bin')
    writeFileSync(file, Buffer.alloc(1234, 7))
    sha = createHash('sha256').update(readFileSync(file)).digest('hex').toUpperCase()
  })

  test('hit returns the upstream dict and sends the uppercase hash', async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        match: '/api/v1/model-versions/by-hash/',
        response: jsonResponse({
          modelId: 2692601,
          id: 3023314,
          baseModel: 'Anima',
          status: 'Published',
          model: { name: 'surtr945' },
          files: [{ type: 'Model', name: 'surtr945_v1.safetensors' }, { type: 'Training Data', name: 'dataset.zip' }],
        }),
      },
    ])
    const result = await lookupByHash(file, { deps: { fetchImpl, token: 'token-1', host: 'https://civitai.test' } })
    assert.equal(result.sha256, sha)
    assert.equal(result.hit, true)
    assert.equal(result.model_id, 2692601)
    assert.equal(result.version_id, 3023314)
    assert.equal(result.base_model, 'Anima')
    assert.equal(result.status, 'Published')
    assert.equal(result.model_name, 'surtr945')
    assert.deepEqual(result.files, ['surtr945_v1.safetensors'])
    assert.equal(calls[0].url, `https://civitai.test/api/v1/model-versions/by-hash/${sha}`)
    assert.equal(calls[0].init.headers.Authorization, 'Bearer token-1')
  })

  test('non-200 is a miss, not a throw', async () => {
    const { fetchImpl } = stubFetch([{ match: 'by-hash', response: jsonResponse({ error: 'NotFound' }, 404) }])
    assert.deepEqual(await lookupByHash(file, { deps: { fetchImpl, token: 'token-1' } }), { sha256: sha, hit: false })
  })

  test('no Authorization header when the token is empty', async () => {
    const { fetchImpl, calls } = stubFetch([{ match: 'by-hash', response: jsonResponse({ modelId: 1, id: 2 }) }])
    await lookupByHash(file, { deps: { fetchImpl, token: '' } })
    assert.equal(Object.hasOwn(calls[0].init.headers, 'Authorization'), false)
  })
})

describe('safetensorsHeader', () => {
  function safetensorsBuffer(header) {
    const head = Buffer.from(JSON.stringify(header), 'utf8')
    const length = Buffer.alloc(8)
    length.writeBigUInt64LE(BigInt(head.length))
    return Buffer.concat([length, head, Buffer.alloc(64, 0)])
  }

  test('valid header counts __metadata__ entries from a buffer', () => {
    const buffer = safetensorsBuffer({ __metadata__: { 'modelspec.title': 'x', 'ss_network_dim': '32' }, 'lora_a.weight': { dtype: 'F16' } })
    const header = safetensorsHeader(buffer)
    assert.equal(header.ok, true)
    assert.equal(header.keys, 2)
    assert.equal(header.headerBytes, Buffer.byteLength(JSON.stringify({ __metadata__: { 'modelspec.title': 'x', 'ss_network_dim': '32' }, 'lora_a.weight': { dtype: 'F16' } })))
  })

  test('header without __metadata__ counts the keys', () => {
    const header = safetensorsHeader(safetensorsBuffer({ 'lora_a.weight': {}, 'lora_b.weight': {} }))
    assert.equal(header.ok, true)
    assert.equal(header.keys, 2)
  })

  test('a path reads only the head of the file', () => {
    const file = join(COMFY_ROOT, 'header-fixture.safetensors')
    writeFileSync(file, safetensorsBuffer({ 'lora_a.weight': {} }))
    assert.deepEqual(safetensorsHeader(file), { ok: true, keys: 1, headerBytes: Buffer.byteLength('{"lora_a.weight":{}}') })
  })

  test('malformed headers report ok:false', () => {
    assert.deepEqual(safetensorsHeader(Buffer.from('nope')), { ok: false, keys: 0, headerBytes: 0 })
    assert.deepEqual(safetensorsHeader(Buffer.concat([Buffer.alloc(8), Buffer.from('{not json')])), { ok: false, keys: 0, headerBytes: 0 })
    const oversize = Buffer.alloc(8)
    oversize.writeBigUInt64LE(BigInt(4096))
    assert.deepEqual(safetensorsHeader(oversize), { ok: false, keys: 0, headerBytes: 0 })
  })
})

describe('downloadVersion', () => {
  test('a response under 100 KB is rejected', async () => {
    const { fetchImpl, calls } = stubFetch([
      { match: '/api/download/models/', response: jsonResponse({ error: 'Unauthorized' }) },
    ])
    await assert.rejects(downloadVersion(3023314, { deps: { fetchImpl, token: 'token-1', host: 'https://civitai.test' } }), /http=200 size=/)
    assert.equal(calls[0].url, 'https://civitai.test/api/download/models/3023314?token=token-1')
  })
})

describe('comfyui_download_lora', () => {
  function downloadStub(size) {
    const payload = Buffer.alloc(size, 3)
    const head = Buffer.from(JSON.stringify({ 'lora_a.weight': {} }), 'utf8')
    const length = Buffer.alloc(8)
    length.writeBigUInt64LE(BigInt(head.length))
    Buffer.concat([length, head, Buffer.alloc(64, 0)]).copy(payload)
    return (url, init) => {
      return {
        status: 200,
        ok: true,
        headers: { get: () => 'application/octet-stream' },
        arrayBuffer: async () => payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.length),
      }
    }
  }

  test('a filename with a path separator is refused', async () => {
    await assert.rejects(byName.get('comfyui_download_lora').execute({ version_id: 1, filename: '../evil.safetensors' }, {}), /invalid filename/)
    await assert.rejects(byName.get('comfyui_download_lora').execute({ version_id: 1, filename: 'sub/evil.safetensors' }, {}), /invalid filename/)
    await assert.rejects(byName.get('comfyui_download_lora').execute({ version_id: 1, filename: 'ok.safetensors', subdir: '../..' }, {}), /escapes/)
  })

  test('a valid download lands under models/loras and reports the upstream dict', async () => {
    const original = globalThis.fetch
    globalThis.fetch = downloadStub(150_000)
    try {
      const result = await byName.get('comfyui_download_lora').execute({ version_id: 3023314, filename: 'surtr945_v1.safetensors' }, {})
      const expected = join(COMFY_ROOT, 'models', 'loras', 'surtr945_v1.safetensors')
      assert.equal(result.saved, expected)
      assert.equal(result.size_mb, 0.1)
      assert.equal(result.valid_safetensors, true)
      assert.equal(result.metadata_keys, 1)
      assert.equal(existsSync(expected), true)
    } finally {
      globalThis.fetch = original
    }
  })

  test('subdir nests without touching the file name', async () => {
    const original = globalThis.fetch
    globalThis.fetch = downloadStub(150_000)
    try {
      const result = await byName.get('comfyui_download_lora').execute({ version_id: 1, filename: 'style.safetensors', subdir: 'krea2/style' }, {})
      assert.equal(result.saved, join(COMFY_ROOT, 'models', 'loras', 'krea2', 'style', 'style.safetensors'))
      assert.equal(existsSync(result.saved), true)
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('comfyui_lookup_lora_hash (live)', () => {
  test('by-hash works without credentials', async (t) => {
    if (!existsSync(LIVE_LORA)) {
      t.skip(`${LIVE_LORA} is not present`)
      return
    }
    let result
    try {
      const probe = await fetch('https://civitai.red/api/v1/model-versions/by-hash/' + '0'.repeat(64), { signal: AbortSignal.timeout(5000) })
      if (probe.status >= 500) throw new Error(`civitai returned ${probe.status}`)
    } catch (error) {
      t.skip(`civitai.red unreachable: ${error.message}`)
      return
    }
    result = await byName.get('comfyui_lookup_lora_hash').execute({ local_path: LIVE_LORA }, {})
    assert.match(result.sha256, /^[0-9A-F]{64}$/)
    assert.equal(result.sha256, createHash('sha256').update(readFileSync(LIVE_LORA)).digest('hex').toUpperCase())
    assert.equal(typeof result.hit, 'boolean')
    t.diagnostic(`live by-hash ${LIVE_LORA}: sha256=${result.sha256} hit=${result.hit} ${result.hit ? `model_id=${result.model_id} version_id=${result.version_id} base=${result.base_model} status=${result.status}` : ''}`)
  })
})

after(() => {
  rmSync(COMFY_ROOT, { recursive: true, force: true })
  rmSync(CACHE_DIR, { recursive: true, force: true })
})
