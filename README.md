# dsh-comfyUI-control

[![npm](https://img.shields.io/npm/v/dsh-comfyui-control.svg)](https://www.npmjs.com/package/dsh-comfyui-control)
[![license](https://img.shields.io/npm/l/dsh-comfyui-control.svg)](LICENSE)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）**0.2 bundle**：
把本地 ComfyUI 接进一个名为 **绘图模式** 的 Agent 预设里，完整复刻
[`xingxue-ux/good-comfyui-mcp`](https://github.com/xingxue-ux/good-comfyui-mcp) 的 13 个工具，
并补齐 ComfyUI 控制面，共 **18 个 `comfyui_*` 工具**。

安装：`dsh plugin add --profile <profile> dsh-comfyui-control`（见[安装](#安装)）。

**只在「绘图模式」预设里生效**：标准模式、极简模式、PTC 模式、创造模式等其他预设都不挂载这个插件，
也就看不到任何 `comfyui_*` 工具。

零运行时依赖：只用 Node 内置模块 + 全局 `fetch`，不需要 pip、不需要常驻 Python MCP 进程。

> **0.2 与旧版预设机制的区别（重要）**
> DSH 0.1 从 `$DSH_HOME/.agent-presets/<id>/` 读取用户预设；**0.2 已经不再读这个目录**。
> 0.2 的预设是 bundle patch 里的 `@deepseek-ai/dsh-agent-preset` 声明，必须用
> `plugin_manager` 安装 bundle 才能出现在预设选择器里。本包就是按 0.2 机制交付的。

## 功能（18 个工具）

| 工具 | 说明 | 对应上游 |
|---|---|---|
| `comfyui_status` | 依赖自检：ComfyUI / 管线模型 / **8899 对比页服务** / camofox / Civitai 凭据 / 视觉服务状态，返回 `missing[]` 与 `on_demand[]` | `server_info` |
| `comfyui_setup_guide` | 初始化清单（每步含操作 / 验证 / 是否必需） | `setup_guide` |
| `comfyui_get_model_guide` | Anima 官方用法：模型版本、采样参数、提示词规则、限制 | `get_model_guide` |
| `comfyui_list_models` | 列出 ComfyUI 各模型目录（loras / diffusion_models / text_encoders / vae / upscale_models …） | — |
| `comfyui_generate` | 出图：Anima 管线（默认）或 Krea2 引擎；可覆盖 steps/cfg/sampler/尺寸/seed；参考图自动生成对比页 | `generate` |
| `comfyui_run_workflow` | 提交任意 workflow JSON 并等待结果 | — |
| `comfyui_history` | 历史记录查询与 `mcp`/`manual` 来源标注 | — |
| `comfyui_queue` | 队列查看 / 中断 / 清空 | — |
| `comfyui_node_info` | 节点输入输出定义查询 | — |
| `comfyui_extract_image_info` | PNG 元数据解析：ComfyUI prompt/workflow、WebUI parameters、LoRA 配置 | `extract_image_info` |
| `comfyui_describe_image` | 识图，**默认关闭**（你通常已有多模态模型，直接读图）；显式 `enable_vision=true` 后优先用宿主视觉模型 `deepseek-v4.1-flash`，Ollama 为可选的本地回退（qwen3-vl:8b → llava:7b，`detail` 11 问模式） | `describe_image` |
| `comfyui_deconfuse_image` | 小番茄（Gilbert 曲线）混淆图还原，可 `enc`/`dec` 多次 | `deconfuse_image` |
| `comfyui_lookup_character_tags` | Danbooru 角色规范 tag（camofox 反检测浏览器，30 天缓存） | `lookup_character_tags` |
| `comfyui_lookup_character_appearance` | 角色外貌 tag 统计（solo 图 tag 频率） | `lookup_character_appearance` |
| `comfyui_list_cached_characters` | 已缓存角色列表（离线） | `list_cached_characters` |
| `comfyui_search_lora` | Civitai LoRA 精确版搜索（网页搜索端点 models_v9，比 API 全） | `search_lora` |
| `comfyui_download_lora` | Civitai 下载 + safetensors 头校验 | `download_lora` |
| `comfyui_lookup_lora_hash` | 本地文件 SHA256 → by-hash 反查精确来源 | `lookup_lora_hash` |

## 安装

已发布到 npm：**[`dsh-comfyui-control`](https://www.npmjs.com/package/dsh-comfyui-control)**（`dsh.bundle.patch` 已声明，装进 profile 即自动成为一层 bundle）。

### 方式一：npm / dsh plugin add（推荐）

```bash
dsh plugin add --profile <你的 profile> dsh-comfyui-control
```

它做三件事：pnpm 把包装进 `<DSH_HOME>/profiles/<profile>/node_modules/`、写完 `package.json` 依赖、
并把 `dsh-comfyui-control` 追加到该 profile 的 `dsh.profile.bundles`。装完重启 DSH 即可。

也可以手动把包放进 profile：在 profile 目录跑 `npm i dsh-comfyui-control`（或 `pnpm add`），
再在 `package.json` 的 `dsh.profile.bundles` 里加上 `"dsh-comfyui-control"`。

### 方式二：本地目录

```bash
git clone https://github.com/xingxue-ux/dsh-comfyUI-control
```

对 Agent 说：

> 用 plugin_manager 安装 `E:\AI\ComfyUI\dsh-comfyUI-control` 这个 bundle（action: install_bundle）。

也可以在「设置 → 插件」里安装同一个目录。

### 选择预设

预设名 **绘图模式**（id `drawing`）。装完后 `plugin_manager` 的 `list_bundles` 会列出这个 bundle，
`list_plugins` 里会出现 `preset-drawing` 行。在 Agent 预设选择器里选 **绘图模式**，或设为默认预设后新建会话。

> 预设只对**新会话**生效；已在运行的会话保持启动时的插件版本。

### 环境依赖

| 依赖 | 必需 | 说明 |
|---|---|---|
| ComfyUI（默认 `http://127.0.0.1:8188`） | ✅ | 出图与模型列表 |
| Anima 管线模型 | ✅ | `anima-base-v1.0.safetensors`（`models/diffusion_models/`）、`qwen_3_06b_base.safetensors`（`models/text_encoders/`）、`qwen_image_vae.safetensors`（`models/vae/`）、`RealESRGAN_x2plus.pth`（`models/upscale_models/`，开 `upscale` 时用） |
| 默认 5 件套 LoRA | ✅（默认挂载） | 见下节；缺了就用 `comfyui_search_lora` + `comfyui_download_lora` 拉 |
| **8899 对比页服务** | ✅ | 出图返回的 `view_url` 指向它。启动：`npm run serve-compare`（即 `node tools/serve-compare.mjs`，只读服务 `<DSH_HOME>/storages/dsh-comfyui-control/compare/`）；没启动时 `comfyui_status` 会把它列进必需项并从 `missing[]` 报告，`comfyui_generate` 也会在结果里带 `view_warning` |
| camofox-browser（默认 `http://127.0.0.1:9377`） | 可选 | `npm install -g @askjo/camofox-browser && camofox-browser`；不装则角色 tag / 外貌统计不可用 |
| Civitai 凭据 | 可选 | `CIVITAI_TOKEN`（下载）、`CIVITAI_SEARCH_KEY`（搜索）；不配时 by-hash 反查仍可用 |
| 视觉服务 | 可选（默认关闭） | `comfyui_describe_image` 默认不发请求 —— 你通常就是多模态模型，直接读图即可。需要时传 `enable_vision=true`，默认走宿主视觉模型 `deepseek-v4.1-flash`（opencode-go），用不到 Ollama；想走本地 Ollama 则传 `model=qwen3-vl:8b` 并先 `ollama pull qwen3-vl:8b`（+ `llava:7b` 作为 NSFW 回退） |

装好后在新会话里先调 `comfyui_status`，它会返回 `missing[]` 逐项告诉你缺什么。

### 默认 5 件套 LoRA

`comfyui_generate` 不传 `lora_text` 时自动挂载（传 `lora_text=""` 显式空载）：

| LoRA | 权重 | 用途 |
|---|---|---|
| `ushikani_kassen_lora-000013.safetensors` | 0.3 | 画风 |
| `anima-darklight-style-v1-000194.safetensors` | 0.3 | 朦胧氛围 |
| `anima-base-1-photo-background-v4.safetensors` | 0.6 | 写实背景 |
| `RealSkin SliderV2.safetensors` | 0.8 | 写实皮肤 |
| `surtr945_v1.safetensors` | 0.8 | 画风 |

## 配置

全部通过环境变量，都有可用默认值：

| 变量 | 默认 | 说明 |
|---|---|---|
| `COMFYUI_ROOT` | 从插件位置向上探测含 `models/` 的那一级 | ComfyUI 安装根目录；`models/`、`output/` 都在其下。兼容上游写法 `MODELS_ROOT`。**强烈建议显式设置**，例如 `E:\AI\ComfyUI`：插件装在 bundle store 里时，它离你的 ComfyUI 安装目录很远，自动探测不到 |
| `COMFYUI_URL` | `http://127.0.0.1:8188` | ComfyUI 地址 |
| `PIPELINE` | bundle 内 `pipeline.json` | Anima 管线 workflow 路径 |
| `COMFYUI_OUTPUT` | `<COMFYUI_ROOT>/output` | 出图目录（对比页复制源文件用） |
| `DSH_COMFYUI_STATE` | `<DSH_HOME>/storages/dsh-comfyui-control` | 角色缓存 `cache/` 与对比页 `compare/` 的根目录 |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama 地址 |
| `CAMOFOX_URL` | `http://127.0.0.1:9377` | camofox-browser 地址 |
| `COMFYUI_VIEW_BASE` | `http://127.0.0.1:8899` | 对比页 URL 前缀 |
| `CIVITAI_HOST` | `https://civitai.red` | Civitai 镜像（`civitai.com` 会过滤内容） |
| `CIVITAI_TOKEN` | 空 | 下载 / 详情接口用 |
| `CIVITAI_SEARCH_KEY` | 空 | 网页搜索端点用 |

## 与上游 good-comfyui-mcp 的对应关系

- **工具语义一致**：同样的参数名、同样的返回字段（`prompt_id` / `outputs` / `view_url` /
  `character_info` / `canonical_tag` / `appearance_tags` / `exact` / `kind` / `model_id` /
  `version_id` / `sha256` / `valid_safetensors` …）。
- **行为一致**：Anima 与 Krea2 两套引擎的参数、LoRA 动态注入、默认 5 件套、
  30 天角色缓存与缓存键规则、Danbooru wiki 解析规则、Civitai 搜索匹配与打分、
  小番茄 Gilbert 曲线置换与 `--preserve-meta`、识图拒绝关键词与 fallback 逻辑。
- **实现方式不同**：上游是 Python MCP 进程；本插件是 DSH 进程内的原生工具，
  用 `fetch` 直连各服务，不再需要 `mcp` / `httpx` / `numpy` / `pillow`。
  PNG 编解码（含 tEXt/iTXt/zTXt 与 Gilbert 置换）用 Node 的 `zlib` 自己实现。
- **命名不同**：所有工具加 `comfyui_` 前缀，避免和宿主/其他插件撞名。

## 目录结构

```
package.json                      bundle 元数据：dsh.bundle.patch -> cordis.patch.yml
cordis.patch.yml                  【生成】preset-drawing 声明 + 插件列表
preset/
  preset.yml                      预设显示名「绘图模式」、描述、order
  agent.cordis.yml                预设的插件列表（唯一真源，build 时嵌入 patch）
  dsh-comfyui-control/            预设加载的插件（随 bundle 一起安装）
    lib/entry.js                  插件入口（人工维护）
    lib/index.js                  【生成】自包含单文件插件（18 个工具）
    pipeline.json                 【生成】Anima 管线 workflow
    LORA_GUIDE.md                 【生成】LoRA 选用规范
lib/                              插件实现（打包进 lib/index.js）
  plugin.js                       注册 18 个工具 + 释放
  tool.js                         工具定义与参数校验（对齐 harness schema DSL）
  env.js                          路径与环境变量解析
  http.js                         fetch 封装（超时 / 非 2xx 报错 / 只读探活）
  comfyui.js                      管线、Krea2、提交轮询、历史/队列、对比页
  danbooru.js                     camofox 会话 + Danbooru 角色查询与缓存
  lora-search.js                  Civitai 搜索/反查/下载引擎（每个请求都有超时）
  png.js                          PNG 编解码与文本元数据
  xfq.js                          小番茄 Gilbert 曲线置换
  tools/                          每个领域的工具定义（comfyui / danbooru / civitai / vision）
docs/LORA_GUIDE.md                LoRA 规范源文件
tools/
  build-bundle.mjs                【构建】生成 cordis.patch.yml + 自包含插件
  bundle.mjs                      ESM 自包含打包器
  serve-compare.mjs               8899 对比页静态服务（必需依赖）
  verify.mjs                      bundle 结构与插件自检
  verify-live.mjs                 逐工具真实调用并打印结果
test/                             node:test 套件
```

## 为什么插件是自包含的单文件

bundle store 里的预设行不保证能解析 harness 的 `@deepseek-ai/*` 包，所以
`tools/bundle.mjs` 把 `lib/` 内联进 `preset/dsh-comfyui-control/lib/index.js` 这一个文件：
只保留 Node 内置模块的外部 import，`import.meta.url` 指向打包产物自身
（插件因此把 `dsh-comfyui-control/` 当作自己的根目录）。
`lib/tool.js` 自带一份与 harness 等价的 schema 编译器与参数校验，
`test/harness-schema.test.js` 对每个工具的编译结果和校验结果与 harness 真实实现逐一比对。

## 预设行为什么是相对路径（0.2 的一个坑）

预设里挂插件的那一行写成：

```yaml
- id: comfyui-control
  name: './node_modules/dsh-comfyui-control/preset/dsh-comfyui-control/lib/index.js'
```

因为 0.2 的 Loader 对相对 specifier 做的是 `new URL(name, ctx.baseUrl)`，而 profile 级 Loader 的
`ctx.baseUrl` 是 **profile 目录**，所以相对路径要相对 profile 目录来写（bundle 被 link 进
profile 的 `node_modules`，所以这正好命中）。

两个踩过的坑，写在这里省得再踩：

- 文档里说的"插入行的相对路径锚定在 patch 文件旁"在 0.2.0-rc.2 上**不成立**（至少在 bundle
  被 `install_bundle` 装配之后）：按包目录写的相对路径（如 `./preset/...`）解析不到。
- 想在行里用 `!!js new URL(..., import.meta.url)` 也不行：`!!js` 表达式的求值方式是
  `new Function('ctx', ...)`，里面**没有 `import.meta`**，表达式会抛错。
  同理可用的是 loader 上下文提供的 `dshHomePath(...)`（例如 `!!js dshHomePath('sessions')`）。

## 开发与验证

```bash
npm run build                  # 生成 cordis.patch.yml 与自包含插件（改代码后必跑）
npm test                       # 102 用例：单元 + 契约 + bundle 结构 + 实时冒烟（服务不在时跳过）
node tools/verify.mjs          # bundle 结构与插件自检
node tools/verify-live.mjs     # 逐个真实调用需要服务的工具并打印结果
```

Node 25 把 `node --test <目录>` 当成模块入口，所以用 glob 形式（`npm test` 已是该命令）。

本机验证记录（2026-10-07）：

- `npm test` → 108 用例 / 106 通过 / 1 跳过 / 0 失败
- `node tools/verify.mjs` → 12/12（bundle 声明、插件行可解析、构建产物与源码一致、18 工具注册）
- 真实出图：`comfyui_generate`（Anima，512x512，8 步，CFG 2）17 秒完成，输出 1024x1024；
  回读 PNG 元数据可见 KSampler 参数与注入的 5 个 LoraLoader
- 真实角色查询：`comfyui_lookup_character_tags('hatsune miku')` → `hatsune_miku`（147090 posts）
- 真实 by-hash 反查：`surtr945_v1.safetensors` → model 2692601 / version 3023314 / base Anima
- 小番茄解混淆：enc/dec 两次往返像素完全一致
- `comfyui_status` 实测：`view_server=online`（`npm run serve-compare` 起着时），
  `comfyui_describe_image` 默认返回「视觉服务默认关闭」且**零网络请求**

## 已知限制

- **视觉服务默认关闭，且默认走宿主模型**：`comfyui_describe_image` 不传 `enable_vision=true` 时
  只回一句说明、不发任何请求。开启后优先用 `opencode-go/deepseek-v4.1-flash`（不存在或不支持图片时
  依次退到 `deepseek-official/deepseek-flash`、`deepseek-account/deepseek-flash`）；
  只有显式传 Ollama 模型名（如 `model=qwen3-vl:8b`）才会走本地 Ollama，
  该路径沿用上游行为：qwen3-vl 会拒 NSFW，自动回退 `llava:7b`（无审查但多角色图容易幻觉）。
  未安装模型时会明确提示 `ollama pull <模型>`。
- **8899 服务是必需依赖**：`view_url` 只是 URL，服务没起就打不开。`serve-compare` 只读服务
  compare 目录、不写盘、不联网；端口用 `COMFYUI_VIEW_PORT` 或 `--port` 改。
- **Civitai**：搜索端点需要 `CIVITAI_SEARCH_KEY`，下载需要 `CIVITAI_TOKEN`；by-hash 反查免凭据。
  `publishedAt` 异常的条目 API 搜索搜不到（网页端点可以）；个别模型两端都不收录。
- **解混淆**：只支持小番茄（Gilbert 曲线）混淆；带密钥的像素混淆无密钥无法还原。
  输入必须是 PNG（不引入 JPEG 解码器），`times` 上限 64（每次都是主机进程内的整幅像素遍历）。
- **PNG 编解码**：支持 8 位灰度 / RGB / 调色板 / RGBA；隔行 PNG 会明确报错而不是猜。
- **出图元数据处理**：非 PNG（如 JPEG）只读取 JPEG `COM` 注释段的文本元数据并报告格式与尺寸；
  EXIF 标签数量与 WebUI `parameters` 的深度解析没有复刻。
- **磁盘增长**：`compare/` 与角色缓存只增不减，需要时自行清理
  `<DSH_HOME>/storages/dsh-comfyui-control/`。

## License

MIT
