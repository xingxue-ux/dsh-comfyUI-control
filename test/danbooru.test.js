/**
 * Unit tests for lib/danbooru.js.
 *
 * `lib/env.js` resolves `DSH_COMFYUI_STATE` at import time, so the tests point
 * it at a temp dir before importing and then swap `danbooru.camofox` (the one
 * place the module reaches the browser) to drive every lookup path offline.
 * Only the last test talks to a real service, and it skips itself when
 * camofox-browser is down.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const STATE = mkdtempSync(join(tmpdir(), 'dsh-danbooru-'))
process.env.DSH_COMFYUI_STATE = STATE
const CACHE = join(STATE, 'cache')

const danbooru = await import('../lib/danbooru.js')
const { CACHE_TTL_DAYS, CAMOFOX_URL } = await import('../lib/env.js')

/** The real browser surface, checked once so no test can silently stub it away. */
assert.equal(typeof danbooru.camofox.healthy, 'function')

after(() => rmSync(STATE, { recursive: true, force: true }))

const DAY_MS = 86400000
const OFFLINE = new Error('offline: no browser in this test')
const sha1_12 = (name) => createHash('sha1').update(name, 'utf8').digest('hex').slice(0, 12)

const CACHED = {
  query: 'Hatsune Miku',
  canonical_tag: 'hatsune_miku',
  matched_query: 'hatsune miku',
  label: 'Hatsune Miku',
  post_count: 1,
  category: 4,
  candidates: [],
  description: '',
  aliases: [],
  implicates: [],
  localized_names: [],
  wiki_url: 'https://danbooru.donmai.us/wiki_pages/hatsune_miku',
}

/** Replace the module's camofox surface for the rest of one test. */
function stubCamofox(t, stubs) {
  const originals = {}
  for (const [key, value] of Object.entries(stubs)) {
    originals[key] = danbooru.camofox[key]
    danbooru.camofox[key] = value
  }
  t.after(() => {
    for (const [key, value] of Object.entries(originals)) danbooru.camofox[key] = value
  })
}

/** A browser stub that understands the two page expressions the module issues. */
function browser(t, { autocomplete, wiki, onEvaluate }) {
  const calls = []
  stubCamofox(t, {
    ensure: async () => 'online',
    tab: async () => { calls.push('tab'); return 'test-tab' },
    close: async () => { calls.push('close') },
    navigate: async (tabId, url) => { calls.push(`navigate ${url}`) },
    evaluate: async (tabId, expression) => {
      calls.push(expression)
      if (onEvaluate) return onEvaluate(expression)
      if (expression.includes('autocomplete.json')) {
        const answer = typeof autocomplete === 'function' ? autocomplete(expression) : autocomplete
        return JSON.stringify(answer)
      }
      return JSON.stringify({ body: wiki.body, content: wiki.content })
    },
  })
  return calls
}

const cacheFile = (name) => join(CACHE, `${name}.json`)

function writeCache(name, value, ageMs = 0) {
  mkdirSync(CACHE, { recursive: true })
  const path = cacheFile(name)
  writeFileSync(path, JSON.stringify(value), 'utf8')
  if (ageMs > 0) utimesSync(path, (Date.now() - ageMs) / 1000, (Date.now() - ageMs) / 1000)
  return path
}

test('cacheSlug keeps CJK and hashes symbol-only names', () => {
  assert.equal(danbooru.cacheSlug('Hatsune Miku'), 'hatsune_miku')
  assert.equal(danbooru.cacheSlug('  varesa (genshin impact) '), 'varesa_genshin_impact')
  assert.equal(danbooru.cacheSlug('初音未来'), '初音未来')
  // katakana falls outside the upstream [\u4e00-\u9fff] keep-range, so only the
  // CJK prefix survives as the slug
  assert.equal(danbooru.cacheSlug('初音ミク'), '初音')
  assert.notEqual(danbooru.cacheSlug('初音未来'), danbooru.cacheSlug('初音ミク'))
  assert.equal(danbooru.cacheSlug('!!!'), sha1_12('!!!'))
  assert.equal(danbooru.cacheSlug('@#$'), sha1_12('@#$'))
  assert.equal(danbooru.cacheSlug('!!!'), danbooru.cacheSlug('!!!'))
  assert.notEqual(danbooru.cacheSlug('!!!'), danbooru.cacheSlug('???'))
  assert.match(danbooru.cacheSlug('...'), /^[0-9a-f]{12}$/)
})

