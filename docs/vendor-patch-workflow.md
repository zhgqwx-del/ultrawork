# Vendor Patch 管理（vendor/opencode）

> 从 CLAUDE.md 外移（2026-07-03，CLAUDE.md 瘦身，程序性长流程按需加载）。**动 `vendor/opencode/` 源码前必读本文**；CLAUDE.md 只保留核心规则摘要。

`vendor/opencode` 是 git submodule，Ultrawork 在其基础上有**本地 patch**（配置隔离、bug 修复等）。Patch 以 `.patch` 文件形式存储在 `patches/` 目录，由构建脚本自动 apply。

## 核心规则

1. **不要直接 commit 到 submodule**——所有对 `vendor/opencode/` 的源码修改必须通过 patch 文件管理
2. **Patch 文件是 git 跟踪的**——`patches/vendor-opencode-config-fix.patch` 提交在主仓库
3. **Submodule 本身保持指向 upstream commit**——`vendor/opencode (modified content)` 是正常状态

## 当前 patch 内容

`patches/vendor-opencode-config-fix.patch` 包含所有 vendor 修改（单文件累加）：

| 文件 | 修改内容 | 关联 ADR |
|------|---------|---------|
| `global/index.ts` | `OPENCODE_APP_NAME` env var 控制 app 名称 | ADR-020 |
| `config/config.ts` | managed dir 对齐 + endsWith 过滤 + PINNED_PLUGIN_VERSION + config.json→opencode.json 修复 | ADR-020 |
| `config/paths.ts` | 跳过 `~/.opencode/` home 目录搜索 | ADR-020 |
| `mcp/index.ts` | ① MCP 启动握手超时拆为 `CONNECT_TIMEOUT = 5s`（runtime tool 仍 30s）② MCP 工具 execute 把 `options.experimental_context.sessionID` 注入 `callTool` 的 `_meta.ultrawork_session`（委派归属，discussions/022） | ADR-028 / 022 |
| `script/build.ts` | 新增 `--target=<os>-<arch>` 单目标过滤，支持跨编译 darwin-x64（Universal DMG） | ADR-028 |
| `app/package.json` · `bun.lock` | 将 `ghostty-web` 声明固定到原锁提交完整 SHA `4af877d52b523754f113b87084b69835b752fb2c`；保留原 resolution、integrity 与其他依赖，避免浮动 `#main` 在构建时漂移 | ADR-075 构建补齐 |
| `session/llm.ts` | ① `idleGuard`：LLM 流式工具感知两级 idle 超时（首字前 90s/后 30s，`Set<toolCallId>` 豁免工具执行，触发 abort+plain Error 落 error 终态）② streamText `experimental_context:{sessionID}` 暴露给工具 execute（委派归属，discussions/022） | ADR-034 / 022 |
| `session/prompt.ts` | 每 step `resolveTools` 后 fire `experimental.chat.tools.transform` 钩子（含 `usedToolIds`），供渐进式工具披露引擎改写工具表 | discussions/023 |
| `session/system.ts` | 适配 8 个 stock provider 基座的已知身份句；移除与宿主身份冲突的模型名自我声明（实际模型路由不变）；在拼接自定义/Team/用户系统提示前处理，保留其余模型策略与来源链接 | ADR-075 |
| `plugin/src/index.ts` (`@opencode-ai/plugin`) | 新增 `experimental.chat.tools.transform` 钩子类型 | discussions/023 |
| `plugin/index.ts` | 注册内置插件 `ToolDisclosurePlugin` 进 `INTERNAL_PLUGINS` | discussions/023 |
| `plugin/tool-disclosure.ts` (**新文件**) | 渐进式工具披露引擎：折叠低频工具→name-only 名录(system)+`tool_search`，按需提升为原生；静态名录/会话清理/grace 安全降级；由 `experimental.tool_disclosure` config flag 或 `ULTRAWORK_TOOL_DISCLOSURE` env 门控 | discussions/023 |
| `config/config.ts` (追加) | experimental schema 增 `tool_disclosure` / `tool_disclosure_debug` | discussions/023 |
| `plugin/rich-output.ts` (**新文件**) | 经 `experimental.chat.system.transform` **追加**产品身份和自适应格式规则；模型基座仅在 provider 选择时适配已知身份句，其余策略保留；`experimental.rich_output` / `ULTRAWORK_RICH_OUTPUT` 仅控制格式规则，产品身份始终追加且不扩展用户任务 | discussions/048 / ADR-075 |
| `plugin/brand-identity.ts` (**新文件**) | 从既有 runtime context 验证并读取产品身份，默认 Ultrawork；无外层 workspace 依赖，受管缺失/冲突在实际 transform 阶段阻止模型请求 | ADR-075 |
| `plugin/index.ts` (追加) | 注册 `RichOutputPlugin` 进 `INTERNAL_PLUGINS` | discussions/048 |
| `config/config.ts` (追加) | experimental schema 增 `rich_output`（默认 ON，kill switch） | discussions/048 |
| `effect/soft-invalidate-registry.ts` (**新文件**) | 与 disposer 平行的「软失效器」集合：`registerSoftInvalidator`/`softInvalidate(dir)`（返回 settled 结果供上层报失败） | ADR-039 |
| `effect/instance-state.ts` | `make(init, {soft})` 旗标 + `makeSoft` 包装：soft state 额外注册进软失效集合（复用同一 invalidator） | ADR-039 |
| `project/instance.ts` | `softRefreshAll()`：遍历活跃目录只软失效（惰性驱逐），失败 `log.warn` 不静默；**不** disposeAll | ADR-039 |
| `config/config.ts` (追加) | `refreshGlobal()`（软：`invalidateGlobal` + `softRefreshAll`，不 dispose）+ `updateGlobal(config,{soft})` 模式 + Interface/Service/public wrapper | ADR-039 |
| `skill/index.ts` · `agent/agent.ts` · `command/index.ts` · `format/index.ts` · `provider/provider.ts` · `provider/auth.ts` · `tool/registry.ts` | `make`→`makeSoft`（8 个配置派生纯缓存标记可软失效；config 也标） | ADR-039 |
| `server/routes/global.ts` | `PATCH /global/config?refresh=soft`（写+软刷新；缺省仍 hard disposeAll）+ 新增 `POST /global/refresh`（只软刷新不写） | ADR-039 |
| `tool/websearch.ts`（**整文件重写**） | 多 provider BYOK 搜索：Tavily/阿里云 IQS REST 分发（key 走 auth.json `search-tavily`/`search-aliyun-iqs` 现读）+ Exa 显式 opt-in；优先级显式>tavily>iqs>exa、`provider:"auto"` 哨兵；纯函数（resolve/parse/format）供 `scripts/websearch/websearch-unit-test.ts`；endpoint env 可覆盖（`ULTRAWORK_TAVILY_BASE_URL` 等） | ADR-042 |
| `tool/websearch.txt` | 描述重写：多源搜索、调研/时事优先用本工具、depth/timeRange 说明（保留 `{{year}}` 注入） | ADR-042 |
| `tool/registry.ts`（追加） | websearch 门控改「`enabled!==false` 且（hosted‖EXA flag‖已配置）」；可用性检查 `catch(()=>false)` 降级（Effect defect 会杀回合）；codesearch 门控不动 | ADR-042 |
| `config/config.ts`（追加） | experimental schema 增 `websearch`（enabled/provider〔含 auto〕/exa/tavily.searchDepth/aliyunIqs.engineType） | ADR-042 |
| `server/routes/global.ts`（追加） | `GET /global/auth/:authId/status` 只读 key 存在性端点（永不回显 secret） | ADR-042 |
| `plugin/tool-disclosure.ts`（追加） | `websearch` 从 COLLAPSE 移入 EAGER（BYOK 门控保证注册即用户已配置） | ADR-042 |
| `provider/provider.ts`（追加） | config 扩展循环两处上游合并缺陷修复：`interleaved` 补 `existingModel` 回落（部分模型覆写不再破坏 reasoning_content 解析）+ cost 重建补 `experimentalOver200K`（分层计价不丢） | ADR-042 |

