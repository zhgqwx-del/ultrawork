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
| `session/llm.ts` | ① `idleGuard`：LLM 流式工具感知两级 idle 超时（首字前 90s/后 30s，`Set<toolCallId>` 豁免工具执行，触发 abort+plain Error 落 error 终态）② streamText `experimental_context:{sessionID}` 暴露给工具 execute（委派归属，discussions/022） | ADR-034 / 022 |
| `session/prompt.ts` | 每 step `resolveTools` 后 fire `experimental.chat.tools.transform` 钩子（含 `usedToolIds`），供渐进式工具披露引擎改写工具表 | discussions/023 |
| `plugin/src/index.ts` (`@opencode-ai/plugin`) | 新增 `experimental.chat.tools.transform` 钩子类型 | discussions/023 |
| `plugin/index.ts` | 注册内置插件 `ToolDisclosurePlugin` 进 `INTERNAL_PLUGINS` | discussions/023 |
| `plugin/tool-disclosure.ts` (**新文件**) | 渐进式工具披露引擎：折叠低频工具→name-only 名录(system)+`tool_search`，按需提升为原生；静态名录/会话清理/grace 安全降级；由 `experimental.tool_disclosure` config flag 或 `ULTRAWORK_TOOL_DISCLOSURE` env 门控 | discussions/023 |
| `config/config.ts` (追加) | experimental schema 增 `tool_disclosure` / `tool_disclosure_debug` | discussions/023 |
| `effect/soft-invalidate-registry.ts` (**新文件**) | 与 disposer 平行的「软失效器」集合：`registerSoftInvalidator`/`softInvalidate(dir)`（返回 settled 结果供上层报失败） | ADR-039 |
| `effect/instance-state.ts` | `make(init, {soft})` 旗标 + `makeSoft` 包装：soft state 额外注册进软失效集合（复用同一 invalidator） | ADR-039 |
| `project/instance.ts` | `softRefreshAll()`：遍历活跃目录只软失效（惰性驱逐），失败 `log.warn` 不静默；**不** disposeAll | ADR-039 |
| `config/config.ts` (追加) | `refreshGlobal()`（软：`invalidateGlobal` + `softRefreshAll`，不 dispose）+ `updateGlobal(config,{soft})` 模式 + Interface/Service/public wrapper | ADR-039 |
| `skill/index.ts` · `agent/agent.ts` · `command/index.ts` · `format/index.ts` · `provider/provider.ts` · `provider/auth.ts` · `tool/registry.ts` | `make`→`makeSoft`（8 个配置派生纯缓存标记可软失效；config 也标） | ADR-039 |
| `server/routes/global.ts` | `PATCH /global/config?refresh=soft`（写+软刷新；缺省仍 hard disposeAll）+ 新增 `POST /global/refresh`（只软刷新不写） | ADR-039 |

## 修改 vendor/opencode 的完整流程

### 新增 / 修改 patch

```bash
# 1. 直接编辑 vendor/opencode 下的源码
vim vendor/opencode/packages/opencode/src/...

# 2. 重新生成 patch 文件（覆盖旧的）
#    ⚠️ 必须列全 patch 涉及的所有文件，漏掉任何一个都会在重新生成时丢失对应改动
#    ⚠️ 新文件（如 tool-disclosure.ts）必须先 `git add -N` 才会出现在 git diff 里
cd vendor/opencode && \
git add -N packages/opencode/src/plugin/tool-disclosure.ts packages/opencode/src/effect/soft-invalidate-registry.ts && \
git diff -- \
  packages/opencode/src/config/config.ts \
  packages/opencode/src/config/paths.ts \
  packages/opencode/src/global/index.ts \
  packages/opencode/src/mcp/index.ts \
  packages/opencode/src/session/llm.ts \
  packages/opencode/src/session/prompt.ts \
  packages/opencode/src/plugin/index.ts \
  packages/opencode/src/plugin/tool-disclosure.ts \
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
  packages/opencode/src/server/routes/global.ts \
  packages/plugin/src/index.ts \
  packages/opencode/script/build.ts \
  > ../../patches/vendor-opencode-config-fix.patch && \
git reset -q packages/opencode/src/plugin/tool-disclosure.ts packages/opencode/src/effect/soft-invalidate-registry.ts   # 取消 intent-to-add，保持 submodule index 干净

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
| `setup.sh` 第 3 步 | 自动 apply `patches/vendor-opencode-*.patch`（`git apply --check` 幂等） |
| `scripts/build-opencode.ts` | 编译前检测 sentinel，未 apply 则自动 apply（双重保障） |
| `scripts/sync-plugin-version.ts` | submodule 更新后运行，重新 apply + 更新版本 + 重新生成 patch |

**其他人 clone 后只需 `./setup.sh` 即可**——submodule init + patch apply + build 全自动。
