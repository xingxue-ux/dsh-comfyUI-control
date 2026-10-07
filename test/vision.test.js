/**
 * Tests for the PNG codec, the Gilbert-curve permutation and the two vision
 * tools. Everything is offline except the final live Ollama probe, which skips
 * when no vision model is installed.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { deflateSync } from 'node:zlib'

let tempDir
function tempPath(name) {
  if (!tempDir) tempDir = mkdtempSync(join(tmpdir(), 'dsh-vision-'))
  return join(tempDir, name)
}

process.on('exit', () => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
})

// The de-obfuscation tool only writes inside outputDir()/STATE_DIR, and both are
// resolved at module load. Pointing the state directory at this suite's temp
// directory first means the tool's write boundary is the test sandbox.
process.env.DSH_COMFYUI_STATE = tempPath('state')

const { OLLAMA_URL } = await import('../lib/env.js')
const { decodePng, encodePng, parsePng, readTextMetadata } = await import('../lib/png.js')
const { tools } = await import('../lib/tools/vision.js')
const { setHostServicesForTest } = await import('../lib/services.js')
const { gilbertCurve, transformTimes, xfqTransform } = await import('../lib/xfq.js')

const describeTool = tools.find((tool) => tool.name === 'comfyui_describe_image')
const deconfuseTool = tools.find((tool) => tool.name === 'comfyui_deconfuse_image')
const SAMPLES = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

// ---------------------------------------------------------------- PNG fixtures

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, payload) {
  const data = Buffer.from(payload)
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

function paeth(left, up, upLeft) {
  const p = left + up - upLeft
  const pa = Math.abs(p - left)
  const pb = Math.abs(p - up)
  const pc = Math.abs(p - upLeft)
  if (pa <= pb && pa <= pc) return left
  return pb <= pc ? up : upLeft
}

/**
 * Hand-built PNG with independently implemented *forward* filters, so the
 * decoder's reconstruction is checked against a separate implementation.
 */
function buildPng({ width, height, bitDepth = 8, colorType = 2, rows, filters, palette, trns, textChunks = [], interlace = 0 }) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = bitDepth
  ihdr[9] = colorType
  ihdr[12] = interlace
  const bpp = Math.max(1, Math.ceil((SAMPLES[colorType] * bitDepth) / 8))
  const scanlines = []
  for (let y = 0; y < height; y++) {
    const raw = Buffer.from(rows[y])
    const prev = y > 0 ? Buffer.from(rows[y - 1]) : undefined
    const type = filters ? filters[y % filters.length] : 0
    const out = Buffer.alloc(raw.length + 1)
    out[0] = type
    for (let i = 0; i < raw.length; i++) {
      const left = i >= bpp ? raw[i - bpp] : 0
      const up = prev ? prev[i] : 0
      const upLeft = prev && i >= bpp ? prev[i - bpp] : 0
      let value = raw[i]
      if (type === 1) value -= left
      else if (type === 2) value -= up
      else if (type === 3) value -= (left + up) >> 1
      else if (type === 4) value -= paeth(left, up, upLeft)
      out[i + 1] = value & 0xff
    }
    scanlines.push(out)
  }
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)]
  if (palette) parts.push(chunk('PLTE', palette))
  if (trns) parts.push(chunk('tRNS', trns))
  for (const text of textChunks) parts.push(chunk(text.type, text.data))
  parts.push(chunk('IDAT', deflateSync(Buffer.concat(scanlines))), chunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(parts)
}

function pattern(width, height, channels, seed = 0) {
  const data = new Uint8Array(width * height * channels)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < channels; c++) data[(y * width + x) * channels + c] = (x * 11 + y * 23 + c * 37 + seed * 5) % 256
    }
  }
  return data
}

function rowsOf(data, width, channels) {
  const rows = []
  for (let y = 0; y * width * channels < data.length; y++) rows.push(data.subarray(y * width * channels, (y + 1) * width * channels))
  return rows
}

function sameBytes(actual, expected) {
  return Buffer.from(actual).equals(Buffer.from(expected))
}

// ---------------------------------------------------------------- PNG codec

