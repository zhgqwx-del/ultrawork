---
name: feishu-assistant
description: Use when the user wants to operate Feishu/Lark (飞书) — send/read messages, docs, calendar, tasks, mail, drive, wiki, approval, meetings, minutes, OKR, sheets, base — via the official lark-cli. This skill routes to lark-cli's embedded per-domain docs (`lark-cli skills read <name>`) instead of duplicating them. Requires the lark-cli connector (设置 → 连接器 → 办公 CLI) installed and authorized. Not for inbound Feishu message channels.
x-requires: [lark-cli]
---

# 飞书助手 (feishu-assistant)

通过官方 `lark-cli` 操作飞书/Lark：消息、文档、日历、任务、邮件、云盘、知识库、审批、会议、妙记、OKR、表格、多维表格等 18 个业务域（200+ 命令）。

**本技能是薄路由**：权威用法文档内嵌在 lark-cli 二进制里、与已装 CLI 版本永远同步。不要凭记忆拼命令——按下面流程加载官方文档再动手。

## 第 0 步：健康检查（每次任务开始时）

```bash
LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1 LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1 lark-cli auth status --json
```

| 结果 | 含义 | 处理 |
|------|------|------|
| `ok: true` | 已连接 | 直接干活 |
| `error.subtype: "not_configured"`（exit 3） | 未配置应用 | 引导用户去「设置 → 连接器 → 办公 CLI」点「配置」完成（推荐，UI 有完整引导）；或按 `lark-cli skills read lark-shared` 的说明后台代跑 `config init --new` 并把 URL 转给用户 |
| `error.type: "auth"` | 未授权/登录过期 | 同上，设置页「授权」入口；或代跑 `auth login --no-wait --json` 并转发 verification URL |
| 命令不存在 | CLI 未安装 | 引导用户去「设置 → 连接器 → 办公 CLI」一键安装 |

## 第 1 步：按需加载官方文档（必做）

```bash
lark-cli skills list                 # 27 个内嵌技能（按业务域）
lark-cli skills read lark-shared     # 共享规则：认证/身份/权限/错误处理——首次使用必读
lark-cli skills read lark-calendar   # 再按任务域读对应技能（lark-im / lark-docs / lark-task / …）
```

命令三层结构（优先级从高到低）：
1. **`+shortcut`**：高层任务封装（如 `lark-cli calendar +agenda`）——有匹配的优先用
2. **typed command**：单个 API 方法（`lark-cli mail user_mailbox.messages list …`）
3. **`lark-cli api GET /open-apis/…`**：raw 逃生舱，仅当前两层没有时

调用前先 `lark-cli schema <service.resource.method>` 自省参数/类型/scope；`lark-cli <domain> --help` 浏览域内命令。

## 输出与安全约定

- **收敛输出省 token**：API 调用加 `--jq <expr>` 过滤 JSON；机器读输出统一带静噪 env（见第 0 步）。
- **写操作先预览**：任何写操作先 `--dry-run` 看请求，确认无误再真跑。
- **high-risk-write 必须用户确认**：`--help` 里标 `Risk: high-risk-write` 的命令需要 `--yes`——先向用户复述将发生什么、得到明确同意后才加 `--yes`。
- **身份**：`--as user`（默认，操作用户自己的数据）vs `--as bot`（应用身份）。查用户日程/文档用 user；细节见 lark-shared。
- URL 字段（`verification_uri` 等）是 opaque string，原样转发给用户，不要改写。

## 不归本技能管

- 飞书→app 的**入站**消息通道（channel/Gateway 规划，与本技能正交）
- 创建/管理飞书开放平台应用本身（连接器 UI 的 hosted 流程负责）