## 修改 vendor/opencode 的完整流程

### 新增 / 修改 patch

```bash
# 1. 直接编辑 vendor/opencode 下的源码
vim vendor/opencode/packages/opencode/src/...

# 2. 重新生成 patch 文件（覆盖旧的）
#    ⚠️ 必须列全 patch 涉及的所有文件，漏掉任何一个都会在重新生成时丢失对应改动
#    ⚠️ 新文件（如 tool-disclosure.ts）必须先 `git add -N` 才会出现在 git diff 里
cd vendor/opencode && \
git add -N packages/opencode/src/plugin/tool-disclosure.ts packages/opencode/src/plugin/rich-output.ts packages/opencode/src/plugin/brand-identity.ts packages/opencode/src/effect/soft-invalidate-registry.ts && \
git diff -- \
  bun.lock \
  packages/app/package.json \
  packages/opencode/src/config/config.ts \
  packages/opencode/src/config/paths.ts \
  packages/opencode/src/global/index.ts \
  packages/opencode/src/mcp/index.ts \
  packages/opencode/src/session/llm.ts \
  packages/opencode/src/session/system.ts \
  packages/opencode/src/session/prompt.ts \
  packages/opencode/src/plugin/index.ts \
  packages/opencode/src/plugin/tool-disclosure.ts \
  packages/opencode/src/plugin/rich-output.ts \
  packages/opencode/src/plugin/brand-identity.ts \
  packages/opencode/src/effect/soft-invalidate-registry.ts \
  packages/opencode/src/effect/instance-state.ts \
  packages/opencode/src/project/instance.ts \
  packages/opencode/src/skill/index.ts \
  packages/opencode/src/agent/agent.ts \
  packages/opencode/src/command/index.ts \
  packages/opencode/src/format/index.ts \
  packages/opencode/src/provider/provider.ts \
  packages/opencode/src/provider/auth.ts \
  packages/opencode/src/tool/registry.ts \
  packages/opencode/src/tool/websearch.ts \
  packages/opencode/src/tool/websearch.txt \
  packages/opencode/src/server/routes/global.ts \
  packages/plugin/src/index.ts \
  packages/opencode/script/build.ts \
  > ../../patches/vendor-opencode-config-fix.patch && \
git reset -q packages/opencode/src/plugin/tool-disclosure.ts packages/opencode/src/plugin/rich-output.ts packages/opencode/src/plugin/brand-identity.ts packages/opencode/src/effect/soft-invalidate-registry.ts   # 取消 intent-to-add，保持 submodule index 干净

# 3. 如果再新增文件，在 git diff 命令中追加路径（新文件记得也 git add -N）
# 4. 重编译 sidecar
bun run --bun scripts/build-opencode.ts

# 5. 提交 patch 文件（不提交 submodule 变更）
git add patches/vendor-opencode-config-fix.patch
```