test('encodePng/decodePng round-trip an RGB image', () => {
  const width = 37
  const height = 23
  const data = pattern(width, height, 3)
  const png = encodePng({ width, height, channels: 3, data })
  const parsed = parsePng(png)
  assert.equal(parsed.width, width)
  assert.equal(parsed.height, height)
  assert.equal(parsed.bitDepth, 8)
  assert.equal(parsed.colorType, 2)
  assert.equal(parsed.interlace, 0)
  assert.equal(parsed.chunks.filter((entry) => entry.type === 'IDAT').length, 1)
  const decoded = decodePng(png)
  assert.deepEqual({ width: decoded.width, height: decoded.height, channels: decoded.channels }, { width, height, channels: 3 })
  assert.ok(sameBytes(decoded.data, data), 'RGB pixels must survive the round trip')
})

test('encodePng/decodePng round-trip an RGBA image', () => {
  const width = 21
  const height = 9
  const data = pattern(width, height, 4, 3)
  const decoded = decodePng(encodePng({ width, height, channels: 4, data }))
  assert.equal(decoded.channels, 4)
  assert.ok(sameBytes(decoded.data, data), 'RGBA pixels and alpha must survive the round trip')
})

test('decodePng reconstructs every PNG filter type', () => {
  const cases = [
    { width: 20, height: 5, channels: 3, filters: [0, 1, 2, 3, 4] },
    { width: 13, height: 5, channels: 4, filters: [4, 3, 2, 1, 0] },
    { width: 9, height: 3, channels: 3, filters: [3, 4, 1] },
  ]
  for (const { width, height, channels, filters } of cases) {
    const data = pattern(width, height, channels)
    const png = buildPng({ width, height, colorType: channels === 4 ? 6 : 2, rows: rowsOf(data, width, channels), filters })
    const decoded = decodePng(png)
    assert.equal(decoded.channels, channels)
    assert.ok(sameBytes(decoded.data, data), `filters ${filters} at ${width}x${height}x${channels} must reconstruct exactly`)
  }
})

test('decodePng reconstructs filters on a gray+alpha PNG (2-byte pixels)', () => {
  const width = 9
  const height = 3
  const data = pattern(width, height, 2, 7)
  const png = buildPng({ width, height, colorType: 4, rows: rowsOf(data, width, 2), filters: [1, 4, 3] })
  const decoded = decodePng(png)
  assert.equal(decoded.channels, 4)
  const expected = new Uint8Array(width * height * 4)
  for (let i = 0, o = 0; i < data.length; i += 2) {
    expected[o++] = data[i]
    expected[o++] = data[i]
    expected[o++] = data[i]
    expected[o++] = data[i + 1]
  }
  assert.ok(sameBytes(decoded.data, expected))
})

test('decodePng expands a 2-bit palette with tRNS alpha', () => {
  const palette = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0])
  const png = buildPng({ width: 4, height: 2, bitDepth: 2, colorType: 3, rows: [Buffer.from([0x1b]), Buffer.from([0xe4])], palette, trns: Buffer.from([255, 128, 0]) })
  const decoded = decodePng(png)
  assert.equal(decoded.channels, 4)
  assert.ok(sameBytes(decoded.data, [
    255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 255, 255, 0, 255,
    255, 255, 0, 255, 0, 0, 255, 0, 0, 255, 0, 128, 255, 0, 0, 255,
  ]))
})

test('decodePng expands 1-bit gray and 16-bit gray', () => {
  const bilevel = decodePng(buildPng({ width: 8, height: 2, bitDepth: 1, colorType: 0, rows: [Buffer.from([0xaa]), Buffer.from([0x55])] }))
  assert.equal(bilevel.channels, 3)
  assert.ok(sameBytes(bilevel.data, [255, 255, 255, 0, 0, 0, 255, 255, 255, 0, 0, 0, 255, 255, 255, 0, 0, 0, 255, 255, 255, 0, 0, 0,
    0, 0, 0, 255, 255, 255, 0, 0, 0, 255, 255, 255, 0, 0, 0, 255, 255, 255, 0, 0, 0, 255, 255, 255]))

  // 16-bit samples are downcast to their most significant byte.
  const wide = decodePng(buildPng({ width: 4, height: 1, bitDepth: 16, colorType: 0, rows: [Buffer.from([0x00, 0x00, 0x12, 0x34, 0xab, 0xcd, 0xff, 0xff])] }))
  assert.ok(sameBytes(wide.data, [0, 0, 0, 0x12, 0x12, 0x12, 0xab, 0xab, 0xab, 0xff, 0xff, 0xff]))
})

