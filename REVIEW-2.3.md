# Iteration 2.3: Markdown 渲染 + 消息显示 - Code Review

**审查时间**: 2026-03-06
**审查范围**: 消息组件、Markdown 渲染、Session.tsx 集成

---

## ✅ 通过的检查项

### 1. 类型安全
- ✅ 所有组件都有明确的 TypeScript 类型定义
- ✅ TypeScript 类型检查全部通过
- ✅ 正确使用 `SendMessageResponse` 类型
- ✅ react-markdown 类型问题已妥善处理

### 2. 组件质量
- ✅ CodeBlock: 完整的内联/块级代码支持
- ✅ UserMessage: 简洁清晰的用户消息展示
- ✅ AssistantMessage: 完整的 Markdown 渲染
- ✅ MessageList: 正确的消息映射和空状态处理

### 3. Markdown 功能
- ✅ GFM 支持 (remarkGfm)
- ✅ 自定义样式覆盖所有元素
- ✅ 代码块复制功能
- ✅ 内联代码样式
- ✅ 表格、引用、链接样式

### 4. 状态管理
- ✅ useEffect cleanup flag 防止内存泄漏
- ✅ loading 状态正确处理
- ✅ 错误处理使用 try/catch
- ✅ 自动滚动逻辑正确

### 5. 用户体验
- ✅ 空状态提示
- ✅ Loading 状态显示
- ✅ 流式指示器动画
- ✅ 代码复制反馈 (Copied!)

---

## ⚠️ 发现的问题

### **Important** - 应该修复

#### 1. CodeBlock: 缺少复制失败处理
**问题描述**:
`handleCopy` 使用 `navigator.clipboard.writeText()` 但没有错误处理。如果用户浏览器不支持 Clipboard API 或权限被拒绝，会导致未捕获的异常。

**影响范围**: CodeBlock 组件
**当前代码**:
```typescript
const handleCopy = async () => {
  await navigator.clipboard.writeText(children)
  setCopied(true)
  setTimeout(() => setCopied(false), 2000)
}
```

**建议修复**:
```typescript
const handleCopy = async () => {
  try {
    await navigator.clipboard.writeText(children)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  } catch (err) {
    console.error("Failed to copy code:", err)
    // 可选: 显示错误提示
  }
}
```

**是否应该在 2.3 中修复**: ✅ 是

---

#### 2. Session.tsx: 发送消息后未刷新消息列表
**问题描述**:
`handleSend` 发送消息后，消息列表不会自动更新。用户需要刷新页面或重新进入 session 才能看到新消息。这是因为当前实现依赖 SSE (2.4 未完成)，但应该至少在发送成功后手动刷新消息列表。

**影响范围**: Session.tsx
**当前代码**:
```typescript
const handleSend = async () => {
  if (!id || !input.trim() || sending) return

  setSending(true)
  try {
    await api.sendMessage(id, input.trim())
    setInput("") // Clear input after successful send
    // ❌ 没有刷新消息列表
  } catch (err) {
    console.error("Failed to send message:", err)
  } finally {
    setSending(false)
  }
}
```

**建议修复**:
```typescript
const handleSend = async () => {
  if (!id || !input.trim() || sending) return

  setSending(true)
  try {
    await api.sendMessage(id, input.trim())
    setInput("")
    // ✅ 刷新消息列表
    const updatedMessages = await api.getMessages(id)
    setMessages(updatedMessages)
  } catch (err) {
    console.error("Failed to send message:", err)
  } finally {
    setSending(false)
  }
}
```

**是否应该在 2.3 中修复**: ✅ 是 (临时方案，2.4 会用 SSE 替代)

---

### **Nice-to-have** - 可选改进

#### 3. MessageList: 缺少消息 key 的唯一性保证
**问题描述**:
使用 `message.info.id || index` 作为 key，但如果 `id` 不存在，会 fallback 到 `index`。这在消息列表重新排序或插入时可能导致 React 渲染问题。

**建议**: 确保所有消息都有唯一 ID，或者使用更可靠的 key 生成策略
**是否应该在 2.3 中修复**: ❌ 否，OpenCode API 应该保证 ID 存在

---

#### 4. AssistantMessage: prose 类名可能与自定义样式冲突
**问题描述**:
使用了 `prose prose-sm` 类名，但同时又自定义了所有元素的样式。这可能导致样式冲突或不必要的 CSS 加载。

**建议**: 移除 `prose` 类名，完全使用自定义样式
**是否应该在 2.3 中修复**: ❌ 否，当前实现可以工作

---

#### 5. CodeBlock: 语言标签显示 "text" 不够友好
**问题描述**:
当没有语言时显示 "text"，对用户不够友好。

**建议**: 显示 "Plain Text" 或 "Code"
**是否应该在 2.3 中修复**: ❌ 否，小细节

---

#### 6. Session.tsx: 缺少消息加载失败的用户提示
**问题描述**:
消息加载失败时只在 console 打印错误，用户看不到任何提示。

**建议**: 显示错误提示 (toast 或 inline error)
**是否应该在 2.3 中修复**: ❌ 否，错误提示系统属于后续迭代

---

### **Deferred** - 延后到后续迭代

#### 7. 缺少消息时间戳显示
**问题描述**: 消息没有显示发送时间
**归属迭代**: 后续 UX 优化

#### 8. 缺少消息编辑/删除功能
**问题描述**: 无法编辑或删除已发送的消息
**归属迭代**: Phase 3

#### 9. 缺少代码语法高亮
**问题描述**: 代码块没有语法高亮，只有纯文本
**归属迭代**: 后续优化 (可选)

#### 10. 缺少图片/附件渲染
**问题描述**: 只支持文本消息
**归属迭代**: Phase 3

---

## 📊 总结

### 必须修复 (2.3 中)
1. ✅ CodeBlock: 添加复制错误处理
2. ✅ Session.tsx: 发送消息后刷新消息列表

### 可选改进 (延后)
- MessageList key 唯一性
- AssistantMessage prose 类名
- CodeBlock 语言标签
- 消息加载失败提示
- 消息时间戳
- 消息编辑/删除
- 代码语法高亮
- 图片/附件渲染

### 整体评价
**代码质量**: ⭐⭐⭐⭐⭐ (5/5)
**功能完整性**: ⭐⭐⭐⭐☆ (4/5) - 缺少消息刷新
**用户体验**: ⭐⭐⭐⭐☆ (4/5) - 缺少错误提示

2.3 的实现质量很高，只有 2 个问题需要修复。修复后即可认为 2.3 完全完成。

---

## 🔍 额外发现

### 性能考虑
- ✅ MessageList 使用 `divide-y` 而不是每个消息单独的 border，性能更好
- ✅ 自动滚动使用 `smooth` behavior，用户体验好
- ⚠️ 每次消息变化都会触发滚动，可能需要节流 (但当前实现可接受)

### 可访问性
- ✅ CodeBlock 复制按钮有 `aria-label`
- ✅ 链接有 `target="_blank"` + `rel="noopener noreferrer"`
- ⚠️ 消息没有 `role` 属性 (但不是必需的)

### 代码组织
- ✅ 组件职责清晰，单一职责原则
- ✅ 类型定义完整
- ✅ 样式使用 CSS 变量，易于主题化
