# ADR-006: 模型管理独立 Dialog
**状态**: Accepted
**日期**: 2026-03-03
**关联轮次**: Round 4

## 背景

需要支持多 Provider（OpenCode/Anthropic/OpenAI 等）和模型切换。设计稿中讨论了放在 Settings 还是独立管理。用户在日常使用中频繁切换模型，操作路径的长短直接影响体验。

## 决策

ModelDialog 单例（在 main.tsx 通过 ModelDialogSingleton 渲染）+ ChatInput 区域的 ModelSelector Popover 快速切换。不作为 Settings Tab。

- ModelDialog 包含完整的 Provider 管理（AddProviderDialog）和模型配置能力
- ModelSelector 以 Popover 形式嵌入 ChatInput 区域，提供一键切换当前模型
- ModelDialog 通过 ModelDialogSingleton 在 main.tsx 全局渲染一次，避免多实例

## 考虑过的替代方案

1. **Settings 内 Tab** — 操作路径长，用户需要先进入设置再找到模型 Tab，不方便快速切换。
2. **顶部工具栏选择器** — 占用顶部空间，模型切换并非每次交互都需要，不常用时浪费位置。

## 后果

**正面**：
- 快速切换模型无需进入设置页面
- 单例渲染避免多实例状态冲突
- clearModelCache() 确保新 Provider 添加后立即可见
- ModelSelector 5 分钟 TTL 缓存减少 /provider 请求（响应 ~2.1MB）

**负面**：
- ModelDialog 组件较重，Provider 列表响应体约 2.1MB，需要模块级 TTL 缓存机制
- 单例模式需要额外的全局事件机制来触发 Dialog 打开
