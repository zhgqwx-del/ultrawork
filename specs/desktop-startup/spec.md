# 桌面启动门禁

原生桌面启动时，renderer 先通过 `get_startup_status` 获取宿主的启动状态，再决定是否加载 sidecar 端口和凭证及进入主界面。品牌身份与数据租约遵循 [ADR-075](../../docs/decisions/075-independent-brand-releases.md)。

## 需求

### REQ-STARTUP-001

原生宿主报告就绪且品牌 ID 与应用标识均匹配时，renderer 才能以严格模式加载 sidecar 端口和凭证。两项均成功后才能进入正常启动流程。

### REQ-STARTUP-002

原生宿主报告阻断、状态响应不可用或品牌身份不匹配时，renderer 返回 `blocked`，跳过端口与凭证加载。严格加载失败也进入 `blocked`。主入口在该状态渲染启动诊断页，主界面的业务 providers 保持未挂载。

## 验收场景

### AC-STARTUP-001

关联 [REQ-STARTUP-001](#req-startup-001)。

- **Given** 原生宿主报告 `ready`，身份与 renderer 一致，且两项加载均成功
- **When** renderer 执行启动门禁
- **Then** 端口与凭证的加载均以严格模式调用，门禁返回 `ready`

### AC-STARTUP-002

关联 [REQ-STARTUP-002](#req-startup-002)。

- **Given** 原生宿主报告 `blocked`，或返回空值、缺少必要字段或其他品牌的启动状态
- **When** renderer 执行启动门禁
- **Then** 门禁返回 `blocked`，端口和凭证加载均未调用

### AC-STARTUP-003

关联 [REQ-STARTUP-002](#req-startup-002)。

- **Given** 原生宿主报告匹配的 `ready`，但凭证严格加载失败
- **When** renderer 执行启动门禁
- **Then** 门禁返回 `blocked`

### AC-STARTUP-004

关联 [REQ-STARTUP-002](#req-startup-002)。

- **Given** 启动状态为 `blocked`，诊断信息包含原因和数据目录
- **When** 启动诊断页首次渲染
- **Then** 告警显示原因和目录，页面初始化期间未调用原生命令

## 实现与验证入口

- [启动门禁](../../packages/client/desktop/src/lib/startup-gate.ts)和[桌面主入口](../../packages/client/desktop/src/main.tsx)实现启动状态校验、严格加载和诊断页分流。
- [启动门禁测试](../../packages/client/desktop/src/__tests__/lib/startup-gate.test.ts)覆盖门禁状态和加载调用，[诊断页测试](../../packages/client/desktop/src/__tests__/components/startup-blocked.test.tsx)覆盖诊断内容和页面初始化。切到 `packages/client/desktop` 后运行 `bun run --bun vitest run src/__tests__/lib/startup-gate.test.ts src/__tests__/components/startup-blocked.test.tsx`。
- [独立品牌发行版验证](../../docs/testing.md#16-独立品牌发行版的验证adr-075)记录原生包与宿主数据隔离的验收方法。
