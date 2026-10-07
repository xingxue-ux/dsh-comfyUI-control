/**
 * dsh-comfyui-control — the plugin half of this bundle, as authored.
 *
 * Loaded by the 绘图模式 preset's `comfyui-control` row as the generated
 * `lib/index.js` beside it. `tools/bundle.mjs` inlines this file and `lib/`
 * into that single file so the bundle carries no runtime dependency on the
 * harness packages, which a bundle store does not expose to a preset row.
 */
import { apply, inject, toolList } from '../../../lib/plugin.js'
import { defineTool, ToolArgsError, validateArgs } from '../../../lib/tool.js'

export { apply, inject, toolList, defineTool, ToolArgsError, validateArgs }

export const name = 'dsh-comfyui-control'
