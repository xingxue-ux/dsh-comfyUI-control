# dsh-comfyUI-control

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件：
把本地 ComfyUI 接到 **绘图模式** Agent 预设里，完整复刻
[`xingxue-ux/good-comfyui-mcp`](https://github.com/xingxue-ux/good-comfyui-mcp)
的 13 个工具，并补齐了 ComfyUI 控制面（模型列表 / 任意 workflow / 历史 / 队列 / 节点查询），共 **18 个工具**。

**只在「绘图模式」预设里生效**：标准模式、极简模式、PTC 模式、创造模式等其他预设不加载这个插件，
也就看不到任何 `comfyui_*` 工具。

零运行时依赖（只用 Node 内置模块 + 全局 `fetch`），不需要 pip、不需要 Python MCP 进程。

## 功能（18 个工具）

| 工具 | 说明 | 对应上游 |
|---|---|---|
| `comfyui_status` | 依赖自检：ComfyUI / 管线模型 / Ollama / camofox / Civitai 配置，返回 `missing[]` 与 `on_demand[]` | `server_info` |
| `comfyui_setup_guide` | 初始化清单（每步含操作 / 验证 / 是否必需） | `setup_guide` |
| `comfyui_get_model_guide` | Anima 官方用法：模型版本、采样参数、提示词规则、限制 | `get_model_guide` |
| `comfyui_list_models` | 列出 ComfyUI 各模型目录（loras / diffusion_models / text_encoders / vae / upscale_models …） | — |
| `comfyui_generate` | 出图：Anima 管线（默认）或 Krea2 引擎；可覆盖 steps/cfg/sampler/尺寸/seed；参考图自动生成对比页 | `generate` |
| `comfyui_run_workflow` | 提交任意 workflow JSON 并等待结果 | — |
| `comfyui_history` | 历史记录查询与 `mcp`/`manual` 来源标注 | — |
| `comfyui_queue` | 队列查看 / 中断 / 清空 | — |
| `comfyui_node_info` | 节点输入输出定义查询 | — |
| `comfyui_extract_image_info` | PNG 元数据解析：ComfyUI prompt/workflow、WebUI parameters、LoRA 配置 | `extract_image_info` |
| `comfyui_describe_image` | 本地 Ollama 识图（默认 qwen3-vl:8b，NSFW 自动 fallback llava:7b，`detail` 11 问模式） | `describe_image` |
| `comfyui_deconfuse_image` | 小番茄（Gilbert 曲线）混淆图还原，可 `enc`/`dec` 多次 | `deconfuse_image` |
| `comfyui_lookup_character_tags` | Danbooru 角色规范 tag（camofox 反检测浏览器，30 天缓存） | `lookup_character_tags` |
| `comfyui_lookup_character_appearance` | 角色外貌 tag 统计（solo 图 tag 频率） | `lookup_character_appearance` |
| `comfyui_list_cached_characters` | 已缓存角色列表（离线） | `list_cached_characters` |
| `comfyui_search_lora` | Civitai LoRA 精确版搜索（网页搜索端点 models_v9，比 API 全） | `search_lora` |
| `comfyui_download_lora` | Civitai 下载 + safetensors 头校验 | `download_lora` |
| `comfyui_lookup_lora_hash` | 本地文件 SHA256 → by-hash 反查精确来源 | `lookup_lora_hash` |

## 安装

### 1. 安装预设

```bash
git clone https://github.com/xingxue-ux/dsh-comfyUI-control
cd dsh-comfyUI-control
node tools/install-preset.mjs          # 安装到 ~/.dsh/.agent-presets/drawing
```

安装脚本把预设需要的文件复制到 `~/.dsh/.agent-presets/drawing/`：

```
preset.yml                        显示名「绘图模式」与选择器描述
agent.cordis.yml                  预设编排；挂载 ./dsh-comfyui-control/lib/index.js
dsh-comfyui-control/lib/index.js  自包含插件（18 个 comfyui_* 工具）
pipeline.json                     Anima 管线 workflow（随预设一起安装）
LORA_GUIDE.md                     LoRA 规范，供 Agent 用 read 工具查阅
```

- 插件被**打包成一个自包含 ESM 文件**放在预设里：用户预设目录在 harness 的 `node_modules`
  向上查找路径之外，`import '@deepseek-ai/dsh-tools'` 在那里解析不到，所以不能有外部依赖。
- 插件保持 `lib/` 这一级目录形状，它就能像在源码目录里一样解析自己的根目录，
  `pipeline.json`、`compare/` 与角色缓存的路径都落在预期位置。
- `LORA_GUIDE.md` 同时复制到 `<dsh-home>/storages/dsh-comfyui-control/`，
  安装输出会打印两个绝对路径。

常用参数：`--id <dir>` 改预设目录名（默认 `drawing`）、`--dsh-home <dir>`、`--force` 覆盖已存在的预设、
`--uninstall` 卸载（只删预设目录）。

### 2. 打开预设

重启 DSH（或重新加载配置），在 Agent 预设选择器里选 **绘图模式**；
也可以在「设置 → 通用 → Agent 预设」里把它设为默认，然后新建会话。

### 3. 环境依赖

| 依赖 | 必需 | 说明 |
|---|---|---|
| ComfyUI（默认 `http://127.0.0.1:8188`） | ✅ | 出图与模型列表 |
| Anima 管线模型 | ✅ | `anima-base-v1.0.safetensors`（`models/diffusion_models/`）、`qwen_3_06b_base.safetensors`（`models/text_encoders/`）、`qwen_image_vae.safetensors`（`models/vae/`）、`RealESRGAN_x2plus.pth`（`models/upscale_models/`，开 `upscale` 时用） |
| 默认 5 件套 LoRA | ✅（默认挂载） | 见下节；缺了就用 `comfyui_search_lora` + `comfyui_download_lora` 拉 |
| Ollama + 视觉模型 | 可选 | `ollama pull qwen3-vl:8b`（准确，NSFW 会拒答）+ `ollama pull llava:7b`（无审查 fallback）；不装则只有识图不可用 |
| camofox-browser（默认 `http://127.0.0.1:9377`） | 可选 | `npm install -g @askjo/camofox-browser && camofox-browser`；不装则角色 tag / 外貌统计不可用 |
| Civitai 凭据 | 可选 | `CIVITAI_TOKEN`（下载）、`CIVITAI_SEARCH_KEY`（搜索）；不配时 by-hash 反查仍可用 |
| 8899 静态服务 | 可选 | `node -e "..."` 或 `python -m http.server 8899` 指向状态目录的 `compare/`，用于查看对比页 |

装好后在会话里先调 `comfyui_status`，它会返回 `missing[]` 逐项告诉你缺什么。

### 默认 5 件套 LoRA

`comfyui_generate` 不传 `lora_text` 时自动挂载（传 `lora_text=""` 显式空载）：

| LoRA | 权重 | 用途 |
|---|---|---|
| `ushikani_kassen_lora-000013.safetensors` | 0.3 | 画风 |
| `anima-darklight-style-v1-000194.safetensors` | 0.3 | 朦胧氛围 |
| `anima-base-1-photo-background-v4.safetensors` | 0.6 | 写实背景 |
| `RealSkin SliderV2.safetensors` | 0.8 | 写实皮肤 |
| `surtr945_v1.safetensors` | 0.8 | 画风 |

用 `comfyui_search_lora` 可以查到它们的 Civitai 精确版本，再用
`comfyui_download_lora` 下载到 `models/loras/`：

```text
comfyui_search_lora(filename='surtr945_v1.safetensors', base_model='Anima')
→ { exact: true, kind: 'KNOWN', model_id: '2692601', version_id: '3023314', author: 'umina' }
comfyui_download_lora(version_id=3023314, filename='surtr945_v1.safetensors')
```

## 配置

全部通过环境变量，都有可用默认值：

| 变量 | 默认 | 说明 |
|---|---|---|
| `COMFYUI_ROOT` | 插件目录的上级（若含 `models/`） | ComfyUI 安装根目录；`models/`、`output/` 都在其下。兼容上游写法 `MODELS_ROOT` |
| `COMFYUI_URL` | `http://127.0.0.1:8188` | ComfyUI 地址 |
| `PIPELINE` | 包内 `pipeline.json` | Anima 管线 workflow 路径 |
| `COMFYUI_OUTPUT` | `<COMFYUI_ROOT>/output` | 出图目录（对比页复制源文件用） |
| `DSH_COMFYUI_STATE` | `<DSH_HOME>/storages/dsh-comfyui-control` | 角色缓存 `cache/` 与对比页 `compare/` 的根目录 |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama 地址 |
| `CAMOFOX_URL` | `http://127.0.0.1:9377` | camofox-browser 地址 |
| `COMFYUI_VIEW_BASE` | `http://127.0.0.1:8899` | 对比页 URL 前缀 |
| `CIVITAI_HOST` | `https://civitai.red` | Civitai 镜像（`civitai.com` 会过滤内容） |
| `CIVITAI_TOKEN` | 空 | 下载 / 详情接口用 |
| `CIVITAI_SEARCH_KEY` | 空 | 网页搜索端点用（README 上游 5b 节有获取方式） |

环境变量写在哪由用户决定；如果要让 DSH 进程读到，最省事的是写进启动环境或 profile 的 shell 环境配置。

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
index.js                 插件入口（预设行加载它）
lib/
  plugin.js              注册 18 个工具 + 释放
  tool.js                工具定义与参数校验（对齐 @deepseek-ai/dsh-tools 的 schema DSL）
  env.js                 路径与环境变量解析
  http.js                fetch 封装（超时 / 非 2xx 报错 / 只读探活）
  comfyui.js             管线、Krea2、提交轮询、历史/队列、对比页
  danbooru.js            camofox 会话 + Danbooru 角色查询与缓存
  lora-search.js         Civitai 搜索/反查/下载引擎（每个请求都有超时）
  png.js                 PNG 编解码与文本元数据
  xfq.js                 小番茄 Gilbert 曲线置换
  tools/                每个领域的工具定义（comfyui / danbooru / civitai / vision）
preset/
  preset.yml             预设显示名「绘图模式」与描述
  agent.cordis.yml       预设编排（唯一挂载本插件的行）
docs/LORA_GUIDE.md       LoRA 选用规范（安装时复制进预设目录）
tools/
  bundle.mjs             自包含打包
  install-preset.mjs     安装/卸载预设
  verify.mjs             预设编排、工具表与隔离性自检
  verify-live.mjs        逐工具真实调用并打印结果
test/                    node:test 套件
```

## 为什么必须是自包含的

用户预设位于 `<DSH_HOME>/.agent-presets/<id>/`，不在 harness 安装目录的
`node_modules` 向上查找路径里，所以预设里的插件行**不能** `import '@deepseek-ai/dsh-tools'`。
本插件因此自带一份与 harness 等价的 schema 编译器与参数校验，
并用 `test/harness-schema.test.js` 对每个工具的编译结果和校验结果与 harness 真实实现逐一比对。

同理，预设行只引用 `./dsh-comfyui-control/lib/index.js` 这个相对路径，插件不会出现在 profile 层，
其他预设自然看不到。打包器把 `import.meta.url` 重写成**打包产物自己的位置**，
所以安装到预设目录后，插件解析到的是预设目录，而不是打包时那台机器的源码路径。

## 开发与验证

```bash
node --test "test/*.test.js"   # 99 用例：单元 + 契约 + 预设隔离 + 实时冒烟（服务不在时自动跳过）
node tools/bundle.mjs          # 重新生成预设用的自包含文件
node tools/verify.mjs          # 预设编排/工具表/隔离性自检
node tools/verify.mjs --installed --dsh-home <dir> --id drawing   # 追加校验已安装副本
node tools/verify-live.mjs     # 逐个真实调用需要服务的工具并打印结果
```

Node 25 把 `node --test <目录>` 当成模块入口，所以用上面的 glob 形式（package.json 的
`npm test` 也是这个命令）。

本机验证记录（2026-10-07）：

- `node --test "test/*.test.js"` → 99 用例 / 98 通过 / 1 跳过（跳过项是 Ollama 识图：
  本机未安装视觉模型）/ 0 失败。
- `node tools/verify.mjs --installed` → 14/14（含安装副本自检：预设目录里 18 个工具全部注册、
  安装后的插件把预设目录解析成自己的根目录、`pipeline.json` 随预设一起安装）。
- `node tools/verify.mjs` → 8/8（含隔离性：除 绘图模式 外没有任何预设引用本插件）。
- `node tools/verify-live.mjs` → 13 次真实调用 12 次成功，唯一失败是
  `comfyui_describe_image` 明确报告 `ollama pull`（本机模型库为空，属预期）。
- `lib/tool.js` 的 schema 编译与参数校验和 harness 的 `@deepseek-ai/dsh-tools` **逐工具逐字段一致**
  （`test/harness-schema.test.js` 直接加载 harness 实现对比）。
- 真实出图：`comfyui_generate`（Anima，512x512，8 步，CFG 2，seed 12345）20 秒完成，
  输出 `output/Anima/2026-10-07/anima_00003_.png`（管线 2x 放大后 1024x1024），
  `view_url` 指向 8899 对比页；带回读元数据能看到 KSampler 参数与注入的 LoRA 链。
- 真实角色查询：`comfyui_lookup_character_tags('hatsune miku')` → `hatsune_miku`
  （post_count 147090、41 个本地化名与 wiki 描述），`comfyui_lookup_character_appearance`
  → 38 个外貌 tag。
- 真实 by-hash 反查：`surtr945_v1.safetensors` → SHA256 `7B1E112E…4BC8D`，
  命中 model 2692601 / version 3023314 / base Anima，与内置 KNOWN_EXACT 表一致。
- 小番茄解混淆：`enc/dec` 各两次后像素与原因完全一致；1024x1024 单次 278ms。

## 已知限制

- **识图模型**：`qwen3-vl:8b` 会拒 NSFW，自动 fallback 到 `llava:7b`（无审查但多角色图容易幻觉，
  建议裁剪后分角色识图）。未安装视觉模型时 `comfyui_describe_image` 会明确提示
  `ollama pull <模型>`，不会静默返回空描述。
- **Civitai 搜索**：模型级 `publishedAt` 异常的条目 API 搜索搜不到（网页端点可以）；
  个别模型两端都不收录，只能按 ID 直达或用 by-hash 反查。搜索端点需要
  `CIVITAI_SEARCH_KEY`，下载需要 `CIVITAI_TOKEN`；by-hash 反查免凭据。
- **解混淆**：只支持小番茄（Gilbert 曲线）混淆；带密钥的像素混淆（如 PicEncrypt）无密钥无法还原。
  JPEG 有损压缩 / 缩放过的混淆图可能因曲线位置失配而无法完全还原。
  **输入必须是 PNG**（本插件不引入 JPEG 解码器），且 `times` 上限 64 次
  （每次都是主机进程内的整幅像素遍历，不能无界）。
- **PNG 编解码**：支持 8 位灰度 / RGB / 调色板 / RGBA；隔行 PNG 会明确报错而不是猜。
- **出图元数据处理**：非 PNG（如 JPEG）只读取 JPEG `COM` 注释段的文本元数据，
  并报告格式与尺寸；EXIF 标签数量与 WebUI `parameters` 的深度解析没有复刻
  （上游用 PIL，本插件不引入图像库依赖）。
- **磁盘增长**：`compare/`（每次带 `reference_image` 出图都会复制一张）与角色缓存
  （每个角色一个 JSON）只增不减，需要时自行清理 `<DSH_HOME>/storages/dsh-comfyui-control/`。
- **批量导入的 LoRA 触发词**：`comfyui_search_lora` 只按文件名与 trainedWords 匹配；
  私有训练的 LoRA 在 Civitai 上查不到（by-hash 也不命中），属正常。

## License

MIT
