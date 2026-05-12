# ADR-025: 窗口布局对称性修复与平台感知适配

**状态**: Accepted
**日期**: 2026-05-12
**关联**: ADR-023 (macOS 标题栏 Overlay 模式)

## 背景

ADR-023 将 macOS 标题栏切换为 Overlay 模式后，遗留了两个布局问题：

1. **主内容区上下不对称**：底部有圆角 + 间距（`mb-2 rounded-b-2xl`），顶部无圆角无间距，视觉不对称
2. **折叠态交通灯溢出**：侧边栏折叠宽度 `w-12`（48px）< macOS 交通灯宽度（~68px），交通灯溢出到主内容区覆盖 TopBar 按钮

## 决策

### 1. 主内容区恢复对称卡片布局

```
mb-2 mr-2 rounded-b-2xl → my-2 mr-2 rounded-2xl
```

主内容区变为四角圆角、上下均有间距的卡片，悬浮在 sidebar 背景色之上。

ADR-023 原始顾虑"顶部圆角露出底色缝隙"不再成立——底部已经展示了这种风格，且"卡片悬浮"是现代桌面应用的主流设计语言。

### 2. 折叠态平台感知宽度

新建 `src/lib/platform.ts`，通过 `navigator.platform` 同步检测平台：

```ts
export const isMacOS = navigator.platform.startsWith("Mac")
```

折叠态宽度按平台设置：

```tsx
leftOpen ? "w-72" : isMacOS ? "w-[68px]" : "w-12"
```

- macOS：68px，恰好容纳交通灯
- Windows/Linux：48px，保持紧凑

### 3. 展开/折叠元素对齐

统一两态的 padding，消除切换时的跳变：

| 区域 | 修改前 | 修改后 |
|------|--------|--------|
| Logo 区顶部 | 展开 `pt-9` / 折叠 `pt-10` | 统一 `pt-9` |
| 底部区 | 展开 `p-3` / 折叠 `pb-4` | 统一 `pb-3` |

## 考虑过的替代方案

### 折叠态宽度：固定 68px（不做平台判断）

- 优点：改动最小，一个值
- 缺点：Windows/Linux 无交通灯却多占 20px
- **不选**：既然成本仅多一行 import + 一个三元，做好跨平台更规范

### 折叠态宽度：主内容区加左 padding 补偿

- 优点：不改变 sidebar 宽度
- 缺点：交通灯仍视觉跨界，实现更复杂
- **不选**：不如直接加宽 sidebar 干净

### 平台检测：`@tauri-apps/plugin-os`

- 优点：官方 API，最可靠
- 缺点：需安装 plugin + Cargo 配置，且是异步 API
- **不选**：`navigator.platform` 在 Tauri WebView 中完全可用，同步且零依赖

## 后果

**正面**：
- 主内容区视觉对称，符合现代桌面应用设计语言
- macOS 交通灯不再溢出，折叠态更整洁
- 展开/折叠切换无跳变
- Windows/Linux 兼容就绪

**负面**：
- `navigator.platform` 在浏览器中标记为 deprecated（Tauri WebView 中仍稳定可用）
- 展开态的 `pt-9` 在 Windows 上仍有多余空白（ADR-023 遗留，需未来统一用 `isMacOS` 条件化）
