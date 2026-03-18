# Discussion 001: 移动端与桌面端通信 — Relay Server 方案

- **日期**: 2026-03-18
- **状态**: 讨论中
- **参与者**: 用户 + Claude

---

## 背景与需求

1. 将来用户有一个 Ultrawork 的移动端（App 或小程序）和一个桌面端（当前工程）
2. 移动端可以通过扫码、同账号登录等方式与桌面端配对关联
3. 配对后，移动端可远程发送任务给桌面端执行（类似 DingTalk Channel 的远程任务模式）
4. 移动端和桌面端可能都在公网环境，不一定在同一局域网

---

## 方案评估

### 候选方案对比

| 方案 | 原理 | 优点 | 缺点 | 结论 |
|------|------|------|------|------|
| **A. Relay Server（中继）** | 两端都连云端 WebSocket，服务端路由消息 | 100% 可达；支持离线队列；架构简单 | 需要运维云服务；消息经过第三方 | **采纳** |
| B. P2P 穿透 (WebRTC) | STUN 协助打洞，TURN 兜底 | 端到端加密；成功打洞后延迟低 | NAT 穿透成功率 ~80-85%；无离线能力；调试复杂 | 不推荐 |
| C. 推送服务唤醒 | APNs/FCM/微信推送唤醒桌面端 | 轻量 | 不适合持续通信；可作为 A 的补充 | 补充手段 |

**结论**: 采用 Relay Server 方案，P2P 不可靠且无离线能力，推送服务可后续作为补充。

---

## Relay Server 架构设计

### 整体架构

```
┌─────────────┐                              ┌─────────────────────┐
│  移动端/小程序  │◄──── WebSocket ────►        │                     │
│             │                              │    Relay Server     │
│             │         ┌───────────────────►│    (云端)            │
└─────────────┘         │                     │                     │
                        │                     │  ┌───────────────┐  │
                        │                     │  │ Connection Mgr │  │
                        │                     │  │ Message Router │  │
                        │                     │  │ Offline Queue  │  │
                        │                     │  │ Auth & Pairing │  │
                        │                     │  └───────────────┘  │
                        │                     └──────────┬──────────┘
                        │                                │
                        │                     WebSocket  │
                        │                                ▼
                        │                     ┌─────────────────────┐
                        │                     │   桌面端 (Tauri)      │
                        │                     │  ┌───────────────┐  │
                        │                     │  │ Relay Channel  │◄─── 新增 channel type
                        │                     │  └──────┬────────┘  │
                        │                     │         ▼           │
                        │                     │  ┌───────────────┐  │
                        │                     │  │   Gateway      │  │ ── 已有
                        │                     │  └──────┬────────┘  │
                        │                     │         ▼           │
                        │                     │  ┌───────────────┐  │
                        │                     │  │   OpenCode     │  │ ── 已有
                        │                     │  └───────────────┘  │
                        │                     └─────────────────────┘
```

### 核心模块

```
Relay Server
├── Auth Module          # 设备注册、token 签发/校验
├── Pairing Module       # 设备配对（扫码/配对码/账号）
├── Connection Manager   # 管理所有 WebSocket 长连接
├── Message Router       # 按 device binding 路由消息
├── Offline Queue        # 目标不在线时暂存消息
├── Presence Service     # 设备在线状态广播
└── Rate Limiter         # 防滥用
```

---

## 数据模型

```typescript
// 设备
interface Device {
  id: string              // UUID
  type: 'desktop' | 'mobile'
  name: string            // "张三的 MacBook" / "张三的 iPhone"
  publicKey?: string      // 端到端加密用（可选）
  createdAt: number
  lastSeenAt: number
}

// 设备绑定（配对关系）
interface DeviceBinding {
  id: string
  desktopDeviceId: string
  mobileDeviceId: string
  status: 'active' | 'revoked'
  createdAt: number
}

// 离线消息
interface QueuedMessage {
  id: string
  bindingId: string
  from: string            // deviceId
  to: string              // deviceId
  message: RelayMessage
  expiresAt: number       // TTL
  deliveredAt?: number
}
```

---

## 通信协议

### 消息信封

```typescript
interface RelayEnvelope {
  id: string              // 消息唯一 ID（幂等用）
  from: string            // deviceId
  to: string              // deviceId
  type: MessageType
  payload: unknown
  timestamp: number
  replyTo?: string        // 关联的上游消息 ID
}
```

### 消息类型

```typescript
type MessageType =
  // 任务相关
  | 'task.send'           // 移动端 → 桌面端：发送任务
  | 'task.received'       // 桌面端 → 移动端：确认收到
  | 'task.progress'       // 桌面端 → 移动端：执行进度
  | 'task.result'         // 桌面端 → 移动端：执行结果
  | 'task.error'          // 桌面端 → 移动端：执行失败
  | 'task.cancel'         // 移动端 → 桌面端：取消任务
  // 设备状态
  | 'device.online'       // Relay → 对端：设备上线
  | 'device.offline'      // Relay → 对端：设备下线
  | 'device.heartbeat'    // 双向心跳
  // 系统
  | 'system.ack'          // 通用确认
  | 'system.error'        // 通用错误
```

### 典型消息流：移动端发任务

