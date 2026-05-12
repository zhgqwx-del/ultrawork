# ADR-024: 工作目录路径展示优化

**状态**: Accepted
**日期**: 2026-05-12
**关联**: UX 优化、WorkspacePanel

## 背景

当前工作目录信息显示在右侧栏 `WorkspacePanel` 顶部（`workspace-panel.tsx:164-180`），布局为：

```
[📁] 工作目录                         [🔄]
     /Users/zhangguoqiang/ai-workspace/cl...
```

存在以下问题：

1. **路径截断丢失关键信息** — 右侧栏宽度有限，长路径被 CSS `truncate` 截断，而最有用的部分（项目名）恰好在末端被截掉
2. **查看全路径依赖 hover** — 当前用 `title` 属性实现 tooltip，macOS 原生 tooltip 有 ~500ms 延迟且样式简陋，效率低
3. **文件夹 icon 不可交互** — 有文件夹图标但不可点击，无法快速在 Finder 中打开工作目录
4. **缺少快速复制能力** — 无法一键复制完整路径用于终端或其他工具

## 方案评估

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| **A. 智能缩略 + 交互增强** | 路径压缩为 `~/首段/.../末段`，突出项目名，添加复制/Finder 交互 | 信息密度高，改动小 | 需要缩略算法 |
| B. 面包屑分段 | 每段目录可单独点击 | 导航灵活 | 占空间大，右侧栏排版压力 |
| C. 双行标签 + 可展开 | 第一行项目名，第二行可展开完整路径 | 信息分层清晰 | 交互稍复杂，占更多垂直空间 |
| D. Tooltip 增强 | 仅替换原生 tooltip 为 Radix Tooltip | 改动最小 | 不解决"不 hover 看不到"的根本问题 |

## 决策

采用**方案 A：智能缩略路径 + 交互增强**。

### 新布局

```
[📁] ultrawork                    [📋][🔄]
     ~/ai-workspace/.../ultrawork
```

### 具体设计

#### 1. 项目名突出显示

- 第一行显示 `basename(directory)` 作为项目名，字号 12px，不截断
- 替代原来的 "工作目录" 静态标签，信息量更大

#### 2. 智能缩略路径

路径缩略算法 `shortenPath(fullPath, maxSegments?)`：

```
输入: /Users/zhangguoqiang/ai-workspace/claude-workspace/ultrawork01/ultrawork
输出: ~/ai-workspace/.../ultrawork

规则:
1. 将 HOME 目录替换为 ~
2. 如果段数 ≤ maxSegments(默认 4)，直接显示
3. 否则保留首段 + ... + 末尾 1 段（不含 basename，因已在第一行显示）
4. 如果路径在 ~ 下只有 1-2 层，不折叠（如 ~/projects/foo 保持原样）
```

- 缩略路径显示在第二行，字号 10px，muted 色
- 仍然保留 `title={fullPath}` 作为兜底

#### 3. 交互增强

| 交互 | 行为 |
|------|------|
| **点击文件夹 icon** | 调用 `reveal_file_in_finder` Tauri command，在 Finder 中打开工作目录 |
| **点击路径文本** | 复制完整路径到剪贴板，短暂显示 "已复制" 反馈（icon 切换 2s） |
| **📋 复制按钮** | 同上，提供显式可发现的复制入口 |
| **🔄 刷新按钮** | 保持不变，刷新文件树 |

#### 4. 复制反馈

使用 Tauri `writeText` clipboard API（已有 `clipboard-manager:allow-write-text` 权限），复制成功后：
- 📋 图标临时切换为 ✓（2 秒后恢复）
- 不使用 toast，避免打断工作流

## 改动范围

| 文件 | 改动内容 |
|------|---------|
| `src/components/session/workspace-panel.tsx` | 重构 164-180 行的目录头部区域 |
| `src/lib/utils.ts`（或新建 `path-utils.ts`） | 添加 `shortenPath()` 工具函数 |

不涉及新依赖、不影响其他组件、不改变数据流。

## 视觉对比

### Before

```
┌─────────────────────────────────────┐
│ 📁 工作目录                      🔄 │
│    /Users/zhangguoqiang/ai-MDorks... │
└─────────────────────────────────────┘
```

### After

```
┌─────────────────────────────────────┐
│ 📁 ultrawork                  📋 🔄 │
│    ~/ai-workspace/.../ultrawork     │
└─────────────────────────────────────┘
```

## 备注

- `shortenPath` 的 `maxSegments` 参数可根据实际侧栏宽度微调，默认 4 段
- 如果 `directory` 不在 HOME 下（如 `/opt/projects/...`），不做 `~` 替换，仅做段数折叠
- 文件夹 icon 点击 Finder 使用已有的 `reveal_file_in_finder` Tauri command（`lib.rs` 已实现）