test('parseWiki trims the description at the first trailing marker', () => {
  const body = 'Hatsune Miku is a VOCALOID.\n\nShe has aqua twintails.\n\nPosts\nTerms\nPosts\nArtists\n\nSee also\nOther Miku\n'
  const parsed = danbooru.parseWiki({ body, content: '' }, 'hatsune_miku')
  assert.equal(parsed.description, 'Hatsune Miku is a VOCALOID.\nShe has aqua twintails.')
  assert.deepEqual(parsed.aliases, [])
  assert.deepEqual(parsed.implicates, [])
  assert.deepEqual(parsed.localized_names, [])

  assert.equal(danbooru.parseWiki({ body: 'A character.\n\nSee also\nOther', content: '' }, 'x').description, 'A character.')
  assert.equal(danbooru.parseWiki({ body: 'A character.\n\nExternal links\nSomewhere', content: '' }, 'x').description, 'A character.')
  // in the upstream order "Posts\nTerms" wins over the later markers
  assert.equal(danbooru.parseWiki({ body: 'A.\n\nSee also\nB.\n\nPosts\nTerms\nC.', content: '' }, 'x').description, 'A.')
  // blank pages stay blank instead of throwing
  assert.deepEqual(danbooru.parseWiki({}, 'x'), { description: '', aliases: [], implicates: [], localized_names: [] })
})

test('parseWiki reads aliases, implicates and localized names', () => {
  const content = [
    'hatsune miku',
    '初音ミク',
    '初音未来',
    'Default',
    'miku',
    '',
    'hatsune_miku is aliased to this tag: miku',
    'this tag is aliased to this tag: vocaloid_miku and_not_this',
    'hatsune_miku implicate this tag: vocaloid, project_diva',
    'Hatsune Miku is a VOCALOID.',
  ].join('\n')
  const parsed = danbooru.parseWiki({ body: 'desc', content }, 'hatsune_miku')
  assert.equal(parsed.description, 'desc')
  assert.deepEqual(parsed.aliases, ['miku', 'vocaloid_miku'])
  // the upstream regex takes only the first name of an "implicate this tag:" list
  assert.deepEqual(parsed.implicates, ['vocaloid'])
  // stops at the blank line right after the title block
  assert.deepEqual(parsed.localized_names, ['初音ミク', '初音未来'])
})

test('parseWiki keeps localized names when there is no Default line', () => {
  const content = ['varesa (genshin impact)', '瓦雷莎', 'Varesa', 'ヴァレサ', '', 'desc'].join('\n')
  assert.deepEqual(danbooru.parseWiki({ body: '', content }, 'varesa_(genshin_impact)').localized_names,
    ['瓦雷莎', 'Varesa', 'ヴァレサ'])
  // no title line in #content -> no localized names
  assert.deepEqual(danbooru.parseWiki({ body: '', content: 'nothing here' }, 'hatsune_miku').localized_names, [])
})

test('characterFromPrompt extracts the danbooru-style tag only', () => {
  assert.equal(danbooru.characterFromPrompt('1girl, solo, hatsune_miku_(vocaloid), smile'), 'hatsune_miku_(vocaloid)')
  assert.equal(danbooru.characterFromPrompt('varesa_(genshin_impact), 1girl'), 'varesa_(genshin_impact)')
  assert.equal(danbooru.characterFromPrompt('master, 1girl'), undefined)
  assert.equal(danbooru.characterFromPrompt(''), undefined)
})