```
移动端                    Relay                     桌面端
  │                         │                          │
  │  task.send              │                          │
  │  {text:"帮我重构App"}  ──►│                          │
  │                         │  task.send               │
  │                         │──────────────────────────►│
  │                         │          task.received   │
  │          task.received  │◄─────────────────────────│
  │◄─────────────────────── │                          │
  │                         │          task.progress   │
  │          task.progress  │◄─────────────────────────│
  │◄─────────────────────── │  {status:"thinking"}     │
  │                         │          task.progress   │
  │          task.progress  │◄─────────────────────────│
  │◄─────────────────────── │  {status:"editing",      │
  │                         │   files:["a.ts","b.ts"]} │
  │                         │          task.result     │
  │          task.result    │◄─────────────────────────│
  │◄─────────────────────── │  {summary:"已完成...",    │
  │                         │   diff: "..."}           │
```

### 任务 Payload

```typescript
// 移动端发送任务
interface TaskSendPayload {
  text: string
  context?: {
    sessionId?: string
    model?: { providerID: string; modelID: string }
    attachments?: Attachment[]
  }
  priority?: 'normal' | 'urgent'
}

// 桌面端进度更新
interface TaskProgressPayload {
  taskId: string
  status: 'queued' | 'thinking' | 'tool_calling' | 'editing' | 'reviewing'
  detail?: string
  toolName?: string
  files?: string[]
  tokensUsed?: number
}

// 桌面端返回结果
interface TaskResultPayload {
  taskId: string
  summary: string
  sessionId: string
  diff?: string
  filesChanged?: string[]
  tokensUsed: number
  duration: number          // ms
}
```

---

## 设备配对

### 扫码配对流程（MVP 推荐）

```
桌面端                         Relay                      移动端
  │                              │                           │
  │ 1. POST /pair/initiate       │                           │
  │    {deviceId, deviceName}    │                           │
  │─────────────────────────────►│                           │
  │                              │  生成 pairToken           │
  │  {pairToken, expiresIn:300}  │  (5 分钟有效)             │
  │◄─────────────────────────────│                           │
  │                              │                           │
  │ 2. 生成 QR 码                │                           │
  │    ultrawork://pair          │                           │
  │    ?token=xxx&relay=wss://.. │                           │
  │                              │                           │
  │                              │   3. 扫码，解析 URL        │
  │                              │                           │
  │                              │   4. POST /pair/confirm   │
  │                              │◄──────────────────────────│
  │                              │   {pairToken, deviceId,   │
  │                              │    deviceName}            │
  │                              │                           │
  │                              │  校验 → 创建 Binding      │
  │                              │                           │
  │  5. WS 推送 pair.completed   │  5. HTTP 200              │
  │◄─────────────────────────────│─────────────────────────►│
```

### QR 码格式

```
ultrawork://pair?token=abc123&relay=wss://relay.ultrawork.app&v=1
```

### 其他配对方式（后续）

| 方式 | 流程 | 场景 |
|------|------|------|
| 扫码配对 | 桌面端显示 QR → 移动端扫码 | MVP 首选 |
| 配对码 | 桌面端显示 6 位数字 → 移动端输入 | 无摄像头 fallback |
| 同账号登录 | 两端用同一账号自动关联 | 需账号体系，长期方案 |

### 多设备支持

一个桌面端可绑定多个移动端，每个 binding 独立管理，任一端可单方面解绑。

---

## 安全设计

### 分层安全

```
┌─────────────────────────────────────────┐
│  Transport: WSS (TLS 1.3)               │  传输加密
├─────────────────────────────────────────┤
│  Auth: JWT per device                    │  身份认证
│  - 短期 token (1h) + refresh token (30d) │
│  - 含 deviceId, bindingId               │
├─────────────────────────────────────────┤
│  E2E Encryption (Phase 2 可选)           │  端到端加密
│  - 配对时交换公钥                         │
│  - 消息体 NaCl box 加密                  │
└─────────────────────────────────────────┘
```

### WebSocket 认证

连接时 `Authorization: Bearer <accessToken>`，Relay 端校验 JWT 后注册到 ConnectionManager。

### 安全规则

| 规则 | 说明 |
|------|------|
| 配对 token 单次使用 | 确认后立即作废，防重放 |
| 消息只能发给已绑定设备 | Router 校验 binding 关系 |
| 敏感操作需二次确认 | "删除文件"类任务，桌面端弹确认 |
| 设备可随时解绑 | 任一端可单方面断开 binding |
| Rate limit | 每设备每分钟最多 60 条消息 |

---

## 离线消息与可靠性

### 离线队列

目标设备不在线时，消息入离线队列（默认 TTL 24h）。设备上线时批量投递。

### 送达保证

采用 **at-least-once** 语义 + 客户端幂等（用 `message.id` 去重）:
- 发送方发消息 → Relay 转发 → 接收方回 ACK
- 5s 未收到 ACK → 自动重发

### 心跳与重连

- 心跳间隔 30s
- 断线后指数退避重连: 1s → 2s → 4s → 8s → 16s → 30s（上限）

---

## Connection Manager 核心逻辑

