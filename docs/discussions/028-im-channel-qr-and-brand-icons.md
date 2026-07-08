# 028 — 消息渠道扫码接入（钉钉/飞书/企微）+ 渠道品牌 icon

> 状态：**✅ 已落地（ADR-044，2026-07-08 三家真机验收全链通过；对抗审查 14 项修复）**（2026-07-07 拍板：范围=全量 A~B3；D1 QR 骨架改 gateway 后台轮询+缓存；D2 secret=0600+API masking〔Keychain 明确不做〕；D4 发送者限制本轮不做〔维持现状，allowlist 列后续增强〕；D3 分支=A+B0 先行合入、B1-B3 随后；D5/D6 按建议执行。三平台扫码机制与收发链路已源码级尽调 + 一轮对抗审查修订；每期动手前真机实拍清单见 §5）
> 日期：2026-07-07
> 输入：用户提供的竞品桌面 Agent 截图 4 张（「消息渠道」页：添加渠道下拉含 钉钉/微信/飞书/企业微信 四项带品牌 icon；微信/飞书/企微均为扫码即绑定，飞书文案「用飞书 App 扫码即可自动创建机器人应用」+「手动输入」兜底，企微另有「在浏览器中打开」）
> 关联：discussions/027 + ADR-043（办公 CLI 连接器——**与本文正交**：连接器=agent 出站工具能力，渠道=入站消息通道，凭证互不相通）· gotchas §4（Gateway/Channel）· §14（三家 CLI 契约实拍）· 本地记忆 `dingtalk-channel-plan.md` · ADR-037（跨平台）
> 范围：① 三平台「扫码自动建机器人」可行性调研（官方/社区/GitHub 源码级）；② 渠道品牌 icon 方案（含素材来源与授权）；③ 渠道扫码化分期实施方案。**不含**个人微信（已上线，ilink 官方协议）。

---

## 0. 一句话

**三家全部可以扫码绑定，且全部是官方机制**（同一范式：OAuth 设备流的「建应用」扩展——终端渲染二维码 → 手机 App 扫码确认 → 轮询拿 `client_id/client_secret` → 本地 WebSocket 长连接收发消息，无需公网）；品牌 icon **不用自己画**，官方资源 + 开源库素材组合齐活、授权低风险（Dify/LangBot 先例）。落地按「icon（纯前端）→ 钉钉渠道扫码化（复用现有 adapter）→ 企微渠道 → 飞书渠道」四步走，**每一步动手前先真机 curl 实拍上游契约**（三家端点均未进公开 API 文档，gotchas §14 铁律「以真机实拍为准」同样适用）。

---

## 1. 三平台扫码机制（2026-07 调研，源码级证据）

### 1.1 总表

| 平台 | 扫码机制（官方） | 凭证 | 收消息传输 | 手动兜底 |
|------|----------------|------|-----------|---------|
| **飞书** | `POST accounts.feishu.cn/oauth/v1/app/registration` 设备流（`archetype=PersonalAgent`），扫码确认页一次性完成「建应用+授权」 | `app_id` + `app_secret` | 事件长连接 WS（`@larksuiteoapi/node-sdk` `WSClient`，订阅 `im.message.receive_v1`） | 手填 app_id/app_secret |
| **钉钉** | `oapi.dingtalk.com/app/registration/init → begin → poll` 设备流（`source=DING_DWS_CLAW`），扫码页可「一键创建新机器人」**或绑定已有机器人** | `client_id` + `client_secret` | Stream 模式 WS（`dingtalk-stream` SDK，**本项目现有 adapter 就是这套**） | 后台建应用+开 Stream+复制两值（3-5 分钟） |
| **企业微信** | `GET work.weixin.qq.com/ai/qc/generate?source=wecom-cli&plat=N` → 扫码 → 3s 轮询 `ai/qc/query_result?scode=` → `bot_info{botid,secret}`（纯 HTTP GET，无需预置鉴权） | `bot_id` + `secret`（长连接专用） | 智能机器人长连接 WS：`wss://openws.work.weixin.qq.com`，订阅 `{"cmd":"aibot_subscribe"}`（**官方文档 101463 + 官方 SDK `@wecom/aibot-node-sdk`**） | 手填 BotID/Secret |

### 1.2 证据与来源（各家机制源头）