test('parsePng rejects interlaced and non-PNG input', () => {
  const png = buildPng({ width: 4, height: 2, colorType: 2, rows: rowsOf(pattern(4, 2, 3), 4, 3), interlace: 1 })
  assert.throws(() => parsePng(png), /interlaced \(Adam7\) PNG is not supported/)
  assert.throws(() => parsePng(Buffer.from('not a png at all, really')), /not a PNG file/)
  assert.throws(() => decodePng(encodePng({ width: 2, height: 2, channels: 2, data: new Uint8Array(8) })), /3 \(RGB\) or 4 \(RGBA\) channels/)
})

function itxt(key, language, translated, text) {
  return Buffer.concat([
    Buffer.from(key, 'latin1'), Buffer.from([0, 0, 0]),
    Buffer.from(language, 'latin1'), Buffer.from([0]),
    Buffer.from(translated, 'utf8'), Buffer.from([0]),
    Buffer.from(text, 'utf8'),
  ])
}

test('readTextMetadata reads ComfyUI prompt/workflow, WebUI parameters and zTXt/iTXt', () => {
  const prompt = '{"1": {"class_type": "KSampler", "inputs": {"seed": 42}}}'
  const workflow = '{"nodes": [], "links": []}'
  const parameters = 'a cat, masterpiece\nSteps: 20, Sampler: Euler a, CFG scale: 7, Seed: 1'
  const longComment = 'c'.repeat(2500)
  const png = buildPng({
    width: 4,
    height: 2,
    colorType: 2,
    rows: rowsOf(pattern(4, 2, 3), 4, 3),
    textChunks: [
      { type: 'tEXt', data: Buffer.from(`prompt\u0000${prompt}`, 'utf8') },
      { type: 'tEXt', data: Buffer.from(`workflow\u0000${workflow}`, 'utf8') },
      { type: 'iTXt', data: itxt('parameters', 'zh', '参数', parameters) },
      { type: 'tEXt', data: Buffer.from(`Comment\u0000${longComment}`, 'utf8') },
      { type: 'tEXt', data: Buffer.from('Software\u0000ignored', 'utf8') },
      { type: 'zTXt', data: Buffer.concat([Buffer.from('Description\u0000\u0000', 'latin1'), deflateSync(Buffer.from('压缩的描述', 'utf8'))]) },
    ],
  })
  const metadata = readTextMetadata(png)
  assert.equal(metadata.prompt, prompt)
  assert.equal(metadata.workflow, workflow)
  assert.equal(metadata.parameters, parameters)
  assert.equal(metadata.Comment.length, 2000)
  assert.equal(metadata.Description, '压缩的描述')
  assert.equal(metadata.Software, undefined)
})

test('encodePng re-attaches preserved text chunks that readTextMetadata can read back', () => {
  const source = buildPng({
    width: 5,
    height: 3,
    colorType: 2,
    rows: rowsOf(pattern(5, 3, 3), 5, 3),
    textChunks: [{ type: 'tEXt', data: Buffer.from('parameters\u0000hello world', 'utf8') }],
  })
  const decoded = decodePng(source)
  const reencoded = encodePng(decoded, { textChunks: parsePng(source).textChunks })
  assert.deepEqual(readTextMetadata(reencoded), { parameters: 'hello world' })
  assert.ok(sameBytes(decodePng(reencoded).data, decoded.data))
})

// ---------------------------------------------------------------- xfq