```typescript
class ConnectionManager {
  private connections: Map<string, WebSocket>  // deviceId → ws

  register(deviceId: string, ws: WebSocket) {
    this.connections.set(deviceId, ws)
    this.notifyPeers(deviceId, 'online')
    this.flushOfflineQueue(deviceId)
  }

  unregister(deviceId: string) {
    this.connections.delete(deviceId)
    this.notifyPeers(deviceId, 'offline')
  }

  send(targetDeviceId: string, message: RelayMessage) {
    const ws = this.connections.get(targetDeviceId)
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message))
    } else {
      this.offlineQueue.enqueue(targetDeviceId, message)
    }
  }
}
```

---

## 与现有 Gateway 的集成

### 新增 Channel Type

```typescript
// channel-manager.ts
type ChannelType = 'dingtalk' | 'relay'   // 新增 relay

interface RelayChannelConfig {
  type: 'relay'
  relayUrl: string
  deviceId: string
  accessToken: string
  refreshToken: string
}
```

### Gateway 统一处理

Gateway 已经是消息抽象层。Relay Channel 作为新的 adapter 插入，与 DingTalk adapter 平级：

```
DingTalk Channel ──►┐
                    ├──► Gateway 统一 TaskRequest ──► OpenCode
Relay Channel   ──►┘
```

新增 `relay-adapter.ts`，实现 `ChannelAdapter` 接口，处理 WebSocket 连接和消息转换。

---

## 部署方案

### 方案总览

| 方案 | 启动速度 | 成本/月 | 运维量 | 备案 | 适合阶段 |
|------|---------|--------|--------|------|---------|
| **阿里云轻量（香港）+ Bun** | 1 天 | ~30 元 | 低 | 不需要 | **MVP 推荐** |
| 阿里云轻量（国内）+ Bun | 1-3 周（备案） | ~50 元 | 低 | 需要 | 小程序上线时 |
| 阿里云函数计算 FC | 2-3 天 | 按量（几乎免费） | 中 | 看绑定域名 | 有 Serverless 经验时 |
| Cloudflare Workers + DO | 1-2 天 | 免费 | 零 | 不需要 | 学习 CF 后 |
| Fly.io | 半天 | 免费额度 | 零 | 不需要 | 最快验证 |
| Supabase Realtime | 1 天 | 免费 500 连接 | 低 | 不需要 | Postgres 技术栈时 |
| MQTT (HiveMQ Cloud) | 1 天 | 免费 100 设备 | 低 | 不需要 | IoT 风格 |

### 推荐方案: 阿里云轻量应用服务器（香港）+ Bun

> 补充讨论 (2026-03-18)：考虑到用户已有阿里云经验、免备案需求、技术栈熟悉度，阿里云香港轻量服务器是 MVP 最务实的选择。

**为什么选阿里云香港**：
- 熟悉的平台，无额外学习成本
- 香港节点**免 ICP 备案**
- 国内访问延迟可接受（~50-100ms，消息转发场景够用）
- 资源消耗极低（维护几个 WebSocket 连接 + 转发消息），1C1G 都够

**成本**：

| 规格 | 价格 | 说明 |
|------|------|------|
| 轻量 2C2G（香港） | ~24-34 元/月 | MVP 绰绰有余 |
| 轻量 2C2G（国内） | ~50-60 元/月 | 需备案，小程序上线时考虑 |
| 域名 | ~60 元/年（.com） | 阿里云万网购买 |
| SSL 证书 | 免费 | Let's Encrypt + certbot 自动续期 |

### 阿里云相关产品能力评估

> 补充讨论 (2026-03-18)：评估阿里云是否有类似 CF Workers + DO 的产品。

| 阿里云产品 | 能力 | 适合度 | 说明 |
|-----------|------|--------|------|
| **ECS / 轻量应用服务器** | VPS，跑 Bun/Node/Go | **最直接** | 完全自主 |
| **函数计算 FC** | 类似 CF Workers | 中等 | 支持 WebSocket，配置比 CF 复杂 |
| **API 网关 + FC** | WebSocket API 托管 | 中等 | 有路由能力，灵活度不如自建 |
| **微消息队列 MQTT** | 设备间消息路由 | 备选 | 偏 IoT，topic 路由天然适合 |

**结论**：阿里云没有直接对标 CF Durable Objects 的产品（"有状态 Serverless 单例"）。最接近的组合是函数计算 FC + 表格存储/Redis，但不如 ECS + Bun 简单直接。

### 域名方案

```
方案 A（推荐 MVP）: 买域名 + 阿里云香港服务器
  → 买一个域名（万网，.com ~60元/年）
  → 不需要 ICP 备案（服务器在境外）
  → DNS 解析指向香港服务器 IP
  → Let's Encrypt 免费 SSL 证书
  → 例如：relay.ultrawork.app 或 relay.你的域名.com

方案 B（小程序上线时）: 买域名 + 阿里云国内服务器
  → 需要 ICP 备案（阿里云有备案服务，免费但耗时 1-3 周）
  → 备案后延迟更低，小程序域名白名单配置更顺畅

方案 C: 已有域名
  → 直接加一条 A 记录指向服务器 IP + 配 SSL
```

### 国内 vs 境外服务器对比

