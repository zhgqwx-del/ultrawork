# ADR-018: 微信 Channel — ilink 协议接入

**状态**: Accepted
**日期**: 2026-03-24
**关联**: Issue TBD

## 背景

Ultrawork 已有钉钉 Channel（ADR-013/014），用户希望增加微信接入能力——在桌面端扫二维码后，通过微信收发 AI 对话消息。

腾讯近期推出了 OpenClaw 生态，其中 `@tencent-weixin/openclaw-weixin` 插件（v1.0.3）暴露了一套 **ilink bot HTTP API**，社区项目 [weclaw](https://github.com/fastclaw-ai/weclaw)（461 stars）也基于同一协议实现了微信↔终端 Agent 桥接。这套协议已被两个独立项目验证可用。

## 决策

采用 **腾讯 ilink bot 协议**，在 Gateway 中新增 `WeChatAdapter`，复用现有 Channel 架构（Bridge、SessionStore、ConfigStore）。

### 协议概要

| 端点 (ilink/bot/) | 用途 |
|---|---|
| `get_bot_qrcode` | 获取登录二维码 URL |
| `get_qrcode_status` | 长轮询扫码状态（wait/scaned/confirmed/expired） |
| `getupdates` | 长轮询收消息（35s 超时，游标同步） |
| `sendmessage` | 发送文本/图片/视频/文件 |
| `getuploadurl` | CDN 预签名上传参数 |
| `getconfig` | 获取账号配置 |
| `sendtyping` | 发送/取消打字指示器 |

认证方式：`AuthorizationType: ilink_bot_token` + `Authorization: Bearer <bot_token>` + `X-WECHAT-UIN`（随机 base64 uint32）。

### 架构

```
微信手机端 ◄──► 腾讯 ilink 服务器
                        │
               long-poll │ getupdates / sendmessage
                        ▼
┌──────────────────────────────────────────────┐
│ Gateway :4097                                │
│  WeChatAdapter                               │
│  ├─ ilink-api.ts    (HTTP API 封装)          │
│  ├─ wechat-adapter.ts (ChannelAdapter 实现)  │
│  ├─ qr-login.ts     (二维码登录流程)          │
│  └─ aes-ecb.ts      (媒体加解密, Phase 3)    │
│           │                                  │
│           ▼ IncomingMessage                  │
│  Bridge（已有，不动）──► OpenCode :4096       │
└──────────────────────────────────────────────┘

Desktop App
  Settings → Channels → 添加微信 → QR Dialog
```

### 与钉钉的关键差异

| 维度 | 钉钉 | 微信 |
|------|------|------|
| 认证方式 | clientId + clientSecret（企业后台创建） | 扫码获取 bot_token（无需预配置） |
| 消息接收 | WebSocket Stream（SDK 推送） | HTTP 长轮询（自行实现） |
| 消息发送 | sessionWebhook / REST API | `sendmessage` 统一接口 |
| 媒体处理 | SDK 处理 | 需自行 AES-128-ECB 加解密 |
| 配置项 | name + clientId + clientSecret | 扫码自动获取，仅需 workspace 绑定 |

### 分阶段实施

| 阶段 | 内容 | 优先级 |
|------|------|--------|
| **Phase 1** | ilink API 封装 + WeChatAdapter + QR 登录 + 文本收发 + Settings UI QR Dialog | ✅ 已完成 |
| **Phase 2** | 侧边栏状态指示器 + 打字指示器 + 断开重连 + 连接状态轮询刷新 | ✅ 已完成 |
| **Phase 3** | 图片发送（AES-ECB + CDN 上传）+ 主动推送 API | 后续 |

### Gateway API 扩展

```
POST /channel/wechat/qrcode          → { qrcodeUrl, qrcodeToken }
GET  /channel/wechat/qrcode-status   → { status: "wait"|"scaned"|"confirmed"|"expired" }
```

扫码确认后 Gateway 自动创建 channel 配置并连接。

### 前端 QR Dialog 流程

1. 用户在 Settings → Channels 选择"微信"
2. 前端调 `POST /channel/wechat/qrcode` 获取二维码 URL
3. Dialog 内渲染二维码 + 状态文案 + 倒计时（3 分钟）
4. 前端轮询 `GET /channel/wechat/qrcode-status`
5. 状态变化：等待扫码 → 已扫码待确认 → 已确认（自动关闭 Dialog，channel 出现在列表中）
6. 过期自动刷新（最多 3 次）

### 配置存储

```jsonc
// ~/.ultrawork/channels.json
{
  "channels": [
    {
      "id": "wechat-xxx",
      "type": "wechat",
      "name": "我的微信",
      "botToken": "...",        // 扫码确认后获取
      "ilinkBotId": "...",      // 账号 ID
      "baseUrl": "...",         // ilink 服务地址
      "workspaceDir": "/path",
      "autoConnect": true
    }
  ]
}
```

## 考虑过的替代方案

### 方案 A：基于 weclaw 二进制（Go）

直接调用 weclaw CLI 作为子进程：
- ✅ 开箱即用，社区维护
- ❌ 引入 Go 二进制依赖，增加 ~20MB 包体积
- ❌ 无法深度定制（QR 展示在 UI 而非终端）
- ❌ weclaw 有自己的 Agent 路由逻辑，和 Ultrawork 的 Bridge 重叠

**结论**：不采用，但参考其协议实现。

### 方案 B：微信公众号/企业微信 API

使用微信官方开放平台 API：
- ✅ 官方文档化，稳定
- ❌ 需要企业资质/公众号认证
- ❌ 个人用户无法自行部署
- ❌ 消息模板限制多

**结论**：不适合桌面工具场景。

### 方案 C：Web 微信协议

使用 itchat/wechaty 等 Web 微信逆向协议：
- ❌ 微信已大规模封禁 Web 协议登录
- ❌ 极不稳定，账号风险高

**结论**：已过时，不考虑。

## 风险与缓解

| 风险 | 等级 | 缓解措施 |
|------|------|---------|
| ilink 协议非公开文档，腾讯可能变更 | 中 | API 封装集中在 `ilink-api.ts` 单文件，变更只改一处；与 openclaw-weixin v1.0.3 对齐 |
| bot_token 过期需重新扫码 | 低 | 前端展示过期状态 + 一键重新扫码；`errcode -14` 检测 |
| 账号封禁风险 | 低 | 使用官方半公开协议（腾讯自己发布了 npm 包），非逆向 |
| 长轮询资源消耗 | 低 | 单连接 35s 超时，和 DingTalk WebSocket 相比差异不大 |

## 后果

### 正面
- 微信作为国内最大 IM，覆盖面远超钉钉
- 扫码即用，无需企业后台配置，用户门槛极低
- 复用现有 Channel 架构，开发量可控
- 为后续更多 Channel（Slack、Telegram 等）验证了 Adapter 模式的扩展性

### 负面
- 依赖非公开协议，长期稳定性不如钉钉 Stream SDK
- 媒体处理（AES-ECB + CDN）比钉钉复杂
- 需要维护长轮询连接（钉钉由 SDK 管理 WebSocket）
