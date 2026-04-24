# Config Isolation 手动测试计划

对应 ADR: `docs/decisions/020-config-isolation.md`

## 前置条件

- 已执行 `bun run --bun scripts/build-opencode.ts`（sidecar 已编译）
- `~/.config/opencode/opencode.json` 存在（老用户数据）

---

## 1. 迁移验证（模拟老用户升级）

### 1.1 首次启动迁移

**准备**：删除新路径（如已存在）
```bash
rm -rf ~/.config/ultrawork ~/.local/share/ultrawork ~/.cache/ultrawork ~/.local/state/ultrawork
```

**操作**：启动 app（`bun run tauri:dev` 或 `./setup.sh --dev`）

**验证**：
- [ ] 终端日志出现 `[migration] Migrating data from opencode → ultrawork...`
- [ ] `~/.config/ultrawork/opencode.json` 存在且内容与 `~/.config/opencode/opencode.json` 一致
- [ ] `~/.local/share/ultrawork/auth.json` 存在
- [ ] `~/.local/share/ultrawork/opencode-.db` 存在
- [ ] `~/.config/opencode/opencode.json` 原文件未被删除或修改

### 1.2 迁移幂等性

**操作**：关闭 app，再次启动

**验证**：
- [ ] 终端日志中**不再出现** `[migration] Migrating data` 字样

---

## 2. UI 功能验证（迁移后数据可用）

### 2.1 Provider 配置

**操作**：打开 Settings → Model 区域

**验证**：
- [ ] 已配置的 provider 仍然显示（如 opencode provider）
- [ ] API Key 仍然存在（不需要重新输入）
- [ ] 模型列表正常加载

### 2.2 会话历史

**操作**：查看侧边栏会话列表

**验证**：
- [ ] 历史会话仍然存在（迁移前的对话记录）
- [ ] 可以打开历史会话查看完整消息

### 2.3 MCP 服务

**操作**：打开 Settings → MCP 或查看 AI 对话中的工具列表

**验证**：
- [ ] 已配置的 MCP 服务仍然显示（如 browser）
- [ ] MCP 服务可以正常连接（状态为 connected）

### 2.4 发送消息

**操作**：在任意会话中发送一条测试消息

**验证**：
- [ ] 消息发送成功，AI 正常回复
- [ ] 回复后刷新/重启 app，新消息持久化在 `~/.local/share/ultrawork/opencode-.db` 中

---

## 3. 隔离验证

### 3.1 配置写入隔离

**操作**：在 Ultrawork Settings 中修改任意配置（如切换模型）

**验证**：
- [ ] 修改写入 `~/.config/ultrawork/opencode.json`
- [ ] `~/.config/opencode/opencode.json` 内容**未变化**

### 3.2 新路径确认

**操作**：检查文件系统

```bash
ls ~/.config/ultrawork/
ls ~/.local/share/ultrawork/
ls ~/.cache/ultrawork/
ls ~/.local/state/ultrawork/
```

**验证**：
- [ ] config 目录有 `opencode.json`
- [ ] data 目录有 `opencode-.db`、`auth.json`、`log/`
- [ ] cache 目录有 `models.json`、`version`
- [ ] state 目录有 `locks/`

---

## 4. 全新安装验证（可选）

模拟从未使用过 Ultrawork 或 OpenCode 的用户。

**准备**：
```bash
rm -rf ~/.config/ultrawork ~/.config/opencode
rm -rf ~/.local/share/ultrawork ~/.local/share/opencode
rm -rf ~/.cache/ultrawork ~/.cache/opencode
rm -rf ~/.local/state/ultrawork ~/.local/state/opencode
```

**操作**：启动 app

**验证**：
- [ ] 终端日志中**不出现** `[migration]` 字样（无旧数据，跳过迁移）
- [ ] app 正常启动，进入空白初始状态
- [ ] 所有新数据写入 `~/.config/ultrawork/` 等新路径
- [ ] `~/.config/opencode/` **不被创建**

> 注意：此测试会清除所有 opencode 和 ultrawork 数据，测试完需重新配置 provider。仅在需要时执行。

---

## 测试结果记录

| # | 测试项 | 通过 | 备注 |
|---|--------|------|------|
| 1.1 | 首次启动迁移 | | |
| 1.2 | 迁移幂等性 | | |
| 2.1 | Provider 配置可用 | | |
| 2.2 | 会话历史完整 | | |
| 2.3 | MCP 服务正常 | | |
| 2.4 | 发送消息正常 | | |
| 3.1 | 配置写入隔离 | | |
| 3.2 | 新路径确认 | | |
| 4 | 全新安装（可选） | | |

测试日期：______ 测试人：______