| | 国内（北京/上海/杭州） | 境外（香港/新加坡） |
|---|---|---|
| 延迟 | 最低（~10-30ms） | 稍高（~50-100ms） |
| **域名备案** | **必须 ICP 备案（1-3 周）** | **不需要** |
| 小程序域名白名单 | 备案后可配置 | 境外域名也可配（需 HTTPS） |
| Flutter App | 无限制 | 无限制 |
| 稳定性 | 最好 | 好 |

### 部署步骤（阿里云香港 + Bun）

```bash
# 1. 阿里云控制台购买轻量应用服务器（香港，Ubuntu 22.04）
# 2. 万网购买域名，DNS 添加 A 记录指向服务器 IP

# 3. SSH 登录服务器
ssh root@your-server-ip

# 4. 安装 Bun
curl -fsSL https://bun.sh/install | bash

# 5. 安装 Nginx + Certbot
apt update && apt install nginx certbot python3-certbot-nginx

# 6. 部署 Relay 代码
git clone your-repo && cd relay-server
bun install

# 7. 配置 Nginx 反向代理（见下方配置）
# 8. 获取 SSL 证书
certbot --nginx -d relay.your-domain.com

# 9. 启动 Relay Server（systemd 保活）
# 10. 完成
```

**Nginx 配置（WebSocket + REST API）**：

```nginx
server {
    listen 443 ssl;
    server_name relay.your-domain.com;

    ssl_certificate /etc/letsencrypt/live/relay.your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/relay.your-domain.com/privkey.pem;

    # WebSocket 连接
    location /ws {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400;          # WebSocket 长连接不超时
    }

    # REST API（配对、认证等）
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

**systemd 服务文件**：

```ini
# /etc/systemd/system/relay.service
[Unit]
Description=Ultrawork Relay Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/relay-server
ExecStart=/root/.bun/bin/bun run relay-server.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable relay && systemctl start relay
```

### 长期方案: Cloudflare Workers + Durable Objects

如果后续需要零运维 + 全球节点，可迁移到 CF：

```
Cloudflare Edge (全球 300+ 节点)
┌─────────────────────────────┐
│  Worker (无状态路由层)         │
│  - JWT 校验                   │
│  - 路由到对应 Durable Object   │
├─────────────────────────────┤
│  Durable Object (有状态)      │
│  - 每个 DeviceBinding 一个 DO  │
│  - 管理两端 WebSocket          │
│  - 内存中转发消息              │
│  - 离线消息存 DO storage       │
└─────────────────────────────┘
```

**DO 优势**: 天然按 binding 隔离、WebSocket 原生支持、自动休眠/唤醒（不用不收费）、全球就近接入。

**成本（个人/小团队）**：

| 项目 | 免费额度 | 超出价格 |
|------|---------|---------|
| Worker 请求 | 10M/月 | $0.30/M |
| DO 请求 | 1M/月 | $0.15/M |
| DO 存储 | 1GB | $0.20/GB |

日常使用（1 用户 1 对设备 每天 50 条任务）**完全免费**。

### 迁移路径

```
Phase 1 (MVP):    阿里云香港轻量 + Bun → 快速上线
Phase 2 (可选):   迁移到 CF Workers + DO → 零运维 + 全球加速
                  或继续阿里云 → 如果稳定就不折腾
```

Relay Server 的代码逻辑（消息路由、配对、离线队列）与部署平台无关，迁移时只需适配运行时 API（Bun.serve → CF Worker fetch），核心业务代码可复用。

---

## 移动端技术选型

### 方案对比

| 方案 | 优势 | 劣势 | 推荐度 |
|------|------|------|--------|
| **Flutter App** | 跨平台，后台保活好，推送完整，WebSocket 无限制 | 需安装 | **MVP 首选 + 长期主力** |
| **微信小程序** | 无需安装，扫码即用，国内触达广 | WebSocket 有限制，后台存活短，审核风险 | 第二步做，面向推广/轻度用户 |
| React Native | 与现有 React 栈一致 | 性能和原生能力略弱 | 备选 |
| PWA / H5 | 零安装跨平台，零审核 | 推送和后台能力受限，不能扫码 | 快速验证用 |

### 选型结论（2026-03-18 补充讨论）

> **核心判断**：小程序的限制（后台断开、推送需企业认证、审核"远程控制"可能被卡）恰好命中了 Ultrawork 的核心需求。而小程序的核心优势（大规模分发触达）在自用/小团队场景下不重要。

**长期两者都要，但定位不同**：

```
Flutter App   → 自己/核心用户：完整体验，后台保活，实时推送
微信小程序     → 推广/轻度用户：扫码即用，无需安装，降低使用门槛
```

| 场景 | 适合载体 |
|------|---------|
| 自己日常使用、重度操作 | App |
| 给朋友/同事演示"你看我手机就能操控电脑" | 小程序（扫码就开） |
| 团队内推广使用 | 小程序（分享卡片进入） |
| 后台实时接收任务结果 | App |
| 偶尔发个任务看看结果 | 都行 |

### Flutter App 优势详述

```
省掉的复杂度（相比小程序）:
  ✗ 微信域名白名单
  ✗ ICP 备案
  ✗ 微信审核（"远程控制"不会被卡）
  ✗ 后台断开的补偿逻辑
  ✗ 订阅消息的授权弹窗
  ✗ 学习 WXML/WXSS 微信专属语法

