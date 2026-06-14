#!/usr/bin/env bun
/**
 * 导出「Agent OS 参考包」——给从本项目 fork 出去、想参考实现 Agent OS 的项目用。
 *
 * 用 `git archive` 出当前 HEAD 的相关源码 + 全量 docs（只含 git 跟踪文件，自动
 * 排除 node_modules/dist/tsbuildinfo），并把移植引导 prompt 放到包根，打成一个
 * 自包含 tarball。拷到 fork 机器后：
 *   mkdir -p reference/ultrawork && tar xzf <kit> -C reference/ultrawork
 * 然后把 reference/ultrawork/AGENTOS-PORT-PROMPT.md 当首条 prompt 喂给 agent。
 *
 * 用法：
 *   bun run --bun scripts/export-agentos-ref.ts [--out=<path>]
 * 默认输出：/tmp/ultrawork-agentos-kit.tar.gz
 */
import { $ } from "bun"
import path from "path"
import os from "os"
import { mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs"

const rootDir = path.resolve(import.meta.dir, "..")

// git 跟踪路径集（git archive 只取被跟踪的，故 node_modules/dist/*.tsbuildinfo 天然排除）。
// 增减参考范围在这里改一处。
const PATHSPEC = [
  "docs",
  "AGENTS.md",
  "CLAUDE.md",
  "CHANGELOG.md",
  "scripts",
  "patches",
  "turbo.json",
  "package.json",
  "tsconfig.json",
  "packages/agent/acp-client",
  "packages/core", // api-client / connector / orchestrator / server-manager
  "packages/client/desktop/src",
  "packages/client/desktop/src-tauri/src",
  "packages/client/desktop/package.json",
  "packages/client/desktop/vite.config.ts",
  "packages/client/desktop/tsconfig.json",
]

// 移植引导 prompt（权威源就在这里——改 prompt 改这个常量即可）。
const PORT_PROMPT = `# Agent OS 移植引导 prompt（粘贴给 fork 项目的 agent）

> 把本目录（\`reference/ultrawork/\`）作为只读权威参考。先读 \`docs/agent-os-kickoff.md\`。

---

你在「<FORK 项目名>」仓库里工作——它从 Ultrawork fork 出来后已独立迭代多次，
整体架构与 Ultrawork「做 Agent OS 之前」的基线一致，但之后两边各自分叉。

目标：参照 Ultrawork 的 Agent OS 设计，在本项目也实现一遍——「经 ACP 协议
统一调度多个异构 agent（opencode/claude/gemini/qoder…）+ connector 控制层
+ orchestrator 跨厂商编排 + Team 协作 UX」。

参考材料在 \`reference/ultrawork/\`（只读，权威源，按此优先级）：
1. 启动指引：docs/agent-os-kickoff.md（先读）
2. 设计 SSOT：docs/agent-os-target-architecture.md（§0 基线表）
3. 决策：docs/decisions/027(ACP)、030(connector)、031(orchestrator)、029(回合渲染)
4. 当前实现总览：docs/architecture-phase1.md、AGENTS.md
5. 推导与纠偏（理解"为什么这么做"，注意 discussions 含早期失实/纠偏记录，
   以 ADR/§0 为准）：docs/discussions/013-019
6. 实现模式与契约：docs/conventions.md §3/§5/§11、docs/api-reference.md
7. 必读反向坑点：docs/gotchas.md §1/§8/§9（务必先读，避免重复踩坑）
8. 参考源码：packages/{agent/acp-client, core/connector, core/orchestrator}、
   desktop 的 components/chat/* + lib/* + components/settings/{agents-section,
   agent-templates}、src-tauri/src/lib.rs（sidecar 启动/凭证/配置隔离）、
   vite.config.ts（代理）、scripts/build-acp.ts（sidecar 构建链）

硬性要求：
- 这是**引导式重实现，不是移植**。先做「差异分析」：对照 Ultrawork 的
  agent-os 前基线，搞清本项目分叉后哪些前置结构不同（api-client/SSE 形状/
  消息渲染方式/sidecar 模式/状态管理/构建链），以及 Ultrawork 的 agent-os 层
  **依赖哪些前置契约**（connector 建在 api-client 之上、ADR-029 回合分组渲染、
  opencode-SSE 事件形状、ACP turn 整形契约）。**不要逐行照抄**——按本项目的
  实际结构适配。
- 分阶段，**严格对齐 Ultrawork 的阶段划分**，每阶段独立可验收：
  - 阶段0-1 = @agent/acp-client（ACP sidecar :4099 + TurnShaper 整形成
    opencode-SSE 形状 + W3 权限回环 + W4b 会话历史持久化 + Home 出生即绑定 +
    AgentSelector 锁定）
  - 阶段2 = @agent/connector（可插拔 backend adapter：OpenCodeBackend/
    ACPBackend + 参数化 SSE transport + capabilities 门控 + 绑定持久化 hydrate）
  - 阶段3 = @agent/orchestrator（spawn/await/steer/cancel 原语 + 治理护栏 +
    runTurn 双语义终态检测 + Pipeline/Fan-out + 宿主 MCP delegate bridge +
    子会话防递归/防侧栏污染）+ Team UX（Leader 会话 + 成员选择 + per-backend
    system 注入 + 委派卡片/产物区）
- **每个阶段：先产出「计划 + 关键文件 + 风险」给我 review，我批准后才写代码。**
  不要一次性把全部阶段都实现。
- 质量门（每阶段收尾必过）：typecheck 全绿 + 单测 + 真机走查。真机走查照
  Ultrawork 纪律——隔离栈（备用端口 + XDG=/tmp 隔离 + 拷入 auth.json + 按 PID
  核归属+清理）、**绝不碰真实数据**、批量删除走 \`?directory=\` 过滤 + 对每行
  \`directory\` 字段二次断言 + 打印清单人工核对（gotchas §2 血泪）。
- 接新 ACP agent 走 branch A 零 bespoke（模板 + agents.json）；接前先跑一个
  gating spike 确认协议版本协商 + session/update 够富（参考 acp-client/scripts/
  spike-*.ts）。

现在**先只做第一步：差异分析 + 整体分阶段实现计划**（不写任何代码）。
重点说明：本项目哪些结构与 Ultrawork 基线不同、会如何影响 agent-os 各层的
落地、每阶段的关键改动点与顺序、以及最大的几个风险。
`

const outArg = process.argv.find((a) => a.startsWith("--out="))?.slice("--out=".length)
const out = path.resolve(outArg ?? "/tmp/ultrawork-agentos-kit.tar.gz")

const stage = mkdtempSync(path.join(os.tmpdir(), "agentos-kit-"))
try {
  console.log(`[export] git archive HEAD → staging (${PATHSPEC.length} pathspecs)`)
  const innerTar = path.join(stage, "_inner.tar")
  await $`git -C ${rootDir} archive --format=tar -o ${innerTar} HEAD -- ${PATHSPEC}`.quiet()

  const content = path.join(stage, "content")
  await $`mkdir -p ${content}`.quiet()
  await $`tar xf ${innerTar} -C ${content}`.quiet()
  rmSync(innerTar)

  // Drop the port prompt at the kit root (权威源 = 本脚本的 PORT_PROMPT 常量).
  writeFileSync(path.join(content, "AGENTOS-PORT-PROMPT.md"), PORT_PROMPT)

  await $`tar czf ${out} -C ${content} .`.quiet()

  const sizeMB = (statSync(out).size / 1024 / 1024).toFixed(1)
  const count = (await $`tar tzf ${out}`.text()).trim().split("\n").length
  console.log(`[export] ✅ wrote ${out}`)
  console.log(`[export]    ${sizeMB} MB · ${count} files (incl. AGENTOS-PORT-PROMPT.md)`)
  console.log(`\n下一步（在 fork 仓库根目录）：`)
  console.log(`  mkdir -p reference/ultrawork && tar xzf ${out} -C reference/ultrawork`)
  console.log(`  然后把 reference/ultrawork/AGENTOS-PORT-PROMPT.md 当首条 prompt 喂给 agent。`)
} finally {
  rmSync(stage, { recursive: true, force: true })
}
