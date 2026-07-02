# 025 — 内置 PPT 生成技能：ppt-master 调研与打包方案

> 状态：✅ 阶段 1 已落地（**ADR-040**，四路对抗审查 + 真机全链验收：真模型完整生成一次 PPT 通过）；阶段 2（§5 混合更新通道）待做
> ⚠️ 实施时对本文的两处升级：① X_REQUIRES 从 `["python3"]` 升级为 `["python3.10+", "python-pptx"]`（e2e 暴露 3.9 假就绪 → Rust python 内探针版本门，ADR-040 D3）；② 追加 opencode-server rich PATH 注入 + builtin staging+rename 原子落地（审查产出，ADR-040 D4）
> 日期：2026-07-02
> 关联：ADR-032（内置技能打包与分发）· gotchas §10（内置技能坑点）· ADR-039（`POST /global/refresh` 软刷新）· ADR-037（跨平台约束）· ADR-033（产物识别 = 文件系统真相）
> 范围：评估 [hugohe3/ppt-master](https://github.com/hugohe3/ppt-master) 能否直接/微改造为 Ultrawork 内置 PPT 技能；给出打包路线、更新跟随策略、Python 环境引导方案。**不涉及**自研 PPT 生成能力。

---

## 0. 一句话

ppt-master 本身就是标准 Agent Skill 形态（`SKILL.md` + scripts/references/templates，MIT 许可），与 opencode 的 skill 机制、Ultrawork 的内置技能管线（ADR-032）逐项验证兼容，**可以零改造直接打包**。裁掉纯说明性图片后压缩仅 **6.6MB**，推荐**内置进安装包**（离线开箱用，规避用户侧 GitHub 不可达），同时**保留设置页 curated 安装入口作为自助更新通道**——但后者必须先解决「同名 skill 发现竞态」（本文 §5，Rust 侧确定性遮蔽），不能天真上线。

---

## 1. 上游仓库画像（事实调研，2026-07-02）

| 项 | 事实 |
|---|---|
| 仓库 | `hugohe3/ppt-master`，35.9k stars / 3k forks，v2.12.0（2026-07-01 发版），迭代非常活跃（约周更） |
| 许可 | **MIT** —— 过 gotchas §10 第一道硬门槛（可再分发、可修改），与现有内置技能的 Apache-2.0 同级安全 |
| 形态 | **已是标准 skill**：`skills/ppt-master/SKILL.md`（frontmatter `name: ppt-master`，description 含中英触发词「生成PPT」「做PPT」「create PPT」）；另有 `.claude-plugin/marketplace.json`（Claude Code 插件市场用，与我们无关） |
| 核心链路 | 源文档（PDF/DOCX/URL/MD）→ `project_manager.py` 建项目 → Strategist 产出设计规范（spec_lock）→ **主模型逐页手写 SVG**（明令禁止子代理/脚本批量生成）→ 质量检查（`svg_quality_checker.py`）→ `svg_to_pptx.py` 导出 **PPTX（PNG+SVG 双格式，全 Office 版本兼容，真可编辑）** |
| 附加能力 | 模板/品牌系统、5 套图标库（tabler×2/phosphor/simple-icons/chunk，共 11768 个 SVG）、图表模板、PPTX 原生动画、逐页旁白 TTS（edge-tts）、浏览器实时预览编辑器（`svg_editor/server.py`，localhost:5050）、旧 PPTX 美化/模板导入等 17 个独立 workflow |
| 运行依赖 | **Python 3.10+ 必需**；pip 依赖按功能可选（导出必需 `python-pptx`，源转换 PyMuPDF/mammoth 等，全量 17 个包一条 `pip install -r requirements.txt`）；AI 配图/图片搜索/TTS 需要外部 API key（`.env`，纯可选增强）；Pandoc 仅遗留格式需要 |
| 体积 | skill 目录 **97MB / 12143 文件**。大头：`templates/icons/` 47M（功能性图标库）+ `references/ai-image-comparison/` 43M（AI 画图供应商对比说明图，**纯文档、可裁**）。其余 ~7M。仓库整体 ~700M（`examples/` 占 581M，不在 skill 目录内） |

## 2. 与 Ultrawork 适配性（逐项源码验证）

| 验证点 | 结果 | 依据 |
|---|---|---|
| opencode skill 机制兼容 | ✅ | `vendor .../tool/skill.ts`：加载时注入 SKILL.md 全文 + `Base directory for this skill: <file-url>` + 「相对路径按 base 解析」声明 → ppt-master 的 `${SKILL_DIR}` 写法可被模型正确解析（留一项真机 smoke test） |
| 自包含性 | ✅ 基本自包含 | 全库 `../..` 越界引用仅指向仓库根 `docs/zh/templates-architecture.md`（文档深链，缺失只降级不断功能）；实时预览/确认 UI 的 server 均在 skill 内部 |
| 工程/产物落点 | ✅ | `project_manager.py:116`：`base_dir = Path.cwd()/"projects"` → 落**工作区目录**，不污染技能目录；生成的 pptx 被产物面板 mtime 扫描捕获（ADR-033） |
| 交互模式 | ✅ | 「八项确认 ⛔ BLOCKING」为 chat 驱动 + 可选本地 Web 确认 UI（自带 chat fallback），适配聊天式 app |
| 渐进式工具披露 | ✅ | `skill` 工具在 `EAGER_BUILTINS`（`tool-disclosure.ts:64`），不被折叠 |
| 名称/定位冲突 | ✅ 无 | 与内置 `markdown-exporter`（md→pptx 快速转换）定位不同：快速转换 vs 深度设计生成，description 差异足够路由 |
| 依赖检测管线 | ✅ 直接复用 | ADR-032 D3：`check_skill_dependencies` + `BUILTIN_DEP_MAP` + `DepBadge`，加一条 `"ppt-master": ["python3"]` 即接入 |
| 跨平台 | ⚠️ 待真机验 | 上游声称三平台（有 `console_encoding.py` 处理 Windows 编码），但 SKILL.md 命令写死 `python3`——Windows 常无此别名，依赖模型自适应或真机确认 |

## 3. 两项固有代价（打包方式解决不了，需有预期）

1. **Token 消耗大（上游刻意设计）**：SKILL.md 73KB（加载即 ~18k token），流程强制读 strategist.md（92KB）/executor-base.md（42KB）等，且主模型逐页手写 SVG、禁止委派。一套 15 页 deck 估计几十万 token。上游有针对性缓解（规则 8：每页重读 spec_lock 对抗上下文压缩漂移），qwen 128k 上下文下长 deck 必触发压缩，行为需真机验证。
2. **Python 是硬前置**：无 python3 时核心导出链路完全不可用 → 引导必须做（§6）。

## 4. 打包路线：为什么选 A（内置）而不是 B（curated 安装）

| | A. 内置打包（`skills/builtin/`） | B. 仅 curated 安装（skill-installer） |
|---|---|---|
| 离线/弱网可用 | ✅ 随安装包分发 | ❌ **安装即依赖 GitHub 可达**（用户网络环境不可控，国内常不可达/极慢） |
| 安装包增量 | +6~8MB（实测：裁掉 `ai-image-comparison` 后 gzip **6.6MB**；1.1 万图标 SVG 文本重复度高，压缩率 ~8:1）；落盘 54MB、首启拷贝 1.2 万文件数秒级 | 0 |
| 更新跟随上游 | 随 Ultrawork 发版重跑 `fetch-builtin-skills.ts`（pin release tag，一条命令） | 用户重装即最新 |
| 实施量 | fetch 脚本加一条 Source + 依赖徽标 | Settings curated 数组加一行 |

**结论：A 为主**。决定性因素是用户网络环境（首轮讨论曾因体积倾向 B，压缩实测 6.6MB 后体积顾虑不成立）。B 不作为主通道，但其能力**保留**用作自助更新（§5）。

> B 通道技术注记：`skill-installer` 的 `_git_sparse_checkout` 原生支持只拉 `skills/ppt-master` 子目录（几十 MB），**但 `auto` 模式先试整仓 zip**（此仓库含 examples ≈ 数百 MB）→ curated 安装 prompt 必须显式注明 `--method git`。

## 5. 混合模式：内置保底 + curated 自助更新（含竞态解法）

**目标形态**：安装包自带内置版（离线保底）；有网络/GitHub 可达的用户可从设置页「推荐安装」区触发 skill-installer 装上游最新版到 `~/.config/ultrawork/skills/ppt-master`（`builtin/` 同级）。

**⚠️ 天真并存 = 竞态（已源码核验，不能直接上线）**：两份同名 `ppt-master` 落在同一 config 目录的同一次 glob 扫描（`skill/index.ts loadSkills`，pattern `{skill,skills}/**/SKILL.md`）里，`Effect.forEach(..., { concurrency: "unbounded" })` 并发 `add()`，后写入者赢 → **谁覆盖谁不确定**（仅 `duplicate skill name` warn）。

**解法（推荐）：Rust 侧确定性遮蔽，「用户安装版永远优先」**，零 vendor patch：

- `ensure_builtin_skills`（每次 app 启动都跑，现有幂等入口）追加两步：
  1. **prune**：拷贝/校验后，遍历 `builtin/<name>`，若存在同名用户目录 `skills/<name>` → 删除 `builtin/<name>` 磁盘副本 → 文件系统层面只剩一份 SKILL.md，竞态源头消失；
  2. **restore**：若 `builtin/<name>` 缺失且用户目录**无**同名 → 从 bundle 资源补拷（使「移除用户版 → 恢复内置版」可行，不必等 app 升级换 sentinel）。
- 设置页连带：内置区该技能显示「已被用户安装版本覆盖」态 + 「移除用户版本，恢复内置」按钮（删用户目录 + invoke ensure + `POST /global/refresh` 即时生效，ADR-039）。
- **规则文档化**：用户版一经安装**永远遮蔽**内置版（哪怕后续 app 发版携带更新的内置版），直到手动移除——简单、可预期、无版本比较魔法。可选未来增强：安装时落 `.installed-ref` 标记做版本提示。

**被否决的替代**：vendor patch 在 `skill/index.ts add()` 里做 builtin-path 让位裁决——一行可写但扩大 patch 面、每次 bump 多一个 hunk 维护成本，且 Rust 方案在文件层已根治，无必要。

**分期**：混合模式属**阶段 2**（Rust prune/restore + 遮蔽 UI + curated 条目三件套必须同批上线，缺一即竞态/体验破损）。阶段 1 只上内置版，不加 curated 条目。

## 6. Python 环境引导（分层）

现状（ADR-032 D3）：`DepBadge` 缺失时仅 hover tooltip，文案 mac 取向（`python.org / brew install python`），Windows/Linux 用户得不到有效引导；Python **库**（python-pptx）无法按 PATH 探测（gotchas §10），存在「徽标就绪但 pip 依赖缺失」盲区。

| 层 | 内容 | 工作量 |
|---|---|---|
| 基础（随阶段 1） | `DEP_HINTS` 平台化（mac: brew/python.org · win: `winget install Python.Python.3.12`/python.org 安装器 · linux: apt/dnf）；缺失徽标升级为**可点击**（tauri-plugin-opener 打开下载页 / 复制命令） | 小 |
| 进阶（推荐，随阶段 1） | 「引导安装」按钮 → 复用 curated 安装的 **handoff 模式**（`navigate("/", { state:{ initialInput } })`）：预填「检测系统并引导安装 Python 3.10+ 与 ppt-master pip 依赖（国内用清华镜像 `-i https://pypi.tuna.tsinghua.edu.cn/simple`），完成后验证 `python3 -c "import pptx"`」交给新对话 AI —— 按平台给命令、处理镜像、失败重试、装完验证 | 小-中 |
| 可选加固 | `check_skill_dependencies` 增加 `python3 -c "import pptx"` import 探针（Rust），消除「就绪假象」盲区 | 小 |
| 否决 | 打包 Python 运行时 —— ADR-032 已论证放弃（三平台各 +50MB，pip 依赖仍需网络，收益不闭环）。未来若要重开，评估 `uv`（单二进制托管 Python + 依赖，支持 `UV_PYTHON_INSTALL_MIRROR`），当下不做 | — |

> 网络暴露面总结：skill 本体随安装包（0 网络）→ Python 官网安装器（国内可达）→ pip 走清华/阿里镜像（国内快）→ 唯一残留 GitHub 依赖 = 阶段 2 的自助更新通道（可选路径，失败不影响保底）。

## 7. 实施清单

**阶段 1（分支 `feat/builtin-ppt-master-skill`）**
1. `scripts/fetch-builtin-skills.ts` 加 Source：`repo: hugohe3/ppt-master`，**`ref` pin release tag（v2.12.0）**而非 main，`subdir: skills/ppt-master`，`drop: ["references/ai-image-comparison"]`，`X_REQUIRES: ["python3.10+", "python-pptx"]`（实现时升级：ppt-master 硬要求 Python ≥3.10——模块级 `X | None` 语法 3.9 直接 TypeError——故引入 Rust 内探针版本门），NOTICE（MIT，注明裁剪项）；另加 ppt-master 落地 post-patch（`.env` 存放引导——builtin 目录升级会重建，引导用户放 `~/.ppt-master/.env`；清理指向被裁 ai-image-comparison 的悬空引用）；跑脚本落地 `skills/builtin/ppt-master/` 并提交（`.builtin-version` 随动）。
2. `BUILTIN_DEP_MAP` 加 `"ppt-master": ["python3"]`；`DEP_HINTS` 平台化；i18n（技能描述 + 引导文案）。
3. Python 引导基础层 + 进阶层（§6）。
4. （可选）Rust import 探针。
5. 收尾：ADR（内置 ppt-master 决策）、gotchas §10 追补（体积/token 预期、同名竞态、`--method git` 注记）、CHANGELOG。

**阶段 2（混合更新通道，独立分支）**
6. Rust `ensure_builtin_skills` prune/restore + 单测。
7. Settings：curated 数组加 ppt-master 条目（install prompt 注明 `--method git` + path）+ 内置区遮蔽态 UI + 「恢复内置」按钮。

## 8. 验证清单（阶段 1）

1. 真机 smoke：设置页见 ppt-master（内置区，徽标正确）→ 会话说「帮我做个 PPT」→ skill 触发、`${SKILL_DIR}` 解析正确、八项确认在 chat 阻塞、`projects/<name>/export/*.pptx` 落工作区且产物面板识别。
2. 依赖缺失路径：无 python-pptx 时脚本报错优雅（上游 `error_helper.py`）+ 引导安装 handoff 闭环走通。
3. 长 deck（15 页+）在 qwen 上下文压缩下的规范漂移观察（重点：每页是否仍重读 spec_lock）。
4. 首启拷贝 1.2 万文件耗时 + `.builtin-version` 刷新路径回归（现有内置技能不受影响）。
5. Windows `python3` 命令可用性（可与 Pending Issues 里 Windows Browser MCP 真机验证同批）。

## 9. 遗留风险 / 已知边界

- **上游 bump 连带**：pin tag 升级时重跑 fetch 脚本即可，但需复核 ① SKILL.md 是否新增越界引用 ② `drop` 列表是否仍匹配（上游目录改名）③ requirements 变化 → 依赖徽标/引导文案同步。
- **token 成本**是该技能的固有属性（§3），不随打包方式改变；用户侧预期管理（生成一套 deck ≈ 一次重活）。
- **图标库全量保留**（47M 原始 / 压缩后占 6.6MB 的大头）：`icon_sync.py` 对缺失图标有 re-pick gate，理论可裁库，但会降低设计质量，当前不裁；若未来安装包体积敏感再议。
- AI 配图/搜索/TTS 需 `.env` API key，Ultrawork 无 `.env` 配置 UI —— 阶段 1 接受「高级用户手工配置」，不做产品化。
