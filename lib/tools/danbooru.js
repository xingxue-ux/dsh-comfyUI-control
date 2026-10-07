/**
 * Character tools: Danbooru tag lookup, statistical appearance lookup, cache
 * listing and the initialization checklist. All four are mounted in the
 * 绘图模式 preset and drive a local camofox-browser.
 */
import { defineTool } from '../tool.js'
import {
  SETUP_STEPS,
  listCachedCharacters,
  lookupCharacter,
  lookupCharacterAppearance,
} from '../danbooru.js'

/** `{a: 1, b: 'x'}` -> `a=1 b="x"`, undefined entries dropped. */
function inlineFields(entries) {
  return entries
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ')
}

function tagLines(value) {
  const lines = [
    `canonical_tag: ${value.canonical_tag}`,
    inlineFields([
      ['label', value.label],
      ['post_count', value.post_count],
      ['matched_query', value.matched_query === value.query ? undefined : value.matched_query],
      ['category', value.category],
    ]),
    `wiki_url: ${value.wiki_url}`,
  ]
  if (value.aliases?.length) lines.push(`aliases: ${value.aliases.join(', ')}`)
  if (value.implicates?.length) lines.push(`implicates: ${value.implicates.join(', ')}`)
  if (value.localized_names?.length) lines.push(`localized_names: ${value.localized_names.join(', ')}`)
  if (value.candidates?.length) lines.push(`candidates: ${value.candidates.map((c) => `${c.value}(${c.post_count})`).join(', ')}`)
  if (value.description) lines.push('', 'description:', value.description)
  return lines.filter((line) => line !== undefined).join('\n')
}

export const tools = [
  defineTool({
    name: 'comfyui_lookup_character_tags',
    description: '查询角色在 Danbooru 上的标签（通过本地 camofox 浏览器，按角色缓存 30 天）。返回规范标签 canonical_tag（形如 your_character_tag_(your_series)）、别名 aliases、投稿数 post_count 与 wiki 描述 description，用于拼写提示词。首次使用某个角色时调用本工具，然后组装提示词，并在调用 comfyui_generate 之前先与用户确认提示词。',
    parameters: {
      character: { type: 'string', required: true, description: '角色名，中文、日文或英文均可，例如 "初音未来" 或 "hatsune miku"' },
      force_refresh: { type: 'boolean', description: '忽略缓存强制重新查询（默认 false）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: tagLines(value) }],
    },
    async execute(args, exec) {
      return lookupCharacter(args.character, args.force_refresh === true)
    },
  }),

  defineTool({
    name: 'comfyui_lookup_character_appearance',
    description: '统计推断角色的真实外貌标签：抓取该角色最近 solo 投稿（通过 camofox），统计哪些标签最常共现（发色、瞳色、服装、特征）。组装提示词时用返回的 top tags，不要凭印象猜。结果与 comfyui_lookup_character_tags 一样缓存。',
    parameters: {
      character: { type: 'string', required: true, description: '角色名，中文、日文或英文均可' },
      sample: { type: 'integer', description: '统计的 solo 投稿数量，默认 50；越大越准但越慢' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const top = (value.top_tags ?? []).map((entry) => `${entry.tag}(${entry.count})`).join(', ')
        return [{
          type: 'text',
          text: `canonical_tag: ${value.canonical_tag}\nsample_size: ${value.sample_size}\n` +
            `appearance_tags: ${(value.appearance_tags ?? []).join(', ')}\n` +
            `top_tags: ${top}`,
        }]
      },
    },
    async execute(args, exec) {
      return lookupCharacterAppearance(args.character, args.sample ?? 50)
    },
  }),

  defineTool({
    name: 'comfyui_list_cached_characters',
    description: '列出已经查过的角色（只读本地缓存，不联网）。在不确定某个角色是否查过、或想复用已有 canonical_tag 时调用。',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{
        type: 'text',
        text: value.length === 0
          ? '（缓存为空：还没有查过任何角色）'
          : value.map((entry) => `${entry.canonical_tag} <= ${entry.query} (${entry.post_count ?? 0})`).join('\n'),
      }],
    },
    async execute() {
      return listCachedCharacters()
    },
  }),

  defineTool({
    name: 'comfyui_setup_guide',
    description: '初始化引导清单：启用本插件后需要完成的步骤（每步含操作/验证/是否必需）。配合 comfyui_status 使用：先调 comfyui_status 拿 missing 列表，再按本清单逐项引导用户完成初始化（缺哪步做哪步，做完重新调 comfyui_status 验证）。',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{
        type: 'text',
        text: value.map((step) => `[${step.required ? '必需' : '可选'}] ${step.step}. ${step.title}\n  操作：${step.action}\n  验证：${step.verify}`).join('\n'),
      }],
    },
    async execute() {
      return SETUP_STEPS
    },
  }),
]