test('findCachedCharacter matches canonical_tag or query and skips appearance files', () => {
  const entry = { ...CACHED, query: '初音未来' }
  writeCache('初音未来', entry)
  writeCache('hatsune_miku.appearance', { canonical_tag: 'hatsune_miku' })
  writeFileSync(join(CACHE, '.hidden.json'), JSON.stringify(entry), 'utf8')
  writeFileSync(join(CACHE, 'broken.json'), '{not json', 'utf8')

  assert.deepEqual(danbooru.findCachedCharacter('HATSUNE_MIKU'), entry)
  assert.deepEqual(danbooru.findCachedCharacter('初音未来'), entry)
  assert.equal(danbooru.findCachedCharacter('kagamine_rin'), undefined)
  // the appearance file must not answer as a character
  assert.deepEqual(danbooru.listCachedCharacters().map((row) => row.canonical_tag), ['hatsune_miku'])
  assert.deepEqual(danbooru.listCachedCharacters()[0], { query: '初音未来', canonical_tag: 'hatsune_miku', post_count: 1 })
})

test('rankAppearance applies the skip set and the sample threshold', () => {
  const sample = 20
  const posts = []
  for (let i = 0; i < sample; i++) {
    const tags = ['hatsune_miku', 'solo', '1girl', 'absurdres', 'commentary', 'translated']
    if (i < 12) tags.push('aqua_hair')
    if (i < 10) tags.push('aqua_eyes')
    if (i < 7) tags.push('twintails')
    if (i < 5) tags.push('necktie')
    tags.push('long_hair')
    posts.push({ tag_string: tags.join(' ') })
  }
  const result = danbooru.rankAppearance(posts, 'hatsune_miku', sample)
  const counts = new Map(result.top_tags.map((entry) => [entry.tag, entry.count]))
  assert.equal(result.canonical_tag, 'hatsune_miku')
  assert.equal(result.sample_size, sample)
  assert.equal(counts.get('aqua_hair'), 12)
  assert.equal(counts.get('aqua_eyes'), 10)
  assert.equal(counts.get('twintails'), 7)
  assert.equal(counts.get('necktie'), 5)
  assert.equal(counts.get('long_hair'), 20)
  // descending by count
  assert.deepEqual(result.top_tags.map((entry) => entry.count).slice(0, 4), [20, 12, 10, 7])
  // 0.3 * 20 == 6 -> aqua_hair/aqua_eyes/twintails/long_hair pass, necktie does not
  assert.deepEqual(result.appearance_tags, ['long_hair', 'aqua_hair', 'aqua_eyes', 'twintails'])
  for (const skipped of ['hatsune_miku', 'solo', '1girl', 'genshin_impact', 'absurdres', 'highres', 'commentary', 'commentary_request', 'translated', 'multiple_girls', 'multi_girl']) {
    assert.equal(counts.has(skipped), false, `${skipped} must be skipped`)
  }

  const many = Array.from({ length: 30 }, (_, i) => ({ tag_string: `t${i}` }))
  assert.equal(danbooru.rankAppearance(many, 'c', 30).top_tags.length, 25)
  assert.deepEqual(danbooru.rankAppearance([], 'c', 0), { canonical_tag: 'c', sample_size: 0, appearance_tags: [], top_tags: [] })
})

test('lookupCharacter honours the 30-day cache TTL and the query consistency check', async (t) => {
  writeCache('hatsune_miku', CACHED)
  const tabs = []
  stubCamofox(t, {
    ensure: async () => 'online',
    tab: async () => { tabs.push('tab'); return 'test-tab' },
    close: async () => {},
    evaluate: async () => { throw OFFLINE },
  })

  // fresh cache, case-insensitive query match -> served from disk
  assert.deepEqual(await danbooru.lookupCharacter('hatsune miku'), CACHED)
  assert.deepEqual(tabs, [])

  // one day past the TTL -> the cache no longer counts
  writeCache('hatsune_miku', CACHED, (CACHE_TTL_DAYS + 1) * DAY_MS)
  await assert.rejects(() => danbooru.lookupCharacter('hatsune miku'), OFFLINE)
  assert.equal(tabs.length, 1)

  // fresh again but written for another character -> consistency check fails
  writeCache('hatsune_miku', { ...CACHED, query: 'kagamine_rin' })
  await assert.rejects(() => danbooru.lookupCharacter('hatsune miku'), OFFLINE)
  assert.equal(tabs.length, 2)

  // force_refresh ignores even a valid entry
  writeCache('hatsune_miku', CACHED)
  await assert.rejects(() => danbooru.lookupCharacter('hatsune miku', true), OFFLINE)
  assert.equal(tabs.length, 3)
})

