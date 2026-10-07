/**
 * Plugin activation: register every tool this package contributes.
 *
 * The plugin is mounted by the 绘图模式 agent preset only. It registers tools and
 * provides no service, so it neither leaks into the root realm nor becomes
 * visible to a session whose preset does not name it. The host services its
 * tools borrow (`llm`, `attachments`) are read through `ctx.get` and stashed in
 * `lib/services.js`, because a tool body receives execution data, not this
 * context.
 *
 * Tool definitions are built by `lib/tool.js` rather than by
 * `@deepseek-ai/dsh-tools`: the installed bundle lives where the harness
 * packages do not resolve, so importing them there is not guaranteed.
 * `test/harness-schema.test.js` proves the local compiler projects and validates
 * exactly like the harness one.
 */
import { tools as comfyuiTools } from './tools/comfyui.js'
import { tools as danbooruTools } from './tools/danbooru.js'
import { tools as civitaiTools } from './tools/civitai.js'
import { tools as visionTools } from './tools/vision.js'
import { setHostServices } from './services.js'

/** Harness services this plugin needs. */
export const inject = ['tools']

/** Every tool this package registers, in registration order. */
export function toolList() {
  return [...comfyuiTools, ...danbooruTools, ...civitaiTools, ...visionTools]
}

export function apply(ctx) {
  // The harness context always has `get`; a bare test double may not.
  setHostServices({ llm: ctx.get?.('llm'), attachments: ctx.get?.('attachments') })
  const disposers = []
  for (const tool of toolList()) disposers.push(ctx.tools.register(tool))
  ctx.logger?.info?.('dsh-comfyui-control: %d tools registered', disposers.length)
  const dispose = () => {
    for (const disposer of disposers.splice(0)) disposer()
  }
  ctx.on('dispose', dispose)
  return dispose
}
