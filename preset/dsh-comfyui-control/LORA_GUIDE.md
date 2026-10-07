# LoRA 使用规范（绘图模式）

> 适用：本插件的 `comfyui_generate`（Anima 管线，`lora_text` / `lora_list` 参数）。
> 目标：让 Agent 选 LoRA 时**有依据**，而不是凭文件名猜。
> 铁律：一次只调一个变量；默认不叠超过 4 个 LoRA；换 LoRA 先小步验证再全量。

## 0. 用哪些工具维护这份规范

| 场景 | 工具 |
|---|---|
| 看本地有哪些 LoRA | `comfyui_list_models(folder='loras')` |
| 找某个 LoRA 的 Civitai 精确版（文件名→modelId/versionId） | `comfyui_search_lora(filename, base_model='Anima')` |
| 按 versionId 下载到 `models/loras/` | `comfyui_download_lora(version_id, filename)` |
| 本地文件反查来源（比搜索可靠，私有/未收录也能确认是否命中） | `comfyui_lookup_lora_hash(local_path)` |
| 确认出图时 LoRA 权重确实生效 | `comfyui_extract_image_info(image_path)` 回读 PNG 元数据 |

**入库流程**：`comfyui_lookup_lora_hash` 反查 → 记录 modelId/versionId/作者/触发词/推荐权重 →
`comfyui_search_lora` 补齐页面信息 → 按命名规范改名放入 `models/loras/` → 在本文档登记。
未命中 by-hash 说明是私有训练或未发布版本，**不要**套用同名搜索结果的页面信息。

## 1. 分类体系

| 类别 | 作用 | 典型 |
|---|---|---|
| A 画风系 | 决定整体画风 / 画师味道 | 画师 style LoRA |
| B 角色系 | 绑定具体角色外观 | `角色名_v1` |
| C 氛围 / 光影 | 光线、色调、情绪氛围 | darklight、lighting slider、colorfix |
| D 皮肤 / 背景 | 皮肤写实度、背景质感 | RealSkin、photo-background |
| E 质量 / 细节 / 加速 | 整体质量、细节增强、加速出图 | masterpiece、detailer、turbo |

## 2. 默认 5 件套（`comfyui_generate` 不传 `lora_text` 时自动挂载）

| LoRA | 权重 | 类别 | 作用 |
|---|---|---|---|
| `ushikani_kassen_lora-000013.safetensors` | 0.3 | A | 画风 |
| `anima-darklight-style-v1-000194.safetensors` | 0.3 | C | 朦胧氛围 |
| `anima-base-1-photo-background-v4.safetensors` | 0.6 | D | 写实背景 |
| `RealSkin SliderV2.safetensors` | 0.8 | D | 写实皮肤 |
| `surtr945_v1.safetensors` | 0.8 | A/B | 画风 |

- 传 `lora_text=""` 显式空载；传自定义 `<lora:文件名:权重>` 覆盖默认。
- 默认组合只是**兜底**：只要用户有明确风格/氛围诉求，就用 A/C 类替换其中的画风项，而不是叠加。

## 3. 选择规则

1. **什么都不确定** → 默认 5 件套。
2. **要画师味道** → A 类**替换** `ushikani` / `surtr945` 之一（不要全叠）。
3. **要特定角色** → B 类角色 LoRA 0.7-1.0 + 画风项降权到 0.3 左右，避免串味。
4. **要氛围** → C 类：暗调用 darklight，光照方向/强度用 lighting slider，色调偏了用 colorfix。
5. **要写实** → D 类加权（RealSkin 0.9-1.0 + photo-background 0.8）。
6. **要精细** → E 类 masterpiece / detailer 各 0.4 左右，或开 `upscale=true`。
7. **要快** → turbo LoRA（`steps` 8-12、`cfg` 1.0）——替代而非叠加。
8. **不确定某个 LoRA 的定位** → 不要猜：用 `comfyui_lookup_lora_hash` 反查页面，或直接问用户。

## 4. 权重规范

| 类别 | 安全区间 | 说明 |
|---|---|---|
| 画风 | 0.3-0.7 | <0.2 几乎无效；>0.9 容易糊 / 过拟合 |
| 角色 | 0.6-1.0 | 相似度不够就往上加 |
| 氛围 / 光影 | 0.3-0.8 | 滑块类按视觉反馈调 |
| 皮肤 | 0.6-1.0 | |
| 背景 | 0.5-0.8 | |
| 质量 / 细节 | 0.3-0.6 | |
| 加速 | 1.0（配套改 steps/cfg） | |

**叠加规则**

