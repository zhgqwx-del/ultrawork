# ADR-040: 内置 ppt-master PPT 生成技能（打包路线 + 依赖引导体系）

- 状态：Accepted（✅ 阶段 1 + 阶段 2 均已实现并真机验收；bundle 分发形态与遮蔽 restore 路径已被 ADR-041 修订为 zip + 按前缀解压）
- 日期：2026-07-02
- 关联：discussions/025（完整调研与体积/token 实测）、ADR-032（内置技能管线）、ADR-037（跨平台约束）、gotchas §10/§6

## 背景

项目缺少 PPT 生成能力。[hugohe3/ppt-master](https://github.com/hugohe3/ppt-master)（35.9k★，MIT，约周更）是成熟的 AI 驱动 PPT 生成工作流：源文档 → Strategist 设计规范（spec_lock）→ 主模型逐页手写 SVG → 导出真可编辑 PPTX，且**本身就是标准 Agent Skill 形态**（`skills/ppt-master/SKILL.md` + scripts/references/templates）。逐项适配验证（opencode skill 机制 / `${SKILL_DIR}` 解析 / `projects/` 落 CWD / chat 阻塞式确认 / 无名称冲突）全部兼容，可零改造使用。用户核心诉求：直接使用 + 跟随上游更新 + 弱网环境可用 + 无 Python 时有引导。

## 决策

### D1 — 打包路线 A：随安装包内置（拒绝 curated-only 路线 B）
决定因素是**用户网络环境不可控**（GitHub 不可达则安装时拉取的路线不成立）。体积顾虑被实测推翻：裁掉 `references/ai-image-comparison`（43MB 纯供应商对比说明图）后 gzip **6.6MB**（53MB 落盘 / 1.2 万文件，1.1 万图标 SVG 压缩率 ~8:1）。走 ADR-032 既有管线（`skills/builtin/` + bundle.resources + sentinel），零 vendor 改动。

### D2 — fetch 脚本增强（可复现拉取）
- `sparse: true`：blobless sparse clone 只拉 skill 子目录（整仓 tarball ≈700MB，examples 占 581M）；`--cone` 显式（老 git 非 cone 时根 LICENSE 检不出）；LICENSE 缺失 throw；`subdir: "."` + sparse 组合直接拒绝（防 `.git` 泄漏）。
- 仓库根 LICENSE 自动补拷（子目录无许可文件时的合规兜底）。
- 按名过滤 CLI（`fetch-builtin-skills.ts ppt-master`）：避免重跑把 pin 在 main 的其它技能拉到未审内容。
- ppt-master post-patch（`applyPptMasterPatches`）：`.env.example` 注入「builtin 目录升级重建会清 key → 放 `~/.ppt-master/.env`（上游原生支持）」中英警告；清理指向被裁目录的悬空引用。
- **pin release tag（v2.12.0）**而非 main；bump = 改 tag 重跑 + 复核 drop 列表/越界引用/requirements（discussions/025 §9）。

### D3 — 依赖检测升级：python 内探针 + 引导安装闭环
PATH 存在性探测不够（e2e 首跑即暴露：本机 python3=3.9 而技能硬要求 3.10+，徽标假就绪）。新增：
- Rust `run_python_feature_probe`：单次 `-c` 调用探 `python3.10+`（版本门）+ `python-pptx`（`importlib.util.find_spec`，不真 import）。
- **四防御**（均有 cargo 单测）：`#[tauri::command(async)]`（探针 spawn 进程不占主线程）；`run_probe` 5s 超时+kill+Windows `CREATE_NO_WINDOW`；macOS 无 CLT 时 `/usr/bin/python3` shim 守卫（`xcode-select -p` 先探，防设置页弹系统对话框）；Windows 候选回退 `python`（python.org 不装 python3.exe；商店假 alias 靠执行式探针非零退出过滤）。
- **探针刻意锚定 `python3` 命令**（= 技能脚本实际调用的名字），不接受任意 python3.x 版本化命令——徽标语义 = 技能真实可运行性。
- 引导安装：徽标缺失时「引导安装」按钮 handoff 新对话（复用 curated install 的 `initialInput` 模式）；引导词写死**收敛标准**（新终端 `python3 --version` ≥3.10 且 `import pptx` 成功；版本化命令须 symlink 指过去）——真机验收实测 AI 装出 `python3.11` 未接 symlink 导致闭环不收敛后加固。徽标 tooltip 透出实际探测的解释器路径（`DepStatus.path`）。

### D4 — 连带修复（对抗审查产出）
- **opencode-server sidecar 注入 `PATH=rich_path()`**（此前只 acp-client）：技能 bash 的外部工具解析与探针同源，消除「探针用 A python / 运行时用 B python」错位；Finder 启动下所有技能的 bash 步骤受益。
- **builtin 落地改 staging+rename 原子交换**（`install_builtin_tree`，staging 用点目录避开 skill glob）：12k 文件拷贝中断不再留「sentinel 有效但树残缺」假完成。
- i18n `t()` 插值 split/join（防路径 `$&` 序列）。

### D5 — 刻意不做
- **八项确认不改 question dock**：确认页（localhost:5050）的视觉候选卡片（色卡/字体样张/目录+推荐徽标/两层表单）是设计确认的质量核心，文本化直接损伤产出质量；且阶段 2 用户自装 raw upstream 会与打过 patch 的内置版行为分叉。chat fallback 是上游一等公民，已兜远程/headless。可选的两全增强（app 侧识别 URL 内嵌 webview 承载）列为后续独立特性。
- **不打包 Python 运行时**（沿 ADR-032 D3：检测+引导；pip 走国内镜像把网络暴露面压到最小）。

## 阶段 2（✅ 已实现，2026-07-02，同分支；两轮共 6 路对抗审查 + 真机全链验收）
「内置保底 + curated 自助更新」混合形态三件套同批落地：

### D6 — Rust 文件层确定性遮蔽（`reconcile_builtin_shadowing`）
同名 skill 在同一 glob 扫描 unbounded 并发下谁赢是竞态（源码核验）→ 在扫描面上只留一份：**prune**（存在同名用户技能 → 删 builtin 磁盘副本；按 frontmatter name 匹配非目录名；用户版永久胜出、跨升级不回退）/ **restore**（用户版移除 → bundle 经 `.builtin.restore` staging+rename 补拷；门=SKILL.md 精确大小写存在 → 残缺树自愈）。**遮蔽判定 = 整块镜像 opencode 注册谓词**（name+description 双必需 + 任一行 js-yaml 抛错即整文件不注册），分歧一律 fail-open（不 prune）——反向错误会让技能两边皆无；配「全部真实 bundled SKILL.md 解析通过」cargo 回归。三入口 `BUILTIN_SKILLS_LOCK` 串行化（并发共享 staging 会落残缺树且 sentinel 有效）。命令 `refresh_builtin_skills`（返回 `{bundled, shadowed, changed}`）/ `remove_user_skill_override`（只认 shadowed 名 + 路径双护栏 + 拒绝 symlink 祖先删除、直接 symlink 只删 link）。
### D7 — curated 自助更新条目 + 遮蔽态 UI
`INSTALLABLE_SKILLS` 加 ppt-master（`method:"git"` → prompt 强制 `--method git` sparse，auto 模式会下数百 MB 整仓 zip）；installed 判定改「存在非 builtin 同名项」。内置区遮蔽卡（永久遮蔽规则 + raw upstream 无 D2 post-patch 差异文案）+ 确认 Dialog + 恢复流（删用户目录 + reconcile + `POST /global/refresh` 软刷新即时生效，ADR-039）。**`changed` 协调契约**：动了磁盘的 reconcile 由 SkillsSection 精确一次跟进 soft refresh + 重取（identity 去重）；命令先变更后 Err 时 catch 必须无条件链 refresh。workspace 切换补 best-effort reconcile 收窄 mid-session 竞态窗。
### 阶段 2 刻意边界
遮蔽只覆盖 config-dir `skill|skills` 两根（`~/.claude/skills`/project/`skills.paths` 同名仍竞态）；mid-session 安装到下一 reconcile 触点间的新 instance 扫描窄竞态窗未硬关闭。可选增强（确认页/预览 URL 的 app 内嵌 webview 承载）仍留后续。
### 验证
cargo 29（谓词镜像 ×10/junk 不遮蔽/残树自愈/symlink/大小写/changed）· vitest 278 · e2e `builtin-shadowing`（真 opencode：竞态记录→prune 用户版胜出→restore 回归，全程软刷新）3/3 + `builtin-shadow-ui`（Chrome+Vite+真 fs helper）12/12 · **真机全链**（curated 安装 86M/12143 文件 → 启动日志 `pruned` 实证接线 → API 用户版确定性胜出 → 恢复闭环 `removed`+`restored`、12086 文件回归、无 staging 遗留、不重启即时切回内置版）。

详见 discussions/025 §5/§7、gotchas §10（遮蔽三条目）。

## 影响

- 新增 `skills/builtin/ppt-master/`（53MB/1.2 万文件，git 跟踪）；安装包三平台各约 +7MB。
- `scripts/fetch-builtin-skills.ts`（sparse/LICENSE/过滤/post-patch）；`lib.rs`（探针体系 + `install_builtin_tree` + opencode PATH 注入）；`use-skill-deps.ts`/`Settings.tsx`/`i18n-context.tsx`（依赖表/平台化 hints/引导按钮）。
- 测试：cargo +4（探针解析/拒绝、超时 kill、原子落地、命令项完备）；desktop vitest 更新；e2e ×2（`builtin-ppt` 真 opencode 发现 5 项 / `builtin-ppt-ui` 真浏览器走查 6 项）。
- 已知代价：单次完整 deck 生成消耗几十万 token（上游刻意设计：逐页手写 SVG、禁子代理）；AI 配图/TTS 需自配 API key（`~/.ppt-master/.env`）。