可以直接做:
  ✓ 后台 WebSocket 保活
  ✓ 任务完成本地/远程推送
  ✓ 实时进度流（不怕被系统杀）
  ✓ 富媒体（拍照发给桌面端分析）
```

### Flutter App 分发方式（自用/小团队）

```
Android:
  → 直接构建 APK → 传到手机安装 → 零成本零审核
  → 或用 GitHub Releases 分发

iOS:
  → TestFlight（$99/年 Apple Developer）→ 最多 10000 人内测
  → 或 Ad Hoc 签名（最多 100 台设备）
  → 或 AltStore / 自签（个人用够了）
```

### 先做 App 还是先做小程序？

**推荐先做 Flutter App**，理由：

1. **无审核障碍** — APK 装上就跑，iOS 用 TestFlight
2. **验证全链路** — 过程中 Relay Server 和 Gateway adapter 也就做好了
3. **代码质量更高** — 无需为小程序限制写 workaround，后续可直接迭代
4. **避免浪费** — 小程序专属代码（WXML/WXSS）Flutter 端一行都复用不了

反过来如果先做小程序：
- 后台断开 → 被迫在 Relay 做更多离线逻辑（App 端不需要这么复杂）
- 审核卡住 → 整个链路验证被阻塞
- 小程序专属代码 → 全部丢弃

### 对现有桌面端代码的冲击

**两种移动端对桌面端的改动完全一样，且都很小**：

```
移动端（无论 App 还是小程序）
    ↓
  Relay Server（新增，独立部署）
    ↓
  Gateway（新增一个 relay-adapter.ts，与 dingtalk-adapter 平级）
    ↓
  OpenCode（零改动）
```

唯一改动：Gateway 新增一个 channel adapter。

### 两客户端代码复用情况

```
                        Flutter    小程序    共用
Relay Server              —         —       ✓ 100% 共用
Gateway adapter           —         —       ✓ 100% 共用
通信协议/类型定义          —         —       ✓ 可共用
UI 层                    Dart      WXML     ✗ 不能复用
业务逻辑层               Dart       JS      ✗ 语言不同，但逻辑相同
```

两个客户端共用同一个 Relay + Gateway adapter，只是 UI 层各写各的。总工作量约 1.5x 而非 2x。

---

## 分阶段实施路线（修正版 v2）

> 2026-03-18 修正：Flutter App 先行，小程序跟进。

### Phase 1 — Flutter App MVP（验证全链路）

- **Relay Server**: Bun 原型部署 Fly.io（或 CF Workers + DO）
- **桌面端**: 设置页显示配对 QR 码 + Relay Channel adapter + 连接状态指示
- **Flutter App**: 扫码配对 + 发送文本任务 + 查看结果 + 推送通知

```
最快 MVP 路径:
  Week 1: Flutter 项目初始化 + 扫码配对 + WebSocket 连接 Relay + 发任务查结果
  Week 2: 推送通知 + 后台保活 + 任务进度实时显示 + 历史任务列表
  Relay:  Bun 原型（50 行）→ 部署 Fly.io → 后续可迁 CF
```

### Phase 2 — 微信小程序（扩大触达）

- 复用已就绪的 Relay Server + Gateway adapter
- 只需写小程序 UI 层
- 此时对协议和坑点已熟悉，避免踩坑
- 后台断开等限制也知道怎么优雅处理

### Phase 3 — 可靠性 + 体验

- 离线消息队列
- 消息 ACK + 重试
- 任务执行进度实时推送
- 多设备绑定管理

### Phase 4 — 高级功能

- 端到端加密
- 富媒体任务（图片/文件/语音）
- 任务历史记录（移动端查看）
- 桌面端远程状态面板（CPU/内存/当前 session）
- 账号体系（替代扫码，支持多桌面端）

---

## Cloudflare Workers + Durable Objects 实现细节

> 补充讨论 (2026-03-18)：用户对 CF Workers + DO 不熟悉，以下展开具体实现方式和学习成本。

### 基本概念

```
传统服务器思维:
  一台 VPS → 跑一个 Node/Go 进程 → 处理所有请求 → 自己管状态

Cloudflare Workers 思维:
  你写一个函数 → CF 自动部署到全球 300+ 节点 → 请求就近处理 → 无状态

Durable Objects (DO) 补充:
  Worker 是无状态的，但 DO 是有状态的"小房间"
  每个 DO 实例 = 一个独立的微型服务器，有自己的内存和存储
  可以理解为：一个按需创建的、全球唯一的、有状态的小进程
```

### DO 的心智模型

把 DO 想象成一间间独立的聊天室：

```
DeviceBinding "张三的手机 ↔ 张三的Mac"
    → 对应一个 DO 实例
    → 这个 DO 持有两端的 WebSocket 连接
    → 手机发的消息，DO 直接转给 Mac
    → 不需要数据库查询、不需要 pub/sub

DeviceBinding "李四的手机 ↔ 李四的Mac"
    → 另一个完全独立的 DO 实例
    → 互不干扰
```

### 开发体验

工具链是 `wrangler`（CF 的 CLI），项目结构极简：

```bash
# 初始化项目
npm create cloudflare@latest relay-server

# 本地开发（有本地模拟器，不需要部署到云端就能调试）
npx wrangler dev

