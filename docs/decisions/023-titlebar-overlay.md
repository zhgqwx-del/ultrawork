# ADR-023: macOS 标题栏 Overlay 模式

**状态**: Accepted
**日期**: 2026-05-08
**关联**: UI 优化

## 背景

当前 Ultrawork 使用 Tauri 默认的 macOS 原生标题栏，窗口顶部显示一个独立的灰色条带 "Ultrawork" 文字。与同类应用（如 Manus）对比，这个标题栏：

1. 浪费约 28px 的垂直空间
2. 与应用的深色/浅色主题不融合，视觉割裂
3. 标题文字 "Ultrawork" 与侧边栏 Logo + 品牌名重复，无信息增量

## 决策

将 Tauri 窗口标题栏切换为 **overlay 模式**，隐藏标题文字，让应用内容延伸到窗口顶部，macOS 交通灯（关闭/最小化/最大化）浮在内容之上。

### 配置变更

`packages/client/desktop/src-tauri/tauri.conf.json`:

```json
"windows": [{
  "title": "Ultrawork",
  "titleBarStyle": "Overlay",
  "hiddenTitle": true,
  ...
}]
```

> 注意：Tauri 2 枚举值使用 PascalCase（`Overlay`，非 `overlay`）。

### 前端改动清单

#### 1. 侧边栏顶部 padding — `left-sidebar.tsx`

交通灯位于窗口左上角约 `(12,12)` 到 `(68,28)` 区域，会遮挡侧边栏头部。

**展开态**（`w-72`，第 161 行附近）：
- 当前：`p-4`（16px），Logo + 品牌名被交通灯覆盖
- 改为：`p-4 pt-9`（顶部 36px），将内容推到交通灯下方

**折叠态**（`w-12`，第 316 行附近）：
- 当前：`p-2 pt-3`（顶部 12px），Logo 按钮被完全覆盖
- 改为：`p-2 pt-10`（顶部 40px），Logo 在交通灯正下方
- 注意：折叠态宽度 48px < 交通灯宽度 68px，交通灯右侧约 20px 会溢出到主内容区，这是 macOS 的标准行为（Finder、Safari 等均如此）

#### 2. 窗口拖拽 — `drag-region.tsx`（新建）+ 各组件

overlay 模式移除了原生标题栏的拖拽功能，需要自行定义。