test('gilbertCurve visits every pixel of a w×h grid exactly once', () => {
  for (const [w, h] of [[8, 8], [16, 8], [8, 16], [3, 7]]) {
    const curve = gilbertCurve(w, h)
    assert.equal(curve.length, w * h, `${w}x${h} curve length`)
    const seen = new Set()
    for (const [x, y] of curve) {
      assert.ok(Number.isInteger(x) && Number.isInteger(y), `${w}x${h} integer coordinates`)
      assert.ok(x >= 0 && x < w && y >= 0 && y < h, `${w}x${h} coordinate ${x},${y} in range`)
      seen.add(y * w + x)
    }
    assert.equal(seen.size, w * h, `${w}x${h} every pixel visited exactly once`)
  }
})

test('gilbertCurve matches the Python xfq_tool reference sequence', () => {
  assert.deepEqual(gilbertCurve(3, 7), [
    [0, 0], [0, 1], [1, 1], [1, 0], [2, 0], [2, 1], [2, 2], [2, 3], [1, 3], [1, 2], [0, 2], [0, 3], [0, 4], [1, 4], [2, 4], [2, 5], [2, 6], [1, 6], [1, 5], [0, 5], [0, 6],
  ])
})

test('xfqTransform reproduces the Python xfq_tool output byte for byte', () => {
  // Golden values from `xfq_tool.xfq_transform` on the same deterministic pattern.
  const sha = (image) => createHash('sha256').update(Buffer.from(image.data)).digest('hex')
  const enc = xfqTransform({ width: 3, height: 7, channels: 3, data: pattern(3, 7, 3) }, 'enc')
  assert.equal(Buffer.from(enc.data).toString('hex'), '50759a456a8f5c81a6395e832e5378678cb17ea3c895badf7297bc7398bda0c5ea89aed38aafd400254a173c6144698e2d527722476c5b80a5163b600b3055')
  const wide = { width: 8, height: 8, channels: 3, data: pattern(8, 8, 3) }
  assert.equal(sha(xfqTransform(wide, 'enc')), 'a42055cfb59f2bfa2cc12e87a6b0da068d97481b239cfa51657fe615d09bdaac')
  assert.equal(sha(xfqTransform(wide, 'dec')), 'b3e92f9d75a533d7c1f3e54ef1b611d7ddf106b5d60dd537649e5ad572073b77')
})

test('xfqTransform dec is the exact inverse of enc', () => {
  for (const [width, height, channels] of [[5, 9, 3], [8, 8, 4], [16, 8, 3], [3, 7, 3]]) {
    const image = { width, height, channels, data: pattern(width, height, channels, 11) }
    assert.ok(sameBytes(xfqTransform(xfqTransform(image, 'enc'), 'dec').data, image.data), `${width}x${height}x${channels} dec(enc(img))`)
    assert.ok(sameBytes(xfqTransform(xfqTransform(image, 'dec'), 'enc').data, image.data), `${width}x${height}x${channels} enc(dec(img))`)
  }
  assert.throws(() => xfqTransform({ width: 2, height: 2, channels: 3, data: new Uint8Array(12) }, 'rotate'), /mode must be 'enc' or 'dec'/)
})

test('transformTimes applies N passes and inverts them', () => {
  const image = { width: 7, height: 5, channels: 3, data: pattern(7, 5, 3, 5) }
  const twice = transformTimes(image, 'enc', 2)
  const manual = xfqTransform(xfqTransform(image, 'enc'), 'enc')
  assert.ok(sameBytes(twice.data, manual.data))
  assert.ok(sameBytes(transformTimes(twice, 'dec', 2).data, image.data))
  assert.ok(sameBytes(transformTimes(image, 'enc', 0).data, image.data))
})

// ---------------------------------------------------------------- vision tools

function withFetch(t, responses) {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), init })
    const payload = responses[Math.min(calls.length - 1, responses.length - 1)]
    return new Response(JSON.stringify(payload), { status: payload.__status ?? 200, headers: { 'content-type': 'application/json' } })
  })
  return calls
}