# 部署
npx wrangler deploy
```

```
relay-server/
├── wrangler.toml          # 配置文件（绑定 DO、KV 等）
├── src/
│   ├── index.ts           # Worker 入口（路由层）
│   └── relay-binding.ts   # Durable Object 类
└── package.json
```

### 配置文件 wrangler.toml

```toml
name = "ultrawork-relay"
main = "src/index.ts"
compatibility_date = "2024-01-01"

# 声明一个 Durable Object
[durable_objects]
bindings = [
  { name = "RELAY_BINDING", class_name = "RelayBinding" }
]

# DO 需要数据迁移声明
[[migrations]]
tag = "v1"
new_classes = ["RelayBinding"]
```

### Worker 入口代码 (src/index.ts)

```typescript
// 接收 HTTP 请求，路由到对应的 DO 实例
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // --- 配对 API（无状态，直接在 Worker 处理）---
    if (url.pathname === '/pair/initiate') {
      return handlePairInitiate(request, env)
    }
    if (url.pathname === '/pair/confirm') {
      return handlePairConfirm(request, env)
    }

    // --- WebSocket 连接 → 路由到对应的 DO ---
    if (url.pathname === '/ws') {
      // 从 JWT 中解析出 bindingId
      const token = request.headers.get('Authorization')?.replace('Bearer ', '')
      const claims = await verifyJWT(token, env.JWT_SECRET)
      if (!claims) return new Response('Unauthorized', { status: 401 })

      // 关键：用 bindingId 定位到唯一的 DO 实例
      // 同一个 bindingId 永远路由到同一个 DO
      const doId = env.RELAY_BINDING.idFromName(claims.bindingId)
      const doStub = env.RELAY_BINDING.get(doId)

      // 把请求转发给 DO 处理
      return doStub.fetch(request)
    }

    return new Response('Not Found', { status: 404 })
  }
}
```

### Durable Object 代码 (src/relay-binding.ts)

```typescript
export class RelayBinding implements DurableObject {
  // 内存状态 — DO 活跃期间一直保持
  private desktopWs: WebSocket | null = null
  private mobileWs: WebSocket | null = null
  private state: DurableObjectState

  constructor(state: DurableObjectState) {
    this.state = state
    // state.storage 是持久化 KV 存储（断电不丢）
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair()
      const [clientWs, serverWs] = Object.values(pair)

      const deviceType = new URL(request.url).searchParams.get('type')

      this.state.acceptWebSocket(serverWs, [deviceType!])

      if (deviceType === 'desktop') {
        this.desktopWs = serverWs
      } else {
        this.mobileWs = serverWs
      }

      this.notifyPeer(deviceType!, 'online')
      await this.flushOfflineQueue(deviceType!)

      return new Response(null, { status: 101, webSocket: clientWs })
    }

    return new Response('Expected WebSocket', { status: 400 })
  }

  // CF 自动调用：收到 WebSocket 消息时
  async webSocketMessage(ws: WebSocket, message: string) {
    const isFromDesktop = ws === this.desktopWs
    const target = isFromDesktop ? this.mobileWs : this.desktopWs

    if (target?.readyState === WebSocket.OPEN) {
      // 对端在线 → 直接转发（零延迟，内存操作）
      target.send(message)
    } else {
      // 对端离线 → 存到持久化存储
      const msg = JSON.parse(message)
      await this.state.storage.put(`queue:${msg.id}`, {
        message: msg,
        expiresAt: Date.now() + 86400_000  // 24h
      })
    }
  }

  // CF 自动调用：WebSocket 断开时
  async webSocketClose(ws: WebSocket) {
    if (ws === this.desktopWs) {
      this.desktopWs = null
      this.notifyPeer('desktop', 'offline')
    } else {
      this.mobileWs = null
      this.notifyPeer('mobile', 'offline')
    }
    // DO 没有连接后会自动休眠，不消耗资源
  }

  private async flushOfflineQueue(deviceType: string) {
    const target = deviceType === 'desktop' ? this.desktopWs : this.mobileWs
    if (!target) return

    const queued = await this.state.storage.list({ prefix: 'queue:' })
    for (const [key, entry] of queued) {
      if (entry.expiresAt < Date.now()) {
        await this.state.storage.delete(key)
        continue
      }
      target.send(JSON.stringify(entry.message))
      await this.state.storage.delete(key)
    }
  }

  private notifyPeer(who: string, status: string) {
    const peer = who === 'desktop' ? this.mobileWs : this.desktopWs
    if (peer?.readyState === WebSocket.OPEN) {
      peer.send(JSON.stringify({
        type: `device.${status}`,
        timestamp: Date.now()
      }))
    }
  }
}
```

### DO 核心概念速查

| 概念 | 一句话解释 |
|------|-----------|
| Worker | 无状态函数，全球就近执行，负责路由 |
| Durable Object | 有状态单例，全球唯一，负责业务逻辑 |
| `idFromName(bindingId)` | 同一个 bindingId 永远定位到同一个 DO 实例 |
| `state.storage` | DO 自带的持久化 KV，断电不丢，用来存离线消息 |
| `WebSocketPair` | CF 原生 WebSocket 支持，不需要额外库 |
| 自动休眠/唤醒 | 没有连接时 DO 休眠（不计费），有请求时自动唤醒 |

### 学习成本评估

如果熟悉 TypeScript + WebSocket，核心概念 **1-2 天可上手**：

```
已有技能                     需要新学的
─────────────               ──────────
TypeScript          ✓        wrangler CLI（简单）
WebSocket           ✓        DO 生命周期（1h 理解）
REST API            ✓        CF Worker 路由模式（类似 Express）
                             wrangler.toml 配置（看文档抄）
                             本地调试 `wrangler dev`（开箱即用）