> **⚠️ 实施中发现的问题**：`data-tauri-drag-region` 属性在 Overlay 模式下**不生效**（已知 bug [tauri-apps/tauri#9503](https://github.com/tauri-apps/tauri/issues/9503)）。且 `startDragging()` API 需要 `core:window:allow-start-dragging` 权限，该权限**不在** `core:window:default` 权限集中。

**最终方案**：使用 `getCurrentWindow().startDragging()` API + `onMouseDown` 事件手动触发拖拽。

新建 `drag-region.tsx` 提供：
- `handleDrag(e)` — 共享的 mousedown 处理函数，跳过 `button/a/input/select/textarea` 等交互元素
- `DragRegion` — 透明拖拽条组件（`fixed top-0 h-8 z-50`），用于无 TopBar 的页面

需要在 `capabilities/default.json` 中显式添加权限：
```json
"core:window:allow-start-dragging"
```

拖拽区域覆盖点：

| 区域 | 实现方式 |
|------|---------|
| TopBar（Home/Session/Settings） | `<header onMouseDown={handleDrag}>` |
| 左侧 sidebar 展开态头部 | header div `onMouseDown={handleDrag}` |
| 左侧 sidebar 折叠态头部 | header div `onMouseDown={handleDrag}` |
| 右侧 sidebar 顶部 | 独立 `h-9` 拖拽条（不能放整个 aside 上，否则阻断滚动） |
| WorkspaceSelector 页 | `<DragRegion />` 组件 |
| Loading 态 | `<DragRegion />` 组件 |

> **⚠️ 右侧 sidebar 踩坑**：最初将 `onMouseDown={handleDrag}` 放在整个 `<aside>` 上，导致面板内容无法滚动（mousedown 在滚动区域也会触发 `startDragging()`）。修复为仅在顶部加独立的拖拽条。

#### 3. 主内容区边距/圆角 — `root-layout.tsx`

- `my-2`（上下各 8px 间距）→ `mb-2`（只保留底部间距），顶部紧贴窗口边缘
- `rounded-2xl` → `rounded-b-2xl`（只保留底部圆角），避免顶部圆角露出底色缝隙

## 考虑过的替代方案

### 方案 A：仅隐藏标题文字

```json
"hiddenTitle": true
```

- 优点：改动最小，只去掉文字
- 缺点：原生标题栏仍占垂直空间，视觉效果改善有限
- **不选**：无法达到与 Manus 等现代应用对齐的效果

### 方案 C：完全去掉原生窗口装饰

```json
"decorations": false
```

- 优点：完全自定义，最大自由度
- 缺点：需要自己实现交通灯按钮（关闭/最小化/全屏），工作量大，且难以保持原生 macOS 行为（如长按绿色按钮的 tile 功能）
- **不选**：投入产出比低

## 跨平台考量

**`titleBarStyle: "overlay"` 是 macOS 专属功能**（[tauri-apps/tauri#7674](https://github.com/tauri-apps/tauri/issues/7674) 请求 Windows 支持，官方 closed as not planned）。

| 平台 | `titleBarStyle: "overlay"` 行为 |
|------|------|
| **macOS** | 交通灯浮在内容上，标题栏透明，内容延伸到顶部 |
| **Windows** | **配置被忽略**，仍显示标准 Windows 标题栏 |
| **Linux** | **配置被忽略**，行为取决于窗口管理器 |

**当前影响**：Ultrawork 仅支持 macOS（bundle targets: `dmg`, `app`），本次改动无跨平台风险。

**未来 Windows 支持时的选项**：

1. **接受差异**：macOS overlay + Windows 默认标题栏。功能正常但视觉不一致，且前端为交通灯预留的额外 padding 在 Windows 上会浪费空间
2. **Windows 自定义标题栏**：`"decorations": false` + 前端自绘标题栏和窗口控制按钮。视觉一致但工作量大
3. **平台条件适配**：用 Tauri `platform()` API + CSS 变量（`--titlebar-safe-top`）按平台设置不同的顶部 padding（macOS `36px`，Windows/Linux `0`）

## 实际改动清单

| 文件 | 改动 |
|------|------|
| `tauri.conf.json` | `+titleBarStyle: "Overlay"`, `+hiddenTitle: true` |
| `capabilities/default.json` | `+core:window:allow-start-dragging` 权限 |
| `drag-region.tsx` | **新建** — `handleDrag()` 共享函数 + `DragRegion` 组件 |
| `index.ts` | 导出 `DragRegion`, `handleDrag` |
| `top-bar.tsx` | `+onMouseDown={handleDrag}` on header |
| `left-sidebar.tsx` | 展开态 `p-4`→`p-4 pt-9` + `onMouseDown`；折叠态 `pt-3`→`pt-10` + `onMouseDown` |
| `root-layout.tsx` | `my-2`→`mb-2`，`rounded-2xl`→`rounded-b-2xl`，loading 态加 `<DragRegion />` |
| `Session.tsx` | 右侧 sidebar 顶部加 `h-9` 拖拽条 |
| `WorkspaceSelector.tsx` | 加 `<DragRegion />` |

## 验收标准

1. macOS 交通灯正常显示，不与任何 UI 元素重叠
2. 侧边栏展开/折叠切换时，交通灯区域均无遮挡
3. TopBar 区域可拖动窗口，按钮点击正常
4. WorkspaceSelector 页和 loading 态均可拖动窗口
5. 深色/浅色主题下视觉一致
6. 窗口最大化/还原/全屏行为不受影响

## 后果

**正面**：
- 视觉上与主流桌面应用对齐，更现代
- 回收约 28px 垂直空间
- 去除重复的品牌文字

**负面**：
- 侧边栏顶部 padding 增加，展开态损失约 20px 可用空间（净节省 ~8px）
- 未来跨平台需要额外适配