- 总 LoRA 数 ≤ 4（5 件套是极限兜底配置）。
- 同类别不叠超过 2 个（画风类尤其如此）。
- 权重总和 ≥ 3 时画面容易过拟合（线条糊、色彩脏）——优先删 LoRA，而不是全部降权。
- **一次只调一个变量**：要么换 LoRA，要么改一个权重，要么改 seed。
- 组合的「强度感」由最高权重的那个主导，其余都是辅助。
- 作者给了推荐值的以作者为准（写进本表备注列）。

## 5. 改提示词 vs 改 LoRA：先诊断，再动手

> 核心：**提示词管「内容」（画什么），LoRA 管「风格 / 质感」（什么味道）。**

| 用户反馈 | 诊断 | 动什么 |
|---|---|---|
| 角色 / 服装 / 姿势 / 场景画错、缺失、多余 | 内容问题 | **提示词**：增删 tag、调 `(tag:1.2)` |
| 出现不想要的东西（多余肢体 / 物体 / 穿帮） | 内容污染 | **提示词**删 tag + 负面词 |
| 视角 / 构图不对 | 构图问题 | **提示词**：`from above` / `close-up` / `full body` / `centered composition` |
| 局部强调不足 | 内容权重 | **提示词**：`(tag:1.2)` 等 |
| 整体画风不对（太素 / 太暗 / 太写实） | 风格问题 | **LoRA**：换 A 类画风项或调权重 |
| 氛围 / 光影不对 | 氛围问题 | **LoRA**：C 类 |
| 皮肤假、塑料感 | 材质问题 | **LoRA**：RealSkin 0.6 → 0.9 |
| 背景太假 / 太简单 | 背景问题 | **LoRA**：photo-background 权重 |
| 手 / 脸 / 结构崩坏 | 质量崩坏 | ① 最近动过 LoRA → 先降权 0.1-0.2；② 补负面词；③ 换 seed；④ 降分辨率 |
| 角色不像 | 识别问题 | **LoRA**：角色 LoRA 0.7-1.0 + 画风降权；或把角色拆成发色 / 发型 / 瞳色 / 服装 tag |
| 画质糊 / 细节差 | 质量不足 | **LoRA**：E 类，或 `upscale=true` |
| 说不清哪里不对 | — | 先**换 seed**（零成本），再按上表归类 |

**三条铁律**

1. **LoRA 权重过高是崩坏头号原因**：出现「角色走样、风格压过内容、线条糊、色彩脏」，先降 LoRA 权重
   0.1-0.2，不要用提示词去对抗 LoRA（越对抗越脏）。
2. **画师风格靠 LoRA 不靠提示词**：提示词写「某某画师风格」几乎无效；要 `@画师tag` + 画风 LoRA 双管。
3. **角色靠 LoRA 或特征拆解**：底模不认识的角色名 tag 无效；要么挂角色 LoRA，要么把角色拆成具体特征 tag。

**排查顺序**：换 seed → 改提示词 → 调 LoRA 权重 → 换 LoRA → 换模型。每步只动一个变量、只出一张图对比。

## 6. 命名与登记

1. **命名**：`@画师_style` / `角色名_v版本` / `功能_slider`；新下载的 LoRA 按此改名再入库。
2. **来源登记（必做）**：下载后立即 `comfyui_lookup_lora_hash` 反查，命中则记录
   模型名 / 作者 / 官方触发词 / 推荐权重 / 页面链接，补进第 2、3 节对应表格；未命中标注「私有 / 未发布」。
3. **触发词**：以 Civitai 页面 `trainedWords` 为准（比文件名可靠）；找不到触发词的画风 LoRA 从权重 0.5 起试。
4. **预览**：保留 `.webp` 预览图与 `.metadata.json`，方便快速认图。
5. **验证**：新 LoRA 首次使用后用 `comfyui_extract_image_info` 回读 PNG 元数据，
   确认 `lora_name` 与权重确实生效（防止同名不同文件 / 版本覆盖）。
6. **版本**：同名不同版本保留新版，旧版归档；同一模型多版本确认底模后保留适用的那个。

## 7. 维护方式

- **私有 / 项目专用 LoRA**：把本文件复制到预设目录改名 `LORA_GUIDE.local.md`（或在项目里另建文档），
  记录用户自己的 LoRA 清单与偏好；`LORA_GUIDE.md` 只保留通用规范，方便随插件升级。
- **画风判断以人眼对比为准**：同一提示词、同一 seed、单 LoRA 固定权重出图对比，
  同一批图用 `comfyui_generate(reference_image=...)` 生成对比页再逐张看。
