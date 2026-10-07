/**
 * Plugin activation: register every tool this package contributes.
 *
 * The plugin is mounted by the 绘图模式 agent preset only. It registers on
 * `ctx.tools` and provides no service, so it neither leaks into the root realm
 * nor becomes visible to a session whose preset does not name it.
 *
 * Tool definitions are built by `lib/tool.js` rather than by
 * `@deepseek-ai/dsh-tools`: a user preset under `~/.dsh/.agent-presets` is
 * outside Node's upward `node_modules` walk of the harness, so importing a
 * harness package there is not guaranteed to resolve. `test/harness-schema.test.js`
 * proves the local compiler projects and validates exactly like the harness one.
 */
import { tools as comfyuiTools } from './tools/comfyui.js'
import { tools as danbooruTools } from './tools/danbooru.js'
import { tools as civitaiTools } from './tools/civitai.js'
import { tools as visionTools } from './tools/vision.js'

/** Harness service this plugin needs. */
export const inject = ['tools']

/** Every tool this package registers, in registration order. */
export function toolList() {
  return [...comfyuiTools, ...danbooruTools, ...civitaiTools, ...visionTools]
}

export function apply(ctx) {
  const disposers = []
  for (const tool of toolList()) disposers.push(ctx.tools.register(tool))
  ctx.logger?.info?.('dsh-comfyui-control: %d tools registered', disposers.length)
  const dispose = () => {
    for (const disposer of disposers.splice(0)) disposer()
  }
  ctx.on('dispose', dispose)
  return dispose
}