```

### 替代方案：Bun 快速原型

如果不想先学 CF，可以用 Bun 原生 WebSocket 50 行跑通原型，后续再迁移：

```typescript
// relay-server.ts — Bun 原生 WebSocket 原型
const connections = new Map<string, WebSocket>()  // deviceId → ws
const bindings = new Map<string, string>()        // deviceA → deviceB

Bun.serve({
  port: 8787,
  fetch(req, server) {
    const url = new URL(req.url)
    if (url.pathname === '/ws') {
      const deviceId = url.searchParams.get('deviceId')
      server.upgrade(req, { data: { deviceId } })
      return
    }
    // ... 配对 API
  },
  websocket: {
    open(ws) {
      connections.set(ws.data.deviceId, ws)
    },
    message(ws, msg) {
      const peerId = bindings.get(ws.data.deviceId)
      connections.get(peerId)?.send(msg)
    },
    close(ws) {
      connections.delete(ws.data.deviceId)
    }
  }
})
```

部署到任意 VPS（Fly.io / Railway），后续再迁移到 CF 也不晚。

---

## 微信小程序技术限制与应对

> 补充讨论 (2026-03-18)：评估小程序作为 MVP 移动端的资质要求和技术限制。

### 注册资质要求

| 类型 | 费用 | 能力 | WebSocket | 要求 |
|------|------|------|-----------|------|
| **个人小程序** | 免费 | 有限 | 支持 | 身份证实名 |
| **企业小程序** | 300元/年认证费 | 完整 | 支持 | 营业执照 |

### 个人小程序的限制

| 限制项 | 影响程度 | 说明 |
|--------|---------|------|
| 不能使用微信支付 | 无影响 | 暂不需要支付 |
| 不能 `wx.getPhoneNumber` | 小影响 | 可用其他方式登录 |
| **不能发模板消息/订阅消息** | **影响大** | 任务完成后无法主动推送通知 |
| 不能使用客服消息 | 无影响 | — |
| 部分类目不可选 | 需确认 | "工具"类目是否可用待验证 |
| 不能关联公众号 | 小影响 | — |

**结论**：个人小程序 **MVP 阶段够用**，WebSocket 和扫码都支持。推送通知需要企业认证才能解锁。

### 服务器域名要求（重要）

微信小程序对网络请求有严格限制：

```
必须满足:
1. 域名已备案（ICP 备案）
2. 必须 HTTPS / WSS（不允许 HTTP / WS）
3. 不能使用 IP 地址
4. 不能使用 localhost（开发工具除外）
5. 域名需在小程序后台「服务器域名」中配置白名单
```

**各部署方案的域名/备案情况**：

| 部署方案 | 域名问题 | 备案问题 |
|----------|---------|---------|
| Cloudflare Workers | 自带 `*.workers.dev`，WSS 开箱即用 | 境外域名，**不需要 ICP 备案** |
| 自建 VPS（国内） | 需自己的域名 + SSL 证书 | **需要 ICP 备案**（1-3 周） |
| 自建 VPS（境外） | 域名 + SSL | 不需要备案，但国内访问可能慢/不稳 |
| Supabase | 自带域名 | 境外，不需要备案 |

> **注意**：`workers.dev` 在国内偶尔被墙。更稳妥的做法是绑定自有域名（可以用 CF 做 proxy，域名本身不需要备案，只要服务器在境外）。
>
> **开发阶段**：可在开发工具中勾选「不校验合法域名」来绕过，但上线时必须合规。

### WebSocket 具体限制

```javascript
// 微信小程序 WebSocket API
const socket = wx.connectSocket({
  url: 'wss://relay.ultrawork.app/ws',
  header: {
    'Authorization': 'Bearer xxx'
  }
})

