/**
 * The upstream repro samples and the tool that replays them.
 *
 * The check is a visual one — the tool regenerates each sample and lays the
 * result beside the upstream original — so these tests cover the two things that
 * make that trustworthy: the manifest metadata matches the upstream example
 * configs, and the reference images are never fetched without consent.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// `lib/repro.js` resolves its cache directory from the environment at import
// time, so point it at a throwaway directory before it is loaded.
const STATE_DIR = mkdtempSync(join(tmpdir(), 'dsh-repro-'))
process.env.DSH_COMFYUI_STATE = STATE_DIR

const { SAMPLES_FILE, ensureReference, loadSamples, referencePath, sha256 } = await import('../lib/repro.js')
const { tools } = await import('../lib/tools/comfyui.js')

const UPSTREAM_EXAMPLES = 'E:/AI/ComfyUI/temp/good-comfyui-mcp/examples'
const reproTool = tools.find((tool) => tool.name === 'comfyui_repro_check')

test.after(() => rmSync(STATE_DIR, { recursive: true, force: true }))

test('the repro manifest pins the upstream samples with their exact metadata', () => {
  const manifest = loadSamples()
  assert.equal(manifest.upstream, 'xingxue-ux/good-comfyui-mcp')
  assert.match(manifest.upstream_ref, /^[0-9a-f]{40}$/, 'the upstream commit must be pinned')
  assert.deepEqual(manifest.samples.map((sample) => sample.name), ['repro_anima_00015', 'repro_sofa_rose'])
  assert.ok(existsSync(SAMPLES_FILE))

  for (const sample of manifest.samples) {
    // The reference URL must point at the pinned commit, never a moving branch.
    assert.ok(sample.reference.url.includes(`/${manifest.upstream_ref}/`), `${sample.name} reference is not commit-pinned`)
    assert.match(sample.reference.sha256, /^[0-9a-f]{64}$/)
    assert.equal(sample.reference.width, sample.width * 2, `${sample.name}: the pipeline upscales 2x`)
    assert.equal(sample.reference.height, sample.height * 2)
    for (const field of ['prompt', 'negative_prompt', 'lora_text']) {
      assert.equal(typeof sample[field], 'string', `${sample.name} needs ${field}`)
    }
    assert.equal(sample.steps, 30)
    assert.equal(sample.cfg, 4)
    assert.equal(sample.sampler_name, 'euler_ancestral')
    for (const lora of ['ushikani_kassen_lora-000013', 'anima-darklight-style-v1-000194', 'anima-base-1-photo-background-v4', 'RealSkin SliderV2', 'surtr945_v1']) {
      assert.match(sample.lora_text, new RegExp(lora.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    }
  }
})

test('the manifest reproduces the upstream example configs field for field', (t) => {
  if (!existsSync(join(UPSTREAM_EXAMPLES, 'repro_anima_00015.json'))) {
    t.skip('upstream checkout is not present')
    return
  }
  for (const sample of loadSamples().samples) {
    const upstream = JSON.parse(readFileSync(join(UPSTREAM_EXAMPLES, `${sample.name}.json`), 'utf8'))
    assert.equal(sample.prompt, upstream.prompt, `${sample.name}: prompt drifted`)
    assert.equal(sample.negative_prompt, upstream.negative_prompt, `${sample.name}: negative prompt drifted`)
    assert.equal(sample.seed, upstream.seed)
    assert.equal(sample.width, upstream.width)
    assert.equal(sample.height, upstream.height)
    assert.equal(sample.steps, upstream.steps)
    assert.equal(sample.cfg, upstream.cfg)
    assert.equal(sample.sampler_name, upstream.sampler_name)
    assert.equal(sample.lora_text, upstream.lora_text, `${sample.name}: LoRA weights drifted`)
  }
})

test('a missing reference image is reported instead of downloaded', async () => {
  const sample = loadSamples().samples[0]
  assert.ok(referencePath(sample).startsWith(STATE_DIR), 'references live inside the plugin state directory')
  await assert.rejects(
    () => ensureReference(sample, { allowDownload: false }),
    /allow_download=true/,
    'without consent the reference must not be fetched',
  )
})

test('a cached reference with the wrong bytes is refused', async () => {
  const sample = loadSamples().samples[0]
  const path = referencePath(sample)
  mkdirSync(join(STATE_DIR, 'repro'), { recursive: true })
  writeFileSync(path, 'not a png')
  await assert.rejects(() => ensureReference(sample, { allowDownload: false }), /不一致/)
  rmSync(path, { force: true })
})

test('sha256 matches node crypto for a known vector', () => {
  assert.equal(sha256(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

test('the repro tool defaults to no download and promises no auto-scoring', () => {
  assert.equal(reproTool.parameters.properties.allow_download.default, false)
  assert.equal(reproTool.parameters.properties.sample.type, 'string')
  assert.match(reproTool.description, /不做 MAE 之类的自动判定/)
  assert.match(reproTool.description, /allow_download/)
  assert.equal(referencePath(loadSamples().samples[1]).endsWith('ref_repro_sofa_rose.png'), true)
})