test('lookupCharacter writes the upstream cache shape', async (t) => {
  const autocomplete = [
    { label: 'Hatsune Miku', value: 'hatsune_miku', post_count: 314159, category: 4 },
    { label: 'Miku (other)', value: 'miku_other', post_count: 12, category: 4 },
    { label: 'miku', value: 'miku', post_count: 7, category: 0 },
    { label: 'miku (x)', value: 'miku_x', post_count: 3, category: 4 },
  ]
  const calls = browser(t, {
    autocomplete,
    wiki: {
      body: 'Hatsune Miku is a VOCALOID.\n\nPosts\nTerms\n',
      content: ['hatsune miku', '初音ミク', 'Default', 'hatsune_miku is aliased to this tag: miku'].join('\n'),
    },
  })

  rmSync(cacheFile('hatsune_miku'), { force: true })
  const result = await danbooru.lookupCharacter('hatsune miku')
  assert.deepEqual(Object.keys(result), [
    'query', 'matched_query', 'canonical_tag', 'label', 'post_count', 'category', 'candidates',
    'description', 'aliases', 'implicates', 'localized_names', 'wiki_url',
  ])
  assert.equal(result.query, 'hatsune miku')
  assert.equal(result.matched_query, 'hatsune miku')
  assert.equal(result.canonical_tag, 'hatsune_miku')
  assert.equal(result.label, 'Hatsune Miku')
  assert.equal(result.post_count, 314159)
  assert.equal(result.category, 4)
  // category 4 preferred over the category-0 miku tag
  assert.deepEqual(result.candidates.map((entry) => entry.value), ['hatsune_miku', 'miku_other', 'miku_x'])
  assert.equal(result.description, 'Hatsune Miku is a VOCALOID.')
  assert.deepEqual(result.aliases, ['miku'])
  assert.deepEqual(result.implicates, [])
  assert.deepEqual(result.localized_names, ['初音ミク'])
  assert.equal(result.wiki_url, 'https://danbooru.donmai.us/wiki_pages/hatsune_miku')
  // the query travels percent-encoded inside the page fetch
  const autocompleteCall = calls.find((entry) => entry.includes('autocomplete.json'))
  assert.match(autocompleteCall, /search%5Bquery%5D=hatsune%20miku&search%5Btype%5D=tag/)
  // the wiki body expression slices both page bodies to 6000 chars
  const wikiCall = calls.find((entry) => entry.includes('#wiki-page-body'))
  assert.match(wikiCall, /innerText\.slice\(0, 6000\)/)
  assert.ok(calls.includes('navigate https://danbooru.donmai.us/wiki_pages/hatsune_miku'))
  assert.deepEqual(calls.filter((entry) => entry === 'tab'), ['tab'])
  assert.deepEqual(calls.filter((entry) => entry === 'close'), ['close'])
  // the second call is served from the cache written above
  assert.deepEqual(await danbooru.lookupCharacter('Hatsune Miku'), result)
  assert.deepEqual(JSON.parse(readFileSync(cacheFile('hatsune_miku'), 'utf8')), result)
})

/** The query an autocomplete page expression asked for. */
function askedQuery(expression) {
  return decodeURIComponent(expression.split('search%5Bquery%5D=')[1].split('&')[0])
}

