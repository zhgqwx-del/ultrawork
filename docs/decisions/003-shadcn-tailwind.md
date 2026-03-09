# ADR-003: shadcn/ui + Tailwind CSS 4
**状态**: Accepted
**日期**: 2026-02-27
**关联轮次**: Phase 2

## 背景
需要建立 UI 组件体系，参考 WorkAny 设计稿进行 1:1 还原。

## 决策
采用 shadcn/ui 模式（Radix 无样式原语 + Tailwind CSS 4 utility classes），通过 CSS 变量建立 design token 体系。

## 考虑过的替代方案
1. **Ant Design / Material UI** — 预制样式难以定制到设计稿精度。
2. **纯 CSS Modules** — 维护成本高，缺少 headless 组件。
3. **Styled Components** — runtime CSS-in-JS 性能开销。

## 后果
**正面**：组件完全可定制、Radix 内置 a11y、Tailwind 4 零 JS runtime、CSS 变量支持主题切换。

**负面**：需要手动实现每个组件样式、shadcn 不是真正的 npm 包（复制源码模式）。
