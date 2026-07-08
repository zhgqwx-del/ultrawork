# ADR-044: 消息渠道扫码接入范式（钉钉/企微/飞书）+ 渠道品牌 icon

- 状态：Accepted（✅ 三家全链实现 + 真机验收 2026-07-08）
- 日期：2026-07-08
- 关联：discussions/028（调研与方案 SSOT）· ADR-043 / discussions/027（办公 CLI 连接器——**正交**：连接器=agent 出站工具，渠道=入站消息）· gotchas §4（三家实拍契约）· conventions §14（接入模式）

## 背景

「消息渠道」原只有钉钉（手动填 clientId/Secret）+ 微信（ilink 扫码）。竞品桌面 Agent 已做到四家 IM 全部「扫码即自动创建机器人」。调研证实三家均有**官方**设备流建应用机制（均只存在于官方 CLI/SDK 源码，未进公开 API 文档）：钉钉 `app/registration` 三步流、企微 `ai/qc` 扫码流 + 智能机器人长连接、飞书 accounts `app/registration`（archetype=PersonalAgent）。

## 决策

1. **QR 会话骨架**（`gateway/src/qr-registry.ts`）：gateway 后台轮询 + 结果缓存，前端只读快照。核心不变量=**设备流 secret 一次性交付 ⇒ 凭证到达即 addChannel 落盘**，不经前端透传；取消不回滚上游、飞行中取消仍落盘。统一状态枚举 `pending/scanned/authorized/expired/denied/error`；并发去重（in-flight promise，键含 autoConnect）；本地过期尊重会话自身 deadline；NaN 消毒；persist 成功但 autoConnect 失败仍算 authorized（防用户重扫造重复 bot）。端点 `POST/GET/DELETE /channel/:type/qrcode*`。微信 ilink 一并迁入同一骨架。
2. **三家 provider + 两个新 adapter**：钉钉复用现有 Stream adapter（只加 registration bootstrap）；企微新增 `@wecom/aibot-node-sdk` 长连接 adapter；飞书新增 `@larksuiteoapi/node-sdk` WSClient adapter（连接结果走 onReady/onError 构造回调——SDK start() 不等连接）。单聊/群聊 chatId 三家同构（群=`group:` 前缀）。手动兜底表单泛化（type 驱动字段表，飞书含 Lark 国际版 domain 选择）。
3. **凭证安全（D2）**：`channels.json` 0600；`GET/POST /channel` 响应掩码全部 secret 字段；Keychain 明确不做（bun sidecar 无现成 keyring 绑定，成本/收益不成立）。
4. **品牌 icon**：`brand-icons.tsx` 四家圆形徽章（素材=simple-icons CC0 / 腾讯 TDesign MIT / Remix Apache-2.0 / 字节 Semi MIT，构建期内联零外链；负形 glyph 结构化强制白底盘保 dark mode）；渠道卡/下拉/CLI 连接器三卡等六落点；About 加商标指示性使用声明。icon 由 type 派生，不入数据模型。
5. **发送者权限（D4）**：本轮刻意不做限制（所有可见成员可对话）；allowlist/@ 门控列后续增强——known issue：渠道消息驱动的 agent 会自动放行 permission（bridge 既有行为）。
6. **source 标识（D6）**：沿用各家官方默认值（`DING_DWS_CLAW`/`wecom-cli`）；自有品牌 source 需平台方认可（hermes 先例），留 env 覆盖。

## 后果

- 第四家渠道接入成本=QRProvider 三件套 + adapter + 固定动作清单（conventions §14）。
- 三家上游契约无 SLA，bump/漂移排障以 gotchas §4 实拍记录为准；provider 对字段漂移有防御（缺凭证降级 denied + key 名日志锚点）。
- 渠道凭证与办公 CLI 连接器三家凭证互不相通（gotchas §4 明示），UI 侧用户困惑靠文案缓解（D5）。
- 真机验收（2026-07-08）：三家扫码→建渠道→IM 发消息→agent 回复全链通过；飞书 PersonalAgent 默认模板单聊开箱即通（群聊未实拍）；企微渠道 bot 与 CLI bot 隔离验证。