test('lookupCharacter retries with the first word and caps candidates at 8', async (t) => {
  const many = Array.from({ length: 12 }, (_, i) => ({ label: `m${i}`, value: `m${i}`, post_count: i, category: 4 }))
  const calls = browser(t, {
    autocomplete: (expression) => {
      const query = askedQuery(expression)
      if (query === 'hatsune miku typo') return []
      return query.startsWith('z') ? [] : many
    },
    wiki: { body: '', content: '' },
  })
  rmSync(cacheFile('hatsune_miku_typo'), { force: true })

  const retried = await danbooru.lookupCharacter('hatsune miku typo')
  assert.equal(retried.query, 'hatsune miku typo')
  assert.equal(retried.matched_query, 'hatsune')
  assert.deepEqual(retried.candidates.map((entry) => entry.value), many.slice(0, 8).map((entry) => entry.value))
  const queries = calls.filter((entry) => entry.includes('autocomplete.json'))
  assert.equal(queries.length, 2)
  assert.match(queries[0], /search%5Bquery%5D=hatsune%20miku%20typo&/)
  assert.match(queries[1], /search%5Bquery%5D=hatsune&/)

  // a single word is never retried, and the miss names the query the user gave
  await assert.rejects(() => danbooru.lookupCharacter('zzzz'), /no tags found for 'zzzz'/)
  assert.equal(calls.filter((entry) => entry.includes('autocomplete.json')).length, 3)
})

test('lookupCharacter falls back to non-character tags when category 4 is absent', async (t) => {
  browser(t, {
    autocomplete: [{ label: 'miku', value: 'miku', post_count: 7, category: 0 }],
    wiki: { body: '', content: '' },
  })
  const result = await danbooru.lookupCharacter('miku alias')
  assert.equal(result.canonical_tag, 'miku')
  assert.equal(result.category, 0)
})

test('lookupCharacterAppearance reuses the cache and reaches camofox on a miss', async (t) => {
  writeCache('hatsune_miku', { query: 'hatsune miku', canonical_tag: 'hatsune_miku' })
  writeCache('hatsune_miku.appearance', { canonical_tag: 'hatsune_miku', sample_size: 3, appearance_tags: ['aqua_hair'], top_tags: [{ tag: 'aqua_hair', count: 3 }] })
  const tabs = []
  stubCamofox(t, {
    ensure: async () => 'online',
    tab: async () => { tabs.push('tab'); return 'test-tab' },
    close: async () => {},
    evaluate: async () => { throw OFFLINE },
  })

  const cached = await danbooru.lookupCharacterAppearance('hatsune miku')
  assert.deepEqual(cached.appearance_tags, ['aqua_hair'])
  assert.deepEqual(tabs, [])

  rmSync(cacheFile('hatsune_miku.appearance'), { force: true })
  await assert.rejects(() => danbooru.lookupCharacterAppearance('hatsune miku'), OFFLINE)
  assert.equal(tabs.length, 1)
})

test('lookupCharacterAppearance ranks a fetched page and caches it', async (t) => {
  writeCache('megurine_luka', { query: 'megurine luka', canonical_tag: 'megurine_luka' })
  rmSync(cacheFile('megurine_luka.appearance'), { force: true })
  const calls = browser(t, {
    autocomplete: [],
    wiki: { body: '', content: '' },
    onEvaluate: (expression) => expression.includes('autocomplete.json')
      ? JSON.stringify([])
      : JSON.stringify(Array.from({ length: 4 }, (_, i) => ({ tag_string: `megurine_luka solo 1girl aqua_eyes t${i}` }))),
  })

  const result = await danbooru.lookupCharacterAppearance('megurine luka', 4)
  assert.equal(result.canonical_tag, 'megurine_luka')
  assert.equal(result.sample_size, 4)
  assert.equal(result.appearance_tags.includes('aqua_eyes'), true)
  assert.equal(result.appearance_tags.includes('solo'), false)
  assert.match(calls.find((entry) => entry.includes('posts.json')), /tags=megurine_luka%20solo&limit=500&page=1/)
  assert.deepEqual(JSON.parse(readFileSync(cacheFile('megurine_luka.appearance'), 'utf8')), result)
  // a cached appearance result never reaches the network again
  const cached = await danbooru.lookupCharacterAppearance('megurine luka', 4)
  assert.deepEqual(cached, result)
  assert.equal(calls.filter((entry) => entry.includes('posts.json')).length, 1)
})

