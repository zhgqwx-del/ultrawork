---
name: dingtalk-assistant
description: Use when the user wants to operate DingTalk (钉钉) — AI tables, docs, calendar, approvals (OA), attendance, mail, todo, chat/bots, drive, wiki, minutes, reports — via the official dws CLI. This skill routes to dws's official mono skill materialized by the connector (and dws schema self-introspection) instead of duplicating docs. Requires the DingTalk connector (设置 → 连接器 → 办公 CLI) installed and authorized, and the org admin to have enabled CLI access. Not for inbound DingTalk message channels.
x-requires: [dws]
---

# 钉钉助手 (dingtalk-assistant)

通过官方 `dws` CLI 操作钉钉：AI 表格、文档、日历、OA 审批、考勤、邮件、待办、群聊与机器人、云盘、知识库、AI 听记、日志等 22 个产品（331+ 命令）。

**本技能是薄路由**：权威用法文档是 dws 官方 mono 技能（随连接器安装 materialize 到本地、与已装 CLI 版本同步）。不要凭记忆拼命令——按下面流程加载官方文档再动手。

## 第 0 步：健康检查（每次任务开始时）

```bash
dws auth status
```

（`-f` 默认即 json；成功/未登录都是 **exit 0 + stdout** 的 success 信封。）

| 结果 | 含义 | 处理 |
|------|------|------|
| `"authenticated": true` | 已连接 | 直接干活（`corp_name`/`user_name` 即当前身份） |
| `"authenticated": false` | 已安装但未授权 | 引导用户去「设置 → 连接器 → 办公 CLI」点「授权」。**绝不要在 bash 里代跑 `dws auth login`**：它是单个阻塞轮询进程（等用户扫码、最长 15 分钟、无恢复机制），会被 bash 工具超时杀在半途、把授权废在中间态——授权只能走连接器卡（它托管该进程的完整生命周期） |
| 命令不存在 | CLI 未安装 | 引导用户去「设置 → 连接器 → 办公 CLI」一键安装 |
| `{"success":false,code,message}` | CLI 报错 | 把 message 原样报告给用户 |

**白名单未开通（钉钉特有）**：登录/调用报 `CLI data access is not enabled for this organization`（错误 JSON 在 **stderr**，`category:"auth"`）——这是**企业管理员未开通「CLI 访问管理」**，不是用户操作错误。处理：告知用户请企业主管理员（报错文本里有管理员姓名）打开 `https://open-dev.dingtalk.com/fe/old#/developerSettings`（**旧版**开发者设置页）开启「允许成员通过 CLI 访问个人数据」，开通后重新授权即可；不要反复重试登录。

**scope 不足 ≠ 未授权**：默认登录已可读常用数据；个别命令报缺 scope 时把报错提示（含 `dws auth login --scope <所需 scope>`）如实告知用户、引导其在**终端**执行或回连接器卡重新授权——同上，不要在 bash 里代跑阻塞的 login。另：`dws api`（raw OpenAPI 直调）**仅自有应用凭证可用**，默认登录的加密 token 不支持——用产品命令替代。

## 第 1 步：按需加载官方文档（必做）

官方 mono 技能已由连接器 materialize 在**用户主目录**的 `.ultrawork/office-cli/skills/dws/` 下：

```
<home>/.ultrawork/office-cli/skills/dws/SKILL.md        # 主路由（意图决策树/行动指南/多组织铁律）
<home>/.ultrawork/office-cli/skills/dws/references/     # 22 个产品参考 + 错误码 + 恢复指南 + URL 分流
<home>/.ultrawork/office-cli/skills/dws/scripts/        # 13 个批量/轮询封装脚本（python）
```

`<home>`：macOS/Linux 即 `~`（如 `~/.ultrawork/...`）；**Windows 是 `%USERPROFILE%`**（read 工具不展开 `~`，请先 `echo $HOME`（或 Windows `echo %USERPROFILE%`）取绝对路径再读）。

先读主 SKILL.md，再按其「产品总览 / 行动指南」路由到对应 `references/products/<产品>.md`。命令结构、参数格式、错误处理、`--profile` 多组织——**权威说明都在官方文档里**，读它们，不要凭本文件或记忆推断 CLI 行为。

- 目录不存在（如用户手装了 dws 而非经连接器安装）：让用户在「设置 → 连接器 → 办公 CLI」重新点一次「安装」即可 materialize；临时兜底可用 `dws schema --jq '.products[].id'` + `dws <cmd> --help` 自省。
- `dws schema` 结果异常少（只有 2-3 个条目）时：先 `dws cache refresh` 预热服务发现（登录后首次需要，约数秒），再查。

## 安全底线（无论是否读过官方文档都必须遵守）

- **写操作先 `--dry-run` 预览**，确认无误再真跑。
- **危险操作需 `--yes`**——先向用户复述将发生什么、得到明确同意后才加（`-y` 是 AI Agent 跳确认模式，绝不默认带）。
- **收敛输出省 token**：加 `--jq <expr>` 精确提取；批量场景优先用官方 `scripts/` 里的封装脚本（自带翻页/轮询/`--dry-run`）。
- 官方 SKILL.md 的「严格禁止」全部适用：不 curl 直调 API、不编造 ID/URL/字段名、单次批量 ≤30 条。
- URL 字段是 opaque string，原样转发给用户，不要改写。

## 不归本技能管

- 钉钉→app 的**入站**消息通道（channel/Gateway 规划，与本技能正交）
- 企业管理员侧的「CLI 访问管理」开通操作本身（只能引导，见第 0 步）
