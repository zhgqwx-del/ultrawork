---
name: wecom-assistant
description: Use when the user wants to operate WeCom (企业微信) — docs, smart sheets, online sheets, smart pages, messages, contacts, todos, meetings, schedules — via the official wecom-cli. This skill routes to wecom-cli's official skills vendored under references/official/ (snapshot matching the pinned CLI version) plus CLI self-introspection. Requires the WeCom connector (设置 → 连接器 → 办公 CLI) installed and authorized (QR-scan bot binding). Not for inbound WeCom message channels.
x-requires: [wecom-cli]
---

# 企业微信助手 (wecom-assistant)

通过官方 `wecom-cli` 操作企业微信：文档/智能表格/在线表格/智能文档、消息、通讯录、待办、会议、日程（6 个品类，工具由企业服务端动态下发）。

**本技能是薄路由**：权威用法文档是 vendored 在本技能 `references/official/` 下的官方技能快照（与连接器 pin 的 CLI 版本严格对应）。不要凭记忆拼命令——按下面流程加载官方文档再动手。

## 第 0 步：健康检查（每次任务开始时）

```bash
wecom-cli auth show
```

| 结果 | 含义 | 处理 |
|------|------|------|
| JSON `{"id": …, "create_time": …}` | 已连接（id 即机器人 Bot ID） | 直接干活 |
| 纯文本 `unauthorized`（exit 0，**不是 JSON**） | 已安装但未绑定机器人 | 引导用户去「设置 → 连接器 → 办公 CLI」点「授权」（扫码自动创建/绑定机器人）。**绝不要在 bash 里代跑 `wecom-cli init`**：交互模式在非 TTY 直接报错；`--noninteractive` 是单个阻塞轮询进程（等用户扫码、最长 5 分钟），会被 bash 工具超时杀在半途——授权只能走连接器卡（它托管该进程的完整生命周期） |
| 命令不存在 | CLI 未安装 | 引导用户去「设置 → 连接器 → 办公 CLI」一键安装 |
| stderr `Error: 未找到 MCP 配置缓存…`（工具调用时） | 凭证/配置缺失 | 同「未绑定」处理，回连接器卡授权 |

**品类未开通 ≠ 故障（企微特有的规模分级）**：调用某品类报 `当前企业暂不支持授权机器人「××」使用权限`（stderr、exit 1）——这是**企业微信按企业规模下发能力**：>10 人企业只开放文档、待办；≤10 人的个人/小团队开放消息、文档、日程、会议、待办。如实告知用户其企业不支持该品类即可，不要重试、不要引导重新授权（授权解决不了服务端分级）。

## 第 1 步：按需加载官方文档（必做）

官方技能快照就在本技能目录下（skill 输出的 Base directory + 相对路径）：

```
references/official/wecomcli-doc/INDEX.md          # 文档/智能文档/表格总入口（docid/URL 定位）
references/official/wecomcli-smartsheet/INDEX.md   # 智能表格（子表/字段/记录增删改查）
references/official/wecomcli-sheet/INDEX.md        # 在线表格（区域读写/子表管理）
references/official/wecomcli-smartpage/INDEX.md    # 智能文档（Markdown 发布/导出）
references/official/wecomcli-msg/INDEX.md          # 消息（会话/记录/媒体下载/发送）
references/official/wecomcli-contact/INDEX.md      # 通讯录（可见范围成员查询）
references/official/wecomcli-todo/INDEX.md         # 待办（增删改查/状态流转）
references/official/wecomcli-meeting/INDEX.md      # 会议（预约/取消/成员管理）
references/official/wecomcli-schedule/INDEX.md     # 日程（增删改查/参与人/闲忙）
```

按任务读对应 `INDEX.md`，其内部 `references/*.md` 链接（相对该 INDEX.md 所在目录）按需继续读。文档 URL 形如 `doc.weixin.qq.com/{doc|sheet|smartsheet|smartpage}/…` 时按路径段选对应技能文档（各 INDEX.md 描述里有分流说明）。

命令的实时真相用 CLI 自省核对（工具表由企业服务端动态下发，需已授权+网络）：

```bash
wecom-cli <category>                    # 列出该品类当前可用工具（category: contact/doc/meeting/msg/schedule/todo）
wecom-cli <category> <method> --help    # 单个工具的参数定义
```

工具表有 24h 本地缓存；官方文档说的命令不在列表里时，先 `wecom-cli cache clear` 再查（服务端可能刚变更下发）。

## 调用契约（wecom-cli 与 lark-cli/dws 都不同，勿互推）

- 通用格式：`wecom-cli <category> <method> '<json_args>'`（参数是**单个 JSON 字符串**，无参传 `'{}'`）。
- **成功输出是双层信封**：stdout 打完整 JSON-RPC 响应，真正的业务 JSON 是 `result.content[0].text` 里的**字符串**——解析时要剥两层。
- 错误走 stderr 人类可读中文 `Error: …` + exit 1（无结构化错误 JSON）。
- 默认超时 30s；`msg get_msg_media`（媒体下载）120s，返回 `local_path` 为落盘路径。

## 安全底线

- **wecom-cli 没有 `--dry-run`/`--yes`**（与 lark/dws 不同）——所有写操作（发消息、建/改/删日程会议待办、写文档表格）执行前**必须先向用户复述将发生什么并得到明确同意**，这是唯一的预览机制。
- 发消息尤其谨慎：以用户绑定的机器人身份发出、对方真实可见，误发不可撤回。
- 批量写操作逐条确认或先小样本验证；ID/docid/URL 全部来自查询结果，不要编造。
- URL 字段是 opaque string，原样转发给用户，不要改写。

## 不归本技能管

- 企业微信→app 的**入站**消息通道（channel/Gateway 规划，与本技能正交）
- 机器人创建管理的网页端操作本身（连接器卡扫码流程负责）
