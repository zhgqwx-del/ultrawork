# ADR-040: 内置 ppt-master PPT 生成技能（打包路线 + 依赖引导体系）

- 状态：Accepted（✅ 阶段 1 已实现并真机验收；阶段 2 见下）
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

## 阶段 2（待做，独立分支）
「内置保底 + curated 自助更新」混合形态：设置页推荐安装区加条目（install prompt 注明 `--method git` sparse）+ **Rust `ensure_builtin_skills` prune/restore 确定性遮蔽**（用户版永远优先；同名 skill 在同一 glob 扫描 unbounded 并发下谁赢是竞态，**不能天真并存**——已源码核验）+ 遮蔽态 UI 与「恢复内置」。注意用户自装版是 raw upstream（无 D2 post-patch）。详见 discussions/025 §5/§7。

## 影响

- 新增 `skills/builtin/ppt-master/`（53MB/1.2 万文件，git 跟踪）；安装包三平台各约 +7MB。
- `scripts/fetch-builtin-skills.ts`（sparse/LICENSE/过滤/post-patch）；`lib.rs`（探针体系 + `install_builtin_tree` + opencode PATH 注入）；`use-skill-deps.ts`/`Settings.tsx`/`i18n-context.tsx`（依赖表/平台化 hints/引导按钮）。
- 测试：cargo +4（探针解析/拒绝、超时 kill、原子落地、命令项完备）；desktop vitest 更新；e2e ×2（`builtin-ppt` 真 opencode 发现 5 项 / `builtin-ppt-ui` 真浏览器走查 6 项）。
- 已知代价：单次完整 deck 生成消耗几十万 token（上游刻意设计：逐页手写 SVG、禁子代理）；AI 配图/TTS 需自配 API key（`~/.ppt-master/.env`）。