- **飞书**：官方 lark-cli（github.com/larksuite/cli，2026-03 开源，MIT）`internal/auth/app_registration.go`；官方 oapi-sdk-go `scene/registration` 模块（README 明写「扫码完成授权后即可自动注册应用……无需手动前往开发者后台创建」，且支持 **Addons 增量预填 scope/事件到扫码确认页**、`clientID` 参数走「更新已有应用」流程）；官方 openclaw 插件 larksuite/openclaw-lark。社区同款：openclaw feishu channel、hermes-agent、LangBot 等。
- **钉钉**：钉钉官方 org 仓库 DingTalk-Real-AI/dingtalk-openclaw-connector `src/device-auth.ts`（init/begin/poll 三步契约全在源码），官方帮助文档「一键创建 OpenClaw 机器人」。base URL 与 `source` 均可 env 覆盖（`DINGTALK_REGISTRATION_BASE_URL`/`_SOURCE`）。第三方（hermes）把 source 换自有品牌是在**取得钉钉官方认可后**——自有品牌 source 存在钉钉侧许可机制。
- **企业微信**：官方 npm 包 `@wecom/wecom-openclaw-cli`（JS 源码可读，`dist/utils/qrcode.js` 逐行实证契约）；智能机器人长连接官方文档 developer.work.weixin.qq.com/document/path/101463。**本项目 CLI 连接器 Phase 3 已真机验证过同款 QR init**（gotchas §14 wecom 段）。

### 1.3 收发消息链路尽调结论（开发可行性关键）

- **飞书**：扫码路径全程无「去后台开权限/发布版本」步骤（openclaw 官方插件源码实证：poll 拿凭证后直接起 WS）。权限=「平台默认模板 + Addons 增量」，**建议不赌默认模板，显式传 Addons 预填 `im:message:send_as_bot` + `im.message.receive_v1`（群聊或还需 `im:message.group_msg`）**。发消息 `POST /open-apis/im/v1/messages`。飞书/Lark 双域名分叉（accounts.feishu.cn / accounts.larksuite.com），config 需存 brand。
- **钉钉**：扫码授权成功 → 直接 Stream 收消息，无人工步骤（官方 connector 源码实证）。单聊+群聊都支持（`conversationType: '1'/'2'`），群聊需手动拉机器人进群 + @。**现有 `adapters/dingtalk/` Stream adapter 可原样复用，只差前置 bootstrap**。
- **企业微信**：长连接协议公开、可脱离 wecom-cli 自行实现（官方 Node SDK deps 仅 axios/eventemitter3/ws）。限制：**同 botId 仅一条活跃连接**（新连顶旧连）；单会话频控 30 条/分、1000 条/小时；**24h 回复窗口**（超时不能主动推）；富媒体发送仅单聊。「仅创建者可对话」限制**只针对绑定了 CLI 能力的机器人**——渠道必须新建专用 bot，**不得复用 wecom-cli 那只**（本机 aibkJFq_ 已绑 CLI；且共用 `~/.config/wecom/` 会踩 init 失败 `clear_bot_info` 连坐清凭证的坑，gotchas §14）。
- **重复扫码/去重**：三家均无服务端幂等——飞书可传 `clientID` 更新已有应用、钉钉扫码页可选绑已有 bot、**企微只能新建**。去重责任在客户端（已有凭证就不发起扫码）。

### 1.4 风险评估

| 风险 | 说明 | 缓解 |
|------|------|------|
| 契约漂移 | 三家注册端点都**不在公开 API 文档**里（仅官方 CLI/SDK 源码背书），无 SLA | 端点/参数收敛到单一可配置模块；升级时对照官方源码复核（同 vendor patch 管理思路） |
| source/品牌 | 钉钉 `DING_DWS_CLAW`、企微 `source=wecom-cli` 均为官方默认标识，直接复用技术可行但扫码页带对方品牌 | 先用默认值跑通；自有品牌 source 走各家生态合作申请（钉钉有 hermes 先例） |
| 扫码者权限 | 建应用需组织内权限；管理员开审批策略可能被拦 | 真机验收覆盖「非管理员扫码」；失败态给清晰引导 |
| 凭证一次性 | 设备流 poll SUCCESS 只返回一次 secret | Gateway 侧收到即持久化（见 §5.2 骨架设计），照抄官方 connector 的重试窗口 |
| 企微档位 | 智能机器人能力按企业规模分档（≤10 人小团队全量） | 文档写清；错误态提示 |

---

## 2. 本项目现状（差距）