test('SETUP_STEPS is the 9-step DSH checklist', () => {
  const steps = danbooru.SETUP_STEPS
  assert.equal(steps.length, 9)
  assert.deepEqual(steps.map((step) => step.step), [1, 2, 3, 4, 5, 6, 7, 8, 9])
  for (const step of steps) {
    assert.deepEqual(Object.keys(step), ['step', 'title', 'action', 'required', 'verify'])
    for (const field of ['title', 'action', 'verify']) assert.equal(typeof step[field], 'string')
    assert.equal(typeof step.required, 'boolean')
    assert.doesNotMatch(`${step.action} ${step.verify}`, /pip install|import mcp|requirements\.txt/)
  }
  // 8899 is required; Civitai credentials and the vision service are not.
  const viewer = steps.find((step) => step.title.includes('8899'))
  assert.ok(viewer, 'the checklist names the required 8899 server')
  assert.equal(viewer.required, true)
  assert.match(viewer.action, /serve-compare/)
  assert.deepEqual(steps.filter((step) => !step.required).map((step) => step.step), [7, 8])
  assert.equal(steps[0].title.includes('无 Python 依赖'), true)
  for (const name of ['comfyui_status', 'comfyui_generate']) {
    assert.ok(steps.some((step) => step.action.includes(name) || step.verify.includes(name)), `checklist must name ${name}`)
  }
  assert.equal(danbooru.DANBOORU_CAMOFOX_USER, 'dsh_comfyui_control')
  assert.equal(danbooru.DANBOORU_CAMOFOX_SESSION, 'main')
})

test('camofoxHealthy reports the live browser and a live lookup resolves a canonical tag', async (t) => {
  let health
  try {
    health = await (await fetch(`${CAMOFOX_URL}/health`, { signal: AbortSignal.timeout(5000) })).json()
  } catch {
    t.skip(`camofox-browser is not reachable at ${CAMOFOX_URL}`)
    return
  }
  if (health?.ok !== true) {
    t.skip(`camofox-browser health was not ok: ${JSON.stringify(health)}`)
    return
  }

  assert.equal(await danbooru.camofoxHealthy(), true)
  rmSync(cacheFile('hatsune_miku'), { force: true })
  const info = await danbooru.lookupCharacter('hatsune miku')
  t.diagnostic(`LIVE canonical_tag=${info.canonical_tag} post_count=${info.post_count} matched_query=${info.matched_query}`)
  t.diagnostic(`LIVE candidates=${info.candidates.map((entry) => entry.value).join(',')}`)
  t.diagnostic(`LIVE localized_names=${JSON.stringify(info.localized_names)}`)
  t.diagnostic(`LIVE description=${info.description.slice(0, 160)}`)
  assert.equal(typeof info.canonical_tag, 'string')
  assert.ok(info.canonical_tag.length > 0)
  assert.equal(info.query, 'hatsune miku')
  assert.equal(info.wiki_url, `https://danbooru.donmai.us/wiki_pages/${info.canonical_tag}`)
  assert.ok(info.description.length > 0)
  assert.ok(info.candidates.length > 0)
  assert.equal(danbooru.findCachedCharacter('hatsune miku').canonical_tag, info.canonical_tag)

  rmSync(cacheFile('hatsune_miku.appearance'), { force: true })
  const appearance = await danbooru.lookupCharacterAppearance('hatsune miku', 12)
  t.diagnostic(`LIVE appearance sample_size=${appearance.sample_size} tags=${appearance.appearance_tags.join(',')}`)
  assert.equal(appearance.canonical_tag, info.canonical_tag)
  assert.ok(appearance.top_tags.length > 0)
})