socket.onOpen(() => { /* 连接成功 */ })
socket.onMessage((res) => { /* 收到消息 */ })
socket.onClose(() => { /* 连接关闭 */ })
```

| 限制 | 详情 | 应对 |
|------|------|------|
| 同时连接数 | 早期限制 1 个，现放宽到 5 个 | 够用，只需 1 个到 Relay |
| **后台断开** | 进入后台 ~5-30s 后系统可能杀连接 | 前台恢复时自动重连 |
| **无长时间后台保活** | 不像 App 可后台常驻 | 见下方应对策略 |
| 单条消息大小 | 无明确官方限制，建议 < 256KB | 大 diff 做分片或只发摘要 |

### 后台存活问题（最大挑战）

```
用户在小程序中 → WebSocket 正常
用户切到微信聊天 → 小程序进入后台 → ~5-30s 后 WebSocket 可能断开
用户锁屏 → 更快断开
```

**应对方案对比**：

| 方案 | 原理 | 推荐度 | 备注 |
|------|------|--------|------|
| **方案 1: 接受断开，重连拉取** | `onShow()` 时重连 WebSocket + 拉离线消息 | **MVP 推荐** | 体验类似打开微信看到未读消息 |
| 方案 2: 订阅消息通知 | 任务完成 → 微信推送通知卡片 → 点击打开小程序 | 需企业认证 | 体验最好 |
| 方案 3: 搭配服务号 | 通过关联的服务号发模板消息 | 需企业资质 | 跳转链路长 |
| 方案 4: 后台音频保活 | 播放无声音频保持后台存活 | **不推荐** | hack 手段，审核可能被拒 |

**MVP 建议用方案 1**，用户典型场景：

```
1. 手机发任务 → 看到"已发送"
2. 放下手机做别的事
3. 过一会儿打开小程序 → 看到结果（离线消息补投）
```

AI 任务本身需要执行时间，用户不会盯着手机等，这个体验可接受。

### 扫码能力

```javascript
// 小程序扫码 — 基础能力，个人小程序也能用，无需额外资质
wx.scanCode({
  onlyFromCamera: false,
  scanType: ['qrCode'],
  success(res) {
    // res.result = "ultrawork://pair?token=abc123&relay=wss://..."
    const params = parseUrl(res.result)
    // 调用配对 API
  }
})
```

### 小程序审核注意事项

| 风险点 | 说明 | 应对 |
|--------|------|------|
| 类目选择 | 选「工具 → 信息查询」或「IT科技 → 开发者服务」 | 避免选需要特殊资质的类目 |
| 远程控制 | 审核员可能认为"远程操作电脑"有安全风险 | 描述为"AI 助手任务管理"而非"远程控制" |
| 内容安全 | AI 生成内容需接入内容安全审核 | 接入微信 `msgSecCheck` API |
| 登录方式 | 建议用微信登录 | `wx.login()` 获取 openId，审核更易通过 |

---

## 替代移动端方案：H5 (PWA)

> 补充讨论 (2026-03-18)：如果小程序资质或审核成为阻碍，H5 可作为更快的 MVP。

| 对比项 | 微信小程序 | H5 (PWA) |
|--------|-----------|----------|
| 审核 | 需要微信审核 | **零审核** |
| 资质 | 至少个人实名 | 无要求 |
| WebSocket | 有限制（后台断开） | 无限制（但后台也会断） |
| 扫码 | `wx.scanCode` 原生支持 | 不能直接扫码（可用链接配对代替） |
| 分发 | 微信搜索/分享小程序 | 分享链接/微信内打开 |
| 推送 | 需企业认证 | 无原生推送 |
| 安装 | 无需安装 | 无需安装 |

**H5 配对方式替代**：桌面端生成配对链接（而非 QR 码），用户在微信中点开链接即完成配对。

**建议**：可以先做 H5 验证流程可行性，确认后再封装成小程序。

---

## MVP 技术路线（修正版 v2）

> 2026-03-18 经过三轮讨论后的最终推荐路线。

### 核心决策

```
移动端:  Flutter App 先行（自用验证），微信小程序后续跟进（推广触达）
Relay:   Bun 原型快速验证 → 后续可迁 CF Workers + DO
```

### Relay Server

```
方案 A（快速原型，推荐起步）:
  Bun 服务 → 部署到 Fly.io / Railway
  → 自带域名 + 自动 SSL
  → 最熟悉的技术栈，1-2 天跑通
  → 无域名备案/白名单问题

方案 B（推荐长期）:
  Cloudflare Workers + DO
  → 花 1-2 天学习，但后续零运维
  → 全球节点低延迟
  → 可能需要绑定自有域名（workers.dev 国内偶尔不稳）
```

### 移动端

```
Phase 1:  Flutter App（MVP，自用/小团队）
          → 扫码配对 + 发任务 + 查结果 + 推送 + 后台保活
          → Android APK 直接分发；iOS TestFlight 或自签
          → 同时验证 Relay 全链路

Phase 2:  微信小程序（推广/轻度用户）
          → 复用已就绪的 Relay + Gateway adapter
          → 只需写 UI 层
          → 接受后台断开，前台重连拉消息
          → 个人小程序起步，按需升级企业认证
```

---

## 开放问题

- [x] Relay Server 域名和部署 → 已讨论，MVP 用阿里云香港轻量 + Bun + 自有域名（免备案），长期可迁 CF
- [x] 微信小程序 WebSocket 后台存活 → 已讨论，用"重连拉取"方案
- [x] 移动端选型 → 已讨论，Flutter App 先行，小程序后续跟进
- [x] 先做 App 还是先做小程序 → 已讨论，先 App 后小程序
- [ ] 是否需要 Phase 1 就支持端到端加密
- [ ] 任务权限控制粒度（移动端能否执行破坏性操作）
- [ ] 离线消息的最大队列深度和 TTL 策略
- [ ] 小程序审核类目选择确认（Phase 2 时再处理）
- [ ] `workers.dev` 域名国内可用性验证
- [ ] iOS 分发方式确认（TestFlight vs Ad Hoc vs 自签）
- [ ] Flutter 状态管理选型（Riverpod / Bloc / Provider）