- 消息渠道仅 2 种：钉钉（`packages/channel/gateway/src/adapters/dingtalk/`，Stream 模式，凭证**手动表单**）+ 微信（ilink 官方协议扫码，`gateway-server.ts:173/215` QR 端点 + 前端 `WeChatQRLogin` 轮询）。**无飞书、无企微渠道**。
- 渠道类型双 SSOT：gateway `src/types.ts:34-48` + api-client `src/types.ts:532-570`（镜像，须同步）。
- UI 全在 `Settings.tsx`（2850+ 行单文件）：添加下拉两项（:1317）、`ChannelCard`（:1397，仅状态圆点+文字徽章）、`ChannelAddForm`（:1480）、`WeChatQRLogin`（:1340）。
- **全线零品牌 icon**：图标统一 lucide-react；办公 CLI 三卡共用 `Building2`（:720）；`src/assets` 仅自家 logo。
- 微信 QR 现状是**无状态透传轮询**（gateway 每次 GET 现场调上游、`pendingQRSessions` 只存 name/workspaceDir）——对 ilink 成立（status 幂等可重读），**对设备流不成立**（见 §5.2）。

---

## 3. 品牌 icon 方案（工作包 A，纯前端）

### 3.1 素材来源结论：不用自己画

没有一个开源库同时覆盖四家全彩（lobe-icons 四家全无；simple-icons 仅微信单色），但组合拿现成素材完全够，且钉钉/企微品牌 mark 本身就是单色蓝，单色 glyph 上品牌色 ≈ 官方观感：

| 渠道 | 推荐素材 | License | 备注 |
|------|---------|---------|------|
| 微信 | simple-icons `wechat` path 填 `#07C160`；或 selfh.st/dashboard-icons 全彩版 | CC0 / CC BY 4.0 / Apache-2.0 | 官方另有 WeDesign 品牌下载页 + 开放平台设计资源（明示供第三方接入用） |
| 企业微信 | **官方 logo.zip**（developer.work.weixin.qq.com/document/path/90306，官方明示供第三方使用）；或 ant-design `wechat-work-filled` 填企微蓝 ≈`#0082EF` | 官方授权 / MIT | 四家中授权态度最明确 |
| 钉钉 | ant-design `dingtalk` path 填钉钉蓝 ≈`#007FFF` | MIT | 无官方 media kit；ISV 生态通行直接用 |
| 飞书 | dashboard-icons（homarr-labs）`lark.svg` **全彩**；或字节官方 IconPark `lark` glyph（Apache-2.0）单色方案 | Apache-2.0 | 飞书官方无品牌资源页；Dify/LangBot 内置的全彩版来自 iconfont 导出（license 模糊，只当参照不当依赖） |

法律面：集成/互操作指示场景使用品牌 logo 属指示性使用（nominative fair use，中国司法实践同样认可），Slack/Zapier/n8n/Dify/LangBot 全行业通行，**四家均无禁止条款**（企微、微信反而官方主动提供）。注意事项：原样不变形、小尺寸、不暗示官方背书；About/NOTICE 加一行「所涉商标归各自权利人所有」。

### 3.2 实现

1. 新建 `src/components/brand-icons.tsx`：4 个内联 SVG React 组件，**按品牌命名**（`WeChatIcon/DingTalkIcon/FeishuIcon/WeComIcon`）——CLI 连接器 id 是 `lark` 而渠道 type 若叫 `feishu`，两边各自映射到品牌组件，不让组件猜 id。统一观感可套「品牌色圆角方块底 + 白 glyph」（类 App 图标，与截图产品一致，也与 lucide 体系协调）。构建期内置零外链（Tauri 离线打包约束，排除 iconify 运行时加载）。
2. 落点（对抗审查修正：**6 处不止 4 处**）：① `ChannelCard` 徽章（Settings.tsx ~1430）；② 添加渠道下拉（~1317）；③ 空态按钮（~1389，现用 `Smartphone`）；④ `WeChatQRLogin` 头部；⑤ 办公 CLI 三卡替换 `Building2`（~720）——icon 是纯前端展示字段，**前端侧映射即可，不动 Rust `CLI_CONNECTORS` 注册表**；⑥ 清理 Settings.tsx:4 不再使用的 lucide import。
3. icon 由 `type` 派生，**不加持久化字段**（避免双 SSOT 同步负担）。

工作量：半天量级，独立可合，与工作包 B 完全解耦。

---

## 4. 渠道扫码化分期（工作包 B）

按「可验证性 + 复用度」排序，**每期独立分支**（B2/B3 存在实拍后调整方案的可能，不与 B1 捆绑）：

