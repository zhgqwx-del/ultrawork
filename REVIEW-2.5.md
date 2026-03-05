# Iteration 2.5: ChatInput Component - Code Review

**审查时间**: 2026-03-06
**审查范围**: ChatInput 组件及其在 Home.tsx 和 Session.tsx 中的集成

---

## ✅ 通过的检查项

### 1. 类型安全
- ✅ 所有 props 都有明确的类型定义
- ✅ TypeScript 类型检查全部通过
- ✅ 事件处理器类型正确 (`KeyboardEvent<HTMLTextAreaElement>`, `ChangeEvent<HTMLTextAreaElement>`)

### 2. 核心功能
- ✅ Textarea 自动调整高度逻辑正确
- ✅ IME composing 处理完整 (`onCompositionStart/End`)
- ✅ Shift+Enter 换行, Enter 发送逻辑正确
- ✅ 按钮状态逻辑正确 (`canSend` 计算)
- ✅ Loading 状态显示正确

### 3. 可访问性
- ✅ 所有按钮都有 `aria-label`
- ✅ 动态 aria-label (loading 时显示 "Stop generating")
- ✅ 按钮有 `type="button"` (防止表单提交)

### 4. 用户体验
- ✅ 输入框 disabled 时有视觉反馈 (`opacity-50`)
- ✅ 按钮 hover 状态正确
- ✅ 发送按钮在不可用时有视觉反馈 (`opacity-30`)

### 5. 集成质量
- ✅ Home.tsx 和 Session.tsx 使用一致
- ✅ 状态管理模式统一
- ✅ 错误处理使用 try/catch/finally
- ✅ Session.tsx 发送成功后清空输入

---

## ⚠️ 发现的问题

### **Important** - 应该修复

#### 1. Home.tsx: 发送成功后未清空输入
**问题描述**:
Home.tsx 在 `handleSend` 中创建 session 并跳转后，没有清空输入框。虽然用户会跳转到新页面，但如果跳转失败或用户快速返回，会看到旧的输入内容。

**影响范围**: Home.tsx
**当前代码**:
```typescript
const handleSend = async () => {
  const text = input.trim()
  if (!text || sending) return

  setSending(true)
  try {
    const session = await createSession()
    api.sendMessage(session.id, text).catch(console.error)
    navigate(`/session/${session.id}`)
    // ❌ 没有清空 input
  } catch (err) {
    console.error("Failed to create session:", err)
  } finally {
    setSending(false)
  }
}
```

**建议修复**:
```typescript
try {
  const session = await createSession()
  api.sendMessage(session.id, text).catch(console.error)
  setInput("") // ✅ 清空输入
  navigate(`/session/${session.id}`)
} catch (err) {
  console.error("Failed to create session:", err)
}
```

**是否应该在 2.5 中修复**: ✅ 是

---

#### 2. ChatInput: overflow 设置可能导致内容被截断
**问题描述**:
Textarea 的 `overflow: hidden` 在某些边界情况下可能导致内容被截断（例如用户输入超长单词或粘贴大量文本）。

**影响范围**: ChatInput 组件
**当前代码**:
```typescript
style={{
  minHeight: variant === "home" ? "48px" : "20px",
  maxHeight: variant === "home" ? "200px" : "120px",
  overflow: "hidden", // ❌ 可能截断内容
}}
```

**建议修复**:
```typescript
style={{
  minHeight: variant === "home" ? "48px" : "20px",
  maxHeight: variant === "home" ? "200px" : "120px",
  overflow: "auto", // ✅ 允许滚动
}}
```

**是否应该在 2.5 中修复**: ✅ 是

---

### **Nice-to-have** - 可选改进

#### 3. ChatInput: 缺少 onFocus/onBlur 回调
**问题描述**:
组件没有暴露 `onFocus` 和 `onBlur` 回调，未来如果需要实现"聚焦时显示提示"等功能会不方便。

**建议**: 添加可选的 `onFocus` 和 `onBlur` props
**是否应该在 2.5 中修复**: ❌ 否，可以延后到需要时再添加

---

#### 4. ChatInput: + 按钮没有实际功能
**问题描述**:
+ 按钮目前只是占位，没有 onClick 处理器。

**建议**: 添加 `onAttachment?: () => void` prop
**是否应该在 2.5 中修复**: ❌ 否，附件功能属于 Phase 3

---

#### 5. Session.tsx: 缺少 session 不存在的处理
**问题描述**:
如果用户访问一个不存在的 session ID，页面会显示 "New Chat" 但无法正常工作（因为 `id` 存在但 `session` 为 undefined）。

**影响范围**: Session.tsx
**建议**: 添加 session 不存在的提示或重定向到首页
**是否应该在 2.5 中修复**: ❌ 否，这是边界情况处理，可以延后

---

### **Deferred** - 延后到后续迭代

#### 6. 缺少键盘快捷键提示
**问题描述**: 用户可能不知道 Shift+Enter 可以换行
**归属迭代**: 后续 UX 优化

#### 7. 缺少字符计数/限制
**问题描述**: 没有输入长度限制或提示
**归属迭代**: 后续 UX 优化

#### 8. 缺少草稿保存
**问题描述**: 刷新页面会丢失未发送的输入
**归属迭代**: Phase 3 或后续

---

## 📊 总结

### 必须修复 (2.5 中)
1. ✅ Home.tsx: 发送成功后清空输入
2. ✅ ChatInput: overflow 改为 auto

### 可选改进 (延后)
- onFocus/onBlur 回调
- + 按钮功能
- Session 不存在处理
- 键盘快捷键提示
- 字符计数/限制
- 草稿保存

### 整体评价
**代码质量**: ⭐⭐⭐⭐⭐ (5/5)
**功能完整性**: ⭐⭐⭐⭐☆ (4/5)
**用户体验**: ⭐⭐⭐⭐☆ (4/5)

2.5 的实现质量很高，只有 2 个小问题需要修复。修复后即可认为 2.5 完全完成。