/** A stand-in for the harness llm + attachments services. */
function stubHostServices(t, { models = {}, answer = 'host vision answer', resolveThrows = false } = {}) {
  const calls = []
  const previous = setHostServicesForTest({
    llm: {
      resolveModelInfo: async (provider, model) => {
        if (resolveThrows) throw new Error('no resolver')
        const hit = (models[provider] ?? []).find((entry) => entry.id === model)
        if (!hit) throw new Error(`unknown model ${provider}/${model}`)
        return { inputModalities: hit.inputModalities }
      },
      listModels: async (provider) => models[provider] ?? [],
      stream: (options) => {
        calls.push(options)
        return (async function* stream() {
          yield { type: 'text-delta', text: answer }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
    attachments: {
      saveImage: async ({ data, mediaType, name }) => {
        calls.push({ saved: { bytes: data.length, mediaType, name } })
        return { id: 'att_test', mediaType, bytes: data.length }
      },
    },
  })
  t.after(() => setHostServicesForTest(previous))
  return calls
}

test('comfyui_describe_image is off by default and sends no request', async (t) => {
  const path = tempPath('off.png')
  writeFileSync(path, encodePng({ width: 4, height: 4, channels: 3, data: new Uint8Array(48).fill(9) }))
  const calls = withFetch(t, [{ message: { content: 'should not be called' } }])
  const answer = await describeTool.execute({ image_path: path, question: '描述这张图' }, {})
  assert.match(answer, /视觉服务默认关闭/)
  assert.match(answer, /enable_vision=true/)
  assert.equal(calls.length, 0, 'the disabled path must not touch the network')
})

test('DSH_COMFYUI_VISION turns the vision tool on for a deployment', async (t) => {
  const path = tempPath('env.png')
  writeFileSync(path, encodePng({ width: 4, height: 4, channels: 3, data: new Uint8Array(48).fill(5) }))
  const calls = withFetch(t, [{ message: { content: 'env answer' } }])
  const previous = process.env.DSH_COMFYUI_VISION
  process.env.DSH_COMFYUI_VISION = '1'
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_COMFYUI_VISION
    else process.env.DSH_COMFYUI_VISION = previous
  })
  const answer = await describeTool.execute({ image_path: path, question: '描述这张图', model: 'qwen3-vl:8b' }, {})
  assert.equal(answer, 'env answer')
  assert.equal(calls.length, 1)
})

test('an enabled describe prefers the host deepseek-v4.1-flash route', async (t) => {
  const path = tempPath('host.png')
  writeFileSync(path, encodePng({ width: 4, height: 4, channels: 3, data: new Uint8Array(48).fill(6) }))
  const calls = stubHostServices(t, {
    models: {
      'opencode-go': [{ id: 'deepseek-v4-flash', inputModalities: ['text'] }, { id: 'deepseek-v4.1-flash', inputModalities: ['text', 'image'] }],
      'deepseek-official': [{ id: 'deepseek-flash', inputModalities: ['text', 'image'] }],
    },
    answer: '一个水色的双马尾少女。',
  })
  const answer = await describeTool.execute({ image_path: path, question: '描述这张图', enable_vision: true }, {})
  assert.equal(answer, '一个水色的双马尾少女。')
  const streamed = calls.find((call) => call.provider)
  assert.equal(streamed.provider, 'opencode-go')
  assert.equal(streamed.model, 'deepseek-v4.1-flash')
  assert.equal(streamed.messages[0].content[0].type, 'text')
  assert.equal(streamed.messages[0].content[1].type, 'image')
  const saved = calls.find((call) => call.saved)
  assert.equal(saved.saved.mediaType, 'image/png')
  assert.ok(saved.saved.bytes > 0)
})

test('the host route falls back to another vision-capable model when v4.1 flash is absent', async (t) => {
  const path = tempPath('host-fallback.png')
  writeFileSync(path, encodePng({ width: 4, height: 4, channels: 3, data: new Uint8Array(48).fill(8) }))
  const calls = stubHostServices(t, {
    models: { 'deepseek-official': [{ id: 'deepseek-flash', inputModalities: ['text', 'image'] }] },
    answer: 'fallback answer',
  })
  const answer = await describeTool.execute({ image_path: path, question: '描述这张图', enable_vision: true }, {})
  assert.equal(answer, 'fallback answer')
  assert.equal(calls.find((call) => call.provider).provider, 'deepseek-official')
})

test('a host without resolveModelInfo still finds a vision model through listModels', async (t) => {
  const path = tempPath('host-list.png')
  writeFileSync(path, encodePng({ width: 4, height: 4, channels: 3, data: new Uint8Array(48).fill(3) }))
  const calls = stubHostServices(t, {
    models: { 'opencode-go': [{ id: 'deepseek-v4.1-flash', inputModalities: ['text', 'image'] }] },
    answer: 'list answer',
    resolveThrows: true,
  })
  const answer = await describeTool.execute({ image_path: path, question: '描述这张图', enable_vision: true }, {})
  assert.equal(answer, 'list answer')
  assert.equal(calls.find((call) => call.provider).model, 'deepseek-v4.1-flash')
})

test('an explicit provider/model override wins over the default route', async (t) => {
  const path = tempPath('host-override.png')
  writeFileSync(path, encodePng({ width: 4, height: 4, channels: 3, data: new Uint8Array(48).fill(2) }))
  const calls = stubHostServices(t, { answer: 'override answer' })
  const answer = await describeTool.execute({ image_path: path, question: '描述这张图', enable_vision: true, model: 'opencode-go/qwen3.8-max' }, {})
  assert.equal(answer, 'override answer')
  const streamed = calls.find((call) => call.provider)
  assert.equal(streamed.provider, 'opencode-go')
  assert.equal(streamed.model, 'qwen3.8-max')
})

test('comfyui_describe_image sends the upstream default Ollama request', async (t) => {
  const image = encodePng({ width: 4, height: 4, channels: 3, data: new Uint8Array(48).fill(7) })
  const path = tempPath('default.png')
  writeFileSync(path, image)
  const calls = withFetch(t, [{ message: { content: '一个红色方块。' } }])
  const answer = await describeTool.execute({ image_path: path, question: '这是什么颜色？', enable_vision: true, model: 'qwen3-vl:8b' }, {})
  assert.equal(answer, '一个红色方块。')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${OLLAMA_URL}/api/chat`)
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    model: 'qwen3-vl:8b',
    messages: [{ role: 'user', content: '这是什么颜色？', images: [readFileSync(path).toString('base64')] }],
    stream: false,
    options: { num_gpu: 99, num_ctx: 8192 },
  })
})

test('comfyui_describe_image falls back to llava:7b on every refusal keyword', async (t) => {
  const path = tempPath('refusal.png')
  writeFileSync(path, encodePng({ width: 4, height: 4, channels: 3, data: new Uint8Array(48).fill(1) }))
  // The single-question path uses upstream's five keywords; 健康积极 is only a
  // detail-mode keyword, so a free-form question mentioning it stays on llava.
  for (const keyword of ['无法提供', '不能', '抱歉', '不当内容', '公序良俗']) {
    const calls = withFetch(t, [{ message: { content: `${keyword}，换个问题吧。` } }, { message: { content: 'A flat coloured square.' } }])
    const answer = await describeTool.execute({ image_path: path, question: '描述这张图', enable_vision: true, model: 'qwen3-vl:8b' }, {})
    assert.equal(answer, 'A flat coloured square.', keyword)
    assert.equal(calls.length, 2)
    const retry = JSON.parse(calls[1].init.body)
    assert.equal(retry.model, 'llava:7b')
    assert.deepEqual(retry.options, { num_gpu: 99, num_ctx: 2048 })
    assert.equal(retry.messages[0].content, 'Describe this image in detail: character appearance, clothing, pose, background, art style.')
  }
})

test('a single question stays on the main model when the answer merely mentions 健康积极', async (t) => {
  const path = tempPath('benign.png')
  writeFileSync(path, encodePng({ width: 4, height: 4, channels: 3, data: new Uint8Array(48).fill(3) }))
  const calls = withFetch(t, [{ message: { content: '画面健康积极，构图良好。' } }])
  const answer = await describeTool.execute({ image_path: path, question: '描述这张图', enable_vision: true, model: 'qwen3-vl:8b' }, {})
  assert.equal(answer, '画面健康积极，构图良好。')
  assert.equal(calls.length, 1)
})

test('detail mode treats 健康积极 as a refusal', async (t) => {
  const path = tempPath('detail-refusal.png')
  writeFileSync(path, encodePng({ width: 4, height: 4, channels: 3, data: new Uint8Array(48).fill(4) }))
  const calls = withFetch(t, [{ message: { content: '健康积极的内容无法描述。' } }, { message: { content: 'english answer' } }])
  const answer = await describeTool.execute({ image_path: path, detail: true, enable_vision: true, model: 'qwen3-vl:8b' }, {})
  assert.match(answer, /english answer/)
  assert.equal(JSON.parse(calls[1].init.body).model, 'llava:7b')
})

test('comfyui_describe_image detail mode runs 11 questions and retries the English list', async (t) => {
  const path = tempPath('detail.png')
  writeFileSync(path, encodePng({ width: 4, height: 4, channels: 3, data: new Uint8Array(48).fill(2) }))
  const calls = withFetch(t, [{ message: { content: '抱歉，无法提供。' } }, { message: { content: 'answer' } }])
  const report = await describeTool.execute({ image_path: path, detail: true, enable_vision: true, model: 'qwen3-vl:8b' }, {})
  assert.equal(calls.length, 12)
  const first = JSON.parse(calls[0].init.body)
  assert.equal(first.model, 'qwen3-vl:8b')
  assert.equal(first.options.num_ctx, 8192)
  assert.ok(first.messages[0].content.endsWith('请详细列举，不要省略任何细节，分点回答。'))
  const retries = calls.slice(1).map((call) => JSON.parse(call.init.body))
  for (const retry of retries) {
    assert.equal(retry.model, 'llava:7b')
    assert.equal(retry.options.num_ctx, 2048)
  }
  assert.equal(retries[0].messages[0].content, 'Hair: exact hair color, hairstyle, length, any hair accessories?')
  assert.equal(retries[10].messages[0].content, 'Perspective: is she seen from the front, side, three-quarter view, or from behind?')
  assert.equal(report.split('\n\n')[0], '1. Hair: exact hair color, hairstyle, length, any hair accessories?\n   → answer')
  assert.equal(report.split('\n\n').length, 11)
})

test('comfyui_describe_image reports a missing Ollama model with an install hint', async (t) => {
  const path = tempPath('missing-model.png')
  writeFileSync(path, encodePng({ width: 4, height: 4, channels: 3, data: new Uint8Array(48) }))
  withFetch(t, [{ __status: 404, error: "model 'qwen3-vl:8b' not found" }])
  await assert.rejects(describeTool.execute({ image_path: path, enable_vision: true, model: 'qwen3-vl:8b' }, {}), /Ollama model "qwen3-vl:8b" is not installed — run: ollama pull qwen3-vl:8b/)
})

test('comfyui_deconfuse_image round-trips the pixel permutation and preserves metadata', async () => {
  const width = 16
  const height = 12
  const data = pattern(width, height, 3)
  const source = buildPng({
    width,
    height,
    colorType: 2,
    rows: rowsOf(data, width, 3),
    textChunks: [{ type: 'tEXt', data: Buffer.from('parameters\u0000keep me', 'utf8') }],
  })
  const input = tempPath('obfuscated.png')
  writeFileSync(input, source)

  const encrypted = await deconfuseTool.execute({ image_path: input, mode: 'enc', preserve_meta: true }, {})
  assert.equal(encrypted.times, 1)
  assert.equal(encrypted.mode, 'enc')
  assert.equal(encrypted.input, input)
  assert.ok(encrypted.output.endsWith('obfuscated_enc.png'), encrypted.output)
  assert.match(encrypted.log, /输入: /)
  assert.match(encrypted.log, /第1次混淆完成/)
  assert.match(encrypted.log, /元数据已保留/)
  assert.deepEqual(readTextMetadata(readFileSync(encrypted.output)), { parameters: 'keep me' })
  const scrambled = decodePng(readFileSync(encrypted.output))
  assert.ok(!sameBytes(scrambled.data, data), 'enc must change the pixels')
  assert.ok(sameBytes(xfqTransform({ width, height, channels: 3, data: scrambled.data }, 'dec').data, data))

  const restored = await deconfuseTool.execute({ image_path: encrypted.output, preserve_meta: true }, {})
  assert.ok(restored.output.endsWith('obfuscated_enc_dec.png'), restored.output)
  assert.deepEqual(readTextMetadata(readFileSync(restored.output)), { parameters: 'keep me' })
  assert.ok(sameBytes(decodePng(readFileSync(restored.output)).data, data), 'dec(enc(img)) must be the identity')
})

test('comfyui_deconfuse_image defaults the output name and warns without metadata', async () => {
  const width = 8
  const height = 8
  const data = pattern(width, height, 3)
  const input = tempPath('plain.png')
  writeFileSync(input, encodePng({ width, height, channels: 3, data }))
  const result = await deconfuseTool.execute({ image_path: input, times: 2, preserve_meta: true }, {})
  assert.equal(result.times, 2)
  assert.equal(result.mode, 'dec')
  assert.ok(result.output.endsWith('plain_dec.png'), result.output)
  // The input lives outside the output/state directories, so the default target
  // falls back to the state directory instead of writing beside it.
  assert.ok(result.output.startsWith(tempPath('state')), result.output)
  assert.match(result.log, /第1次解混淆完成/)
  assert.match(result.log, /第2次解混淆完成/)
  assert.match(result.log, /警告: 输入无文本元数据，直接保存/)
  assert.ok(sameBytes(decodePng(readFileSync(result.output)).data, transformTimes({ width, height, channels: 3, data }, 'dec', 2).data))
})

test('comfyui_deconfuse_image inverts two obfuscation passes and honours out_path', async () => {
  const width = 12
  const height = 12
  const data = pattern(width, height, 3, 9)
  const input = tempPath('twice.png')
  writeFileSync(input, encodePng({ width, height, channels: 3, data }))
  const out = tempPath('state/nested/dir/restored.png')
  const encrypted = await deconfuseTool.execute({ image_path: input, mode: 'enc', times: 2, out_path: tempPath('state/nested/dir/scrambled.png') }, {})
  const restored = await deconfuseTool.execute({ image_path: encrypted.output, times: 2, out_path: out }, {})
  assert.equal(restored.output, out)
  assert.ok(sameBytes(decodePng(readFileSync(out)).data, data), 'enc x2 then dec x2 must be the identity')
  await assert.rejects(deconfuseTool.execute({ image_path: tempPath('nope.png') }, {}), /file not found/)
  await assert.rejects(deconfuseTool.execute({ image_path: input, out_path: tempPath('outside.png') }, {}), /out_path must stay inside/)
  await assert.rejects(deconfuseTool.execute({ image_path: input, times: 0 }, {}), /positive integer/)
  await assert.rejects(deconfuseTool.execute({ image_path: input, times: 10_000 }, {}), /limited to/)
})

// ---------------------------------------------------------------- live smoke

test('live: comfyui_describe_image against the local Ollama', { timeout: 900_000 }, async (t) => {
  let installed = []
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5000) })
    installed = ((await response.json()).models ?? []).map((model) => model.name)
  } catch (error) {
    t.skip(`Ollama is not reachable at ${OLLAMA_URL}: ${error.message}`)
    return
  }
  const model = ['qwen3-vl:8b', 'llava:7b'].find((name) => installed.includes(name))
    ?? installed.find((name) => name.startsWith('moondream') || name.startsWith('llava') || name.startsWith('qwen3-vl'))
  if (!model) {
    t.skip(`no Ollama vision model installed (tags: ${installed.length}) — run: ollama pull qwen3-vl:8b`)
    return
  }
  const width = 64
  const height = 64
  const data = new Uint8Array(width * height * 3)
  for (let i = 0; i < data.length; i += 3) {
    data[i] = 220
    data[i + 1] = 30
    data[i + 2] = 30
  }
  const path = tempPath('live-red.png')
  writeFileSync(path, encodePng({ width, height, channels: 3, data }))
  const answer = await describeTool.execute({ image_path: path, question: '这张图片是什么颜色？请用中文简短回答。', model: model === 'qwen3-vl:8b' ? undefined : model }, {})
  assert.equal(typeof answer, 'string')
  assert.ok(answer.trim().length > 0, 'the vision model must return a non-empty description')
  t.diagnostic(`live describe (${model}): ${answer.trim().slice(0, 200)}`)
})