### 更新 vendor/opencode submodule

```bash
# 1. 拉取 upstream 新版本
cd vendor/opencode && git fetch origin dev && git checkout <new-commit> && cd ../..

# 2. 运行同步脚本（auto-apply patch + 更新 PINNED_PLUGIN_VERSION + 重新生成 patch）
bun run scripts/sync-plugin-version.ts

# 3. 如果 patch apply 失败（upstream 改了 patch 涉及的代码）：
#    - 手动在 vendor 源码中解决冲突
#    - 重新生成 patch 文件（见上方步骤 2）
#    - 重新运行 sync-plugin-version.ts

# 4. 重编译 sidecar
bun run --bun scripts/build-opencode.ts

# 5. 提交
git add vendor/opencode patches/vendor-opencode-config-fix.patch
```

> ⚠️ bump submodule 前必读 `docs/discussions/020-vendor-bump-perf-regression.md` + 本地记忆 `vendor-opencode-bump-survey.md`；连带复核事项见 MEMORY Pending Issues（工具披露 EAGER 表、plan 面板 TodoWrite 语义等）。

## 自动化保障

| 入口 | 行为 |
|------|------|
| `scripts/vendor-patches.ts`（setup、依赖安装、build 共用） | 检查独立 vendor Git 工作树与 canonical patch；全部文件先预检，再补齐尚未应用的文件，冲突时拒绝安装/构建，不重置用户文件 |
| `scripts/vendor-dependencies.ts` | 先应用累计 patch，再执行 `bun install --frozen-lockfile --os=* --cpu=*`，拒绝缺失/空锁并检查依赖输入未变 |
| `scripts/build-opencode.ts` | 共享 patch/冻结安装；上游构建传 `--skip-install`，避免再次非冻结安装。锁、workspace manifests、配置、依赖补丁和辅助模块均纳入缓存哈希；缓存命中也校验 metadata/二进制摘要 |
| `scripts/sync-plugin-version.ts` | submodule 更新后运行，重新 apply + 更新版本 + 重新生成 patch |

