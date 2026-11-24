# STDD/SDD 接入验收记录

## 接入前行为基线

- 日期 2026-11-24，macOS arm64，Bun 1.3.12，Python 3.12.16。
- 受测业务代码基于本地 `main` 的 `ecd452ed3f69e765ec51fa71fa4c4bd3304a7620`。接入前已有 `vendor/opencode` 的本地改动和未跟踪的 `.agents/skills/init-stdd/`。部分行为用例在写入协作文档后复跑，受测应用代码及用例相同。
- 本地 `origin/main` 指向同一提交。首个业务变更开工时需重新核对远端和合入目标。

以下命令在各行列出的目录运行，使用仓库测试夹具。

| 目录 | 命令 | 实际结果 |
| --- | --- | --- |
| 仓库根目录 | `bun run --bun scripts/check-docs.ts` | 接入前未发现文档漂移。由于本机没有 Claude Code 的 auto-memory，跳过 MEMORY 行数检查 |
| `packages/client/desktop` | `bun run --bun vitest run src/__tests__/lib/startup-gate.test.ts src/__tests__/components/startup-blocked.test.tsx src/__tests__/lib/free-model.test.ts src/__tests__/lib/use-session-messages-freetrial-fallback.test.ts src/__tests__/lib/team-sessions-context.test.tsx src/__tests__/pages/session-team-restoration.test.tsx` | 6 个测试文件，100 项通过。覆盖启动门禁与诊断页、免费模型回退、Team 会话恢复 |
| `packages/core/connector` | `bun run --bun vitest run src/__tests__/connector.test.ts src/__tests__/binding-store.test.ts` | 2 个测试文件，28 项通过。覆盖绑定水合、后端派发与事件订阅 |
| `packages/core/connector` | `bun run --bun vitest run src/__tests__/sse-recovery.test.ts` | 1 个测试文件，5 项通过。使用本地 HTTP 服务验证断流与恢复 |
| `packages/core/orchestrator` | `bun run --bun vitest run src/__tests__/orchestrator.test.ts src/__tests__/fanout.test.ts src/__tests__/delegate.test.ts` | 3 个测试文件，50 项通过。覆盖 DAG 执行、Fan-out、取消及委派 |
| `packages/channel/gateway` | `bun run --bun vitest run src/__tests__/bridge.test.ts src/__tests__/session-store.test.ts` | 2 个测试文件，85 项通过。覆盖渠道映射、会话复用、轮转与持久化 |
| `packages/knowledge/sidecar` | `bun test src/doc-parser.test.ts src/watcher.test.ts src/kb-server-auth.test.ts` | 3 个测试文件，19 项通过。覆盖文档解析、文件监听和 API 鉴权 |
| `packages/knowledge/sidecar` | `bun test src/kb-server-sse-lifetime.test.ts` | 1 个测试文件，1 项通过。空闲索引进度流保持到 16 秒，对照连接提前超时 |

Connector 恢复及知识库 SSE 用例首次运行受限于沙箱无法监听本地端口。开放回环监听后按表中命令复跑通过。桌面启动的行为与验证入口见[现行规格](../../../specs/desktop-startup/spec.md)，原生包及独立品牌数据租约的验证见[测试规划](../../../docs/testing.md)。

## 接入验收

| 检查 | 实际结果 |
| --- | --- |
| `python3 -B scripts/check_traceability.py` | 1 份现行规格，2 条需求，4 个验收场景 |
| `bun run --bun scripts/check-docs.ts --selftest` | 33 项自检通过 |
| `bun run --bun scripts/check-docs.ts` | 新增工程文档登记后检查通过 |
| `bun run --bun turbo run typecheck --force` | 9 个工作区执行并通过 |
| 变更生成器 | 临时目录执行 `new_change.py --roles --design` 生成 7 份文档。重复运行被拒绝，已有文件内容保持完整 |

## 收尾复核

从 GitHub 刷新 `origin/main` 后，目标与接入前的 `ecd452ed3f69e765ec51fa71fa4c4bd3304a7620` 一致。受测候选为该基线加本次 STDD/SDD 接入差异。复核覆盖协作文档、规格和验收证据、技能、开发脚本及文档 CI。桌面启动规格对应既有实现和用例。

| 检查 | 实际结果 |
| --- | --- |
| `python3 -B scripts/check_traceability.py` | 正式规格 1 份、需求 2 条、验收场景 4 个，检查通过。临时夹具验证空规格和未知需求引用均被拒绝，有效规格通过 |
| `PYTHONIOENCODING=cp1252 python3 -B scripts/git_range.py 6eaf4229^ 6eaf4229` | 用 Windows 代码页模拟复现修复前的中文输出错误，修复后中文提交标题完整 |
| 桌面启动定向回归 | 复跑上表的启动门禁和诊断页测试，2 个文件、11 项通过 |
| 文档检查与类型检查 | `check-docs.ts` 的 33 项自检及文档漂移检查通过，强制执行 9 个工作区的类型检查通过 |
| 文档 CI 配置 | YAML 解析通过，现有文档作业包含 Python 设置和规格追踪步骤 |

上述收尾测试在本地 macOS 执行。原生打包验证和 GitHub 三平台 CI 结果不在本轮本地证据中。