- **B0（前置重构，与 icon 同分支或紧随）**：Settings.tsx 拆出 `components/settings/channels-section.tsx`（拆分模式已有先例：models-section 等；纯搬移零逻辑改动，测试跟搬，注意 gotchas §13 两条测试坑）。
- **B1 钉钉渠道扫码化**（性价比最高）：现有 Stream adapter 原样复用，前置 registration 设备流 bootstrap；拿 `clientId/Secret` 落现有 `DingTalkChannelConfig`；保留手动表单兜底。
- **B2 企微渠道**：新 adapter 基于 `@wecom/aibot-node-sdk`（或按官方文档 101463 自行实现 WS 订阅，deps 极简）；QR 流按 §1.1 契约实现；专用 bot、凭证独立于 CLI 连接器。
- **B3 飞书渠道**：新 adapter 基于 `@larksuiteoapi/node-sdk` `WSClient`；QR 走 registration 设备流 + **Addons 显式预填 im scope/事件**；双域名分叉；手填 app_id/app_secret 兜底。**动手前先 spike：该 SDK 能否被 `bun run build:gateway` 单文件编译**（体积大、可能含可选原生依赖，对照 gotchas §7）。

每期固定动作：gateway `types.ts` 加 config 类型 + adapter 工厂注册（`channel-manager.ts`）→ api-client `types.ts:532` 镜像同步 → 前端下拉/流程组件/i18n → `bun run build:gateway` 重编译（gotchas §4 第一条）→ `docs/api-reference.md` 补新端点。

### 4.1 QR 会话骨架（对抗审查阻塞项，必须先重设计）

现有微信「无状态透传轮询」**不能照抄给设备流**：① 设备流 poll 返回的 `client_secret` 是一次性交付，透传时前端 unmount/网络抖动即永久丢失；② 前端 1s 轮询（`Settings.tsx:1690`）会超设备流最小间隔（5s，超频 `slow_down`）。重设计为：

- **Gateway 侧后台轮询 + 结果缓存**状态机：`PendingQR` 扩展为 `{ state, result?, error? }`，gateway 按上游 interval 自行轮询，**拿到凭证立即持久化**，前端只读 gateway 缓存态（读到 confirmed 即建渠道完成）。微信可保留透传或一并迁移。
- **QR provider 注册表**（`qr-registry.ts`，type → `{ start, poll, cancel }`），端点泛化为 `POST /channel/{type}/qrcode` + `GET .../qrcode-status` + **新增 `DELETE .../qrcode/:token` 显式取消**（至少停掉后台轮询；注意钉钉/飞书扫码中途放弃可能已在组织里建了应用，服务端无法回滚——UX 上设备流不做自动重扫，重扫=用户显式点击）。
- **统一状态枚举**（微信现值 `wait/scaned/confirmed/expired` 与设备流 `pending/authorized/expired/denied` 各自映射进统一集，含 `denied`）。
- **StrictMode 双挂载去重**：dev 下 mount effect fire 两次，设备流 begin 若不幂等会双倍建应用——gateway 对同 (type, name, workspaceDir) in-flight 去重 + 前端 ref 守卫。

### 4.2 安全与数据（需拍板）

- `channels.json` 现状：明文 + 默认 0644 + `GET /channel` 把 secret 全文回给前端。新增三家后 secret 面积翻倍。**最低决策集**：① `saveStore` 加 `{mode: 0o600}`；② API 返回 masked config（前端实际只用 name/type/workspaceDir）。Keychain 对 bun sidecar 成本高，可明确「不做，降级 0600+masking」写入 ADR。gateway 端点无鉴权（仅 CORS 白名单）属既有 known issue，本次至少显式声明范围。
- 无 `PATCH /channel/:id` 端点——「重新授权/换 secret」现状=删了重加；且**删渠道不清理 session-map.json 的 chatId 映射**（channel-manager.ts:64-72），重建后旧会话映射复活，顺手修。
- 消息路由现状（bridge.ts）：chatId→session 持久映射、用全局 model、**permission 自动 approve / question 自动 reject**——新渠道扩大外部可驱动面（钉钉群聊=任意群成员可发）。需决策：发送者 allowlist（参照 openclaw 的 dmPolicy/groupPolicy）至少给个开关。

### 4.3 UI/i18n 注意项（对抗审查收录）