**其他人 clone 后只需 `bun run setup`（三平台）或 `./setup.sh`（macOS / Linux）即可**——submodule init + patch apply + build 全自动。Shell 入口只转发到统一的 TypeScript 实现，品牌配置及临时参数原样传递；相对路径按调用者当前目录解析。例如：`./setup.sh --build --brand branding/mywork/brand.json`。

版本同步从当前累计 patch 动态提取完整文件集合，使用临时 Git index 包含新增文件，校验新 patch 可反向应用后原子替换；不改真实 index，也不会把其他已暂存/未跟踪文件混入。新增 vendor 文件时仍须先按上面的完整流程把它纳入累计 patch；同步脚本不会自动收录任意新文件。即使插件版本未变，也会先补齐尚未应用的 manifest/lock pin。

### 构建依赖与源码 patch 的边界

ADR-075 品牌身份复用了既有 `OPENCODE_APP_NAME`，没有更换 submodule commit。后续依赖冻结补齐将两个各一行的 manifest/lock 声明改动纳入原有累计 patch；`ghostty-web` 保留 upstream 原锁的 `4af877d`，未带入构建期间出现的无关 `6e24d04` 升级。累计 patch 现覆盖 28 个文件（包含身份适配器与 stock provider 自介适配）。

Bun 1.3.12 对 `ghostty-web#main` 仍会重新解析分支；仅恢复旧锁并加 frozen 会拒绝安装，因此须同时固定 manifest 和锁中的声明。setup、CI/release 和公共 sidecar 构建使用冻结入口；不要直接运行上游 vendor build 的默认安装流程。需要主动升级依赖时，显式修改并审阅 manifest/lock，再更新累计 patch。

冻结子进程会清除 Bun 内部的 `BUN_CONFIG_SKIP_LOAD_LOCKFILE`、`BUN_CONFIG_SKIP_INSTALL_PACKAGES` 和 `BUN_CONFIG_SKIP_SAVE_LOCKFILE` 环境覆盖；前两项可分别绕过锁验证或跳过安装，不能只检查锁文件未变。检测安装或编译期间输入漂移时构建失败，不自动恢复文件或导出新缓存。依赖冻结不承诺版本时间、模型目录、签名或整个二进制逐字节相同。

2026-10-29 已完成仓库外干净子仓库、空下载缓存、无 node_modules 的真实冻结安装（5067 包）及内嵌 Web UI/Intel sidecar 冷构建；同一锁下五目标 OpenCode 真实编译通过。Windows/Linux 原生安装与运行边界见 [testing §16](./testing.md#16-独立品牌发行版的验证adr-075)。
