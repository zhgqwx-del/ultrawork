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
| 状态文档（exit 0，无 `ok` 字段）且 `identities.user.available: true` | 已连接 | 直接干活 |
| 状态文档且 `identities.user.available: false`（`status:"missing"`） | 已配置但未授权 | 引导用户去「设置 → 连接器 → 办公 CLI」点「授权」；或代跑 `auth login --no-wait --json` 并转发 verification_url |
| `error.subtype: "not_configured"`（错误 JSON 在 **stderr**，非零退出） | 未配置应用 | 引导用户去「设置 → 连接器 → 办公 CLI」点「配置应用」完成（推荐，UI 有完整引导）；或按 lark-shared 的说明后台代跑 `config init --new` 并把 URL 转给用户 |
| 命令不存在 | CLI 未安装 | 引导用户去「设置 → 连接器 → 办公 CLI」一键安装 |

**scope 不足 ≠ 未授权（重要）**：新配置的应用默认只授予基础 scope（用户身份/基础资料等），日历、审批、考勤等业务域**首次用到时才补授**。干活途中遇到某个 API 报缺 scope／权限不足：**不要**引导用户回设置页重新授权（那只会重复授予同样的基础 scope）——按 lark-shared 的说明**增量授权**：`lark-cli auth login --domain <所需域> --no-wait --json`，把 verification_url 转给用户完成即可。注意：某些域首次开通可能触发飞书的**开通申请审核**（页面提示"已提交申请，正在审核中"，进度经"开发者小助手"机器人推送）——这是平台正常流程，如实告知用户等审核通过后重试，不要反复重发授权请求。

## 第 1 步：按需加载官方文档（必做）

```bash
lark-cli skills list                 # 27 个内嵌技能（按业务域）
lark-cli skills read lark-shared     # 共享规则：认证/身份/权限/错误处理——首次使用必读
lark-cli skills read lark-calendar   # 再按任务域读对应技能（lark-im / lark-docs / lark-task / …）
```

命令结构、shortcut 优先级、schema 自省、`--as user/bot` 身份选择、错误处理——**权威说明都在 lark-shared 与各域技能里**，读它们，不要凭本文件或记忆推断 CLI 行为。

## 安全底线（无论是否读过 lark-shared 都必须遵守）

- **写操作先 `--dry-run` 预览**，确认无误再真跑。
- **`Risk: high-risk-write` 命令需要 `--yes`**——先向用户复述将发生什么、得到明确同意后才加。
- **收敛输出省 token**：API 调用加 `--jq <expr>`；机器读输出带静噪 env（见第 0 步）。
- URL 字段（`verification_uri` 等）是 opaque string，原样转发给用户，不要改写。

## 不归本技能管

- 飞书→app 的**入站**消息通道（channel/Gateway 规划，与本技能正交）
- 创建/管理飞书开放平台应用本身（连接器 UI 的 hosted 流程负责）