- `bridge.ts:26 CHANNEL_LABELS` 硬编码 `{dingtalk:"钉钉", wechat:"微信"}`——新渠道必须补，否则会话标题显示英文 type。
- i18n 动态键 `channel.type.{type}` 漏加会渲染裸 key；QR 流程键微信现为 `channel.wechat.*` 前缀，泛化时参数化；新增设备流专属键（在浏览器中打开/等待授权/管理员未开启引导等）。「在浏览器中打开」直接复用 `@tauri-apps/plugin-opener`（`use-cli-connectors.ts:3` 先例），勿用 `<a target=_blank>`。
- `showAdd` 联合类型（Settings.tsx:1275）、空态按钮写死 wechat（:1389）跟着改；`workspacePath!` 非空断言坑（:1524/:1631 静默 return 导致永久 loading）统一为「无工作区禁用添加+提示」。
- **渠道 vs CLI 连接器用户困惑**：同一品牌出现在两个 section 且凭证互不相通（用户已连企微 CLI 还要再扫一次码）。最低成本：添加渠道表单顶部加说明文案（`channel.vsConnectorHint`）+ gotchas 记「两套凭证独立」契约。

### 4.4 测试与验收

- gateway vitest：新 adapter（SDK class mock，同 gotchas §4 DWClient 先例）、QR 注册表状态机（一次性 secret/超频/取消/TTL/StrictMode 去重）、新路由分支。
- desktop vitest：channels-section 拆分回归 + 各流程组件 + brand-icons snapshot。e2e：照 wecom `mkConn` mock 工厂先例做 QR 流 walkthrough。
- 真机验收（长尾，预留窗口）：三家真账号全链（扫码→建渠道→IM 发消息→agent 回复→重扫/取消/过期分支），钉钉覆盖非管理员扫码，企微覆盖 ≤10 人档。
- **CI 停摆期间**（Pending Issues）：合入前本机自跑 typecheck+vitest+cargo test+check-docs；Windows 的 WS/编译产物验证 deferred，恢复后 `gh run rerun`。

---

## 5. 开发前必须真机实拍清单（§14 铁律：源码推定 ≠ 实际契约）

1. **钉钉 registration 三步**：curl 全流程实拍 payload（poll 返回体、扫码者权限要求、「绑定已有机器人」页面行为、一键创建的 bot 是否直接 Stream 可收）→ 锚定进 gotchas §4。
2. **企微 `ai/qc/*` 契约**：generate/query_result 实拍；新建 bot 默认是否长连接模式、默认可见范围；`plat` 参数边界。
3. **飞书 registration + Addons**：默认模板实际 scope 清单；带 Addons 的确认页 UX；不带 Addons 时单聊/群聊是否开箱即收；同 app 长连接配额。
4. 三家对个人版/免费版/小微账号的差异。

## 6. 决策（2026-07-07 已拍板）

| # | 决策点 | 结论 |
|---|--------|------|
| D1 | QR 骨架改 gateway 后台轮询+缓存（§4.1） | ✅ 必改，微信一并迁移（顺带消掉 1s 超频） |
| D2 | secret 存储 | ✅ 0600 + API masking；Keychain 明确不做，写 ADR |
| D3 | 分支策略 | ✅ 范围=全量 A~B3：A+B0 一支先行合入，B1-B3 随后（B2/B3 动手前各自真机实拍，实拍不过则该期单独降级处理不拖累前序） |
| D4 | 发送者 allowlist | ✅ **本轮不做限制**（维持现状：所有可见成员可对话；allowlist/@ 门控列后续增强，文档记 known issue） |
| D5 | 渠道↔连接器 UI 说明 | ✅ 表单顶部 hint 文案 + gotchas 契约条目 |
| D6 | 钉钉/企微 source 标识 | ✅ 先用官方默认值；自有品牌 source 走生态合作，另行推进 |

---

## 附：调研来源索引

- 飞书：github.com/larksuite/cli · larksuite/oapi-sdk-go（`scene/registration`）· larksuite/openclaw-lark · docs.openclaw.ai/channels/feishu
- 钉钉：github.com/DingTalk-Real-AI/dingtalk-openclaw-connector（device-auth.ts/onboarding.ts/connection.ts）· open.dingtalk.com「一键创建 OpenClaw 机器人」· hermes-agent PR #11574/#12907（source 许可先例）
- 企微：developer.work.weixin.qq.com/document/path/101463（长连接）· npm `@wecom/wecom-openclaw-cli`（qrcode.js 契约）· npm `@wecom/aibot-node-sdk` · WecomTeam/wecom-openclaw-plugin · docs.langbot.app 企微智能机器人
- icon：wechat.design 品牌下载 · developer.work.weixin.qq.com/document/path/90306（企微官方 logo.zip）· simple-icons · ant-design icons · bytedance/IconPark · homarr-labs/dashboard-icons · Dify/LangBot 内置先例
- 个人微信合规现状（对照）：官方 ilink（本项目在用，合规）vs pad/hook 协议（2025 起持续打击，封号高危，不碰）
