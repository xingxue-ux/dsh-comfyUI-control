/**
 * dsh-comfyui-control — the DSH plugin half of this package.
 *
 * Loaded as a preset row: `name: file:///<package>/index.js`.
 */
import { apply, inject, toolList } from './lib/plugin.js'
import { defineTool, ToolArgsError, validateArgs } from './lib/tool.js'

export { apply, inject, toolList, defineTool, ToolArgsError, validateArgs }

export const name = 'dsh-comfyui-control'
