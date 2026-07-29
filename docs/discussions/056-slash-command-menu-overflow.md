# 056 — `/` 技能菜单：无界弹层、失效过滤，以及两个未被发现的功能性 bug

> 状态：✅ **P0 + P1 + 分组已实现**（2026-07-28，未发版）。**已过真机（Tauri 原生窗口 / WKWebView）验证，见 §8.4**；视觉观感项仍待用户判断。实现期新增四项发现见 §8.2 / §8.4。
> 测试：新增 51 条（desktop 730 → 781 全绿），含机器对比度门禁 `command-menu-contrast.test.ts`；另有真浏览器走查 `e2e/command-menu-ui-walkthrough.e2e.ts`（11/11 PASS）覆盖 jsdom 无法触及的排版层，见 §8.3。
> 日期：2026-07-28
> 触发：真机截图 `Screenshot 2026-07-28 at 17.50.47.png` —— Home 页输入框敲 `/` 唤起技能菜单，条目被视口顶部截断且无法滚动到。
> 参考：`Screenshot 2026-07-28 at 17.19.24.png`（另一产品同类功能）
> 关联：`docs/conventions.md`（下拉列表约定）· `docs/gotchas.md §12`（跨平台）· ADR-070 的教训（不要把正确性绑在启发式上）

---

## 一、结论先行

**是缺陷，不是「技能变多了自然如此」。** 现在只有 9 个内置技能就已经有约 60% 的条目不可达。

而且比截图暴露的更严重：本次审查在同一个组件里**另外实测出两个功能性 bug**（消息发不出去、Escape 吞掉用户输入）和**一处 WCAG 不达标**，它们与「列表太长」无关，靠肉眼看截图发现不了。

唯一实现文件：`packages/client/desktop/src/components/chat/command-selector.tsx`（113 行）。

---

## 二、实测证据（探针脚本，非推测）

用一个临时 vitest 探针（真实 `CommandSelector` + mock `getCommands`）跑出的结论，6/6 通过后已删除探针文件：

| # | 断言 | 实测输出 | 判定 |
|---|---|---|---|
| A | 弹层容器无 `max-h` / `overflow` | `absolute bottom-full left-0 z-50 mb-1 w-full max-w-md rounded-lg border … shadow-lg` | ✅ 确认 |
| B | 描述节点无 `truncate`/`line-clamp` | `<span class="ml-2 text-[10px] opacity-70">` —— 与 name 是**同级行内 span**，连成一段流式文本 | ✅ 确认 |
| C | 单字母不缩小候选集 | `/u` → 2/2 全中 | ✅ 确认 |
| D | **无匹配时 Enter 既不发送也不 preventDefault** | `onSend calls: 0, defaultPrevented: false` | 🔴 **新发现** |
| E | **Escape 会吃掉用户输入的 `/`** | `/deck` + Esc → `"deck"` | 🔴 **新发现** |
| F | 无 `onMouseEnter` 同步，选中态与 hover 态同色 | 均为 `bg-[var(--color-accent)]`，行上无 mouseenter | ⚠️ 加滚动后致命 |

### 2.1 D — `/xxx` 消息永远发不出去（功能性 bug）

`chat-input.tsx:272` 的 `showCommandSelector = value.startsWith("/") && !value.includes(" ")` 只看文本形状，与「菜单是否真的有候选」无关。于是：

- `chat-input.tsx:305`：`if (showCommandSelector) return` —— 直接 return，**既不 `onSend()` 也不 `preventDefault()`**；
- `command-selector.tsx:60`：`if (filtered.length === 0) return` —— 也不处理。

两边都以为对方会管。实测 `onSend` 调用 0 次、事件未被 prevent。在真实浏览器里未被 prevent 的 Enter 会在 textarea 插入换行，而 `"\n"` 不是空格 ⇒ `showCommandSelector` 仍为 true ⇒ **用户被永久卡住，直到手动删掉 `/` 或打一个空格**。

复现路径（真实场景，非构造）：输入 `/etc/hosts` 这个文件路径、或中文用户凭直觉敲 `/清空`、或任何不匹配的 `/词`。

> 注：「插入换行」这一步是浏览器默认行为的推论；**经测试证实的部分是「onSend 未调用 且 事件未被 prevent」**。

### 2.2 E — Escape 破坏用户已输入的文本（功能性 bug）

`chat-input.tsx:293`：`onChange(value.startsWith("/") ? value.slice(1) : value)`。关菜单的方式是**删掉那个斜杠**。实测 `/deck` 按 Esc 后变成 `deck`。用户想「关掉菜单继续打字」，得到的是「我的字符被吃了」，且没有任何办法在不重打的情况下把菜单叫回来。

### 2.3 描述文字对比度不达标（WCAG）

`text-[var(--color-fg-muted)]` + `opacity-70`，10px：

| 场景 | 有效前景 | 对比度 | AA 4.5:1 |
|---|---|---|---|
| 浅色 · 未选中行描述 | `#9a9aa1` on `#fafafb` | **2.68:1** | ❌ FAIL |
| 深色 · 未选中行描述 | `#7b7b83` on `#232327` | **3.73:1** | ❌ FAIL |
| 浅色 · 选中行描述 | `#5a5a5c` on `#f4f4f5` | 6.26:1 | ✅ |
| 浅色 · 行名 `/name` | `#71717a` on `#fafafb` | 4.63:1 | ✅（贴线） |

10px 不属于 WCAG「大字号」（需 ≥18.66px 或 14pt 粗体），所以门槛是 4.5:1，不是 3:1。**2.68:1 这个数与 2026-07-27「AI 生成内容提示」那次踩到的是同一个数**——同样是 `muted 前景 × opacity-70`。这个组合在本项目里应视为已知反模式。

---

## 三、结构性证据：这是「漏写」，不是「设计选择」

同目录三个兄弟下拉，**全部**带高度上限 + 滚动，只有 `command-selector` 没有：

| 组件 | 容器 | 行结构 |
|---|---|---|
| `agent-selector.tsx:89,101,114-118` | `max-h-64 overflow-y-auto scrollbar-soft` | name 一行 + description 一行 `truncate` + `min-h-[2.75rem]` |
| `model-selector.tsx:133` | `max-h-60 overflow-y-auto scrollbar-soft` | — |
| `team-member-select.tsx:49` | `max-h-64 overflow-y-auto` | — |
| **`command-selector.tsx:87`** | **无** | **name/desc 同行内流，无截断** |

`agent-selector` 的行结构**恰好就是参考产品截图里的样子**。也就是说：本项目已经有正确写法，`command-selector` 只是没沿用。

还有一层：另外三个用的是 `@/components/ui/popover`（Radix，portal 到 body、自带碰撞翻转），而 `command-selector` 是手写的 `absolute` div，被 `root-layout.tsx:45` 的 `overflow-hidden` **硬裁切在主内容卡片内**——它不仅是「超出视口」，而是**根本无法逃出卡片**。这是 chat 目录里唯一没走 Popover 原语的下拉。

---

## 四、数据侧根因：description 是给模型看的

链路：`command-selector` 的 `cmd.description` ← `/command` ← `vendor/opencode/.../command/index.ts:150-161` 的 skill 分支 ← **SKILL.md frontmatter 的 `description`**。

该字段的用途是技能路由/触发判定，写给模型。实测 9 个内置技能：

| skill | 字符数 | | skill | 字符数 |
|---|---|---|---|---|
| deckcraft | 605 | | doc-edit | 315 |
| wecom-assistant | 572 | | pdf | 250 |
| dingtalk-assistant | 495 | | skill-installer | 227 |
| feishu-assistant | 428 | | markdown-exporter | 163 |
| skill-creator | 319 | | **中位数** | **315** |

其中 4/9 含反引号 markdown（截图里 `` `lark-cli skills read <name>` ``、`` `/doc/` `` 都是**原样显示**的），4/9 以 `Use when the user wants to…` 这类模型侧样板开头。

### 4.1 过滤器因此失效（实测）

`command-selector.tsx:41-42` 在 300–600 字符的描述上做无排序 substring 匹配：

| 输入 | 只匹配 name | 当前实现 |
|---|---|---|
| `/d` `/p` `/s` `/w` `/m` `/f` | 5 / 2 / 5 / 2 / 2 / 3 | **均为 9（全中）** |
| `/doc` | 1 | 6 |
| `/sk` | 2 | 8 |
| `/pdf` | 1 | 4 |

**任何单字母输入都筛不掉任何一条。** 列表太长唯一的逃生出口也是坏的。

### 4.2 高度估算（推导，非实测，已交叉校验）

按 445px 面板宽（`max-w-md`，与截图量得一致）、10px 字 ≈5.4px/字符、行高约 20px（按钮未设 font-size，行盒 strut 用 body 的 16px ⇒ 10px 的字仍占约 20px 行高）：

- 9 个技能面板总高 **≈1200px**；Home 页输入框上方可用 **≈550px** ⇒ **≈60% 不可达**。
- 交叉校验：截图可见约 455px，装下 feishu 尾部 + wecom + markdown-exporter，按同一模型算 416px，误差 ~10%，模型自洽。

---

## 五、根因分层

| 层 | 根因 | 位置 | 性质 |
|---|---|---|---|
| L1 布局 | 无 `max-h` + 无 `overflow-y-auto`；且被祖先 `overflow-hidden` 硬裁 | `command-selector.tsx:87` / `root-layout.tsx:45` | 漏写 |
| L2 行渲染 | 描述不截断、与 name 同行内流；strut 16px | `:104-107` | 漏写 |
| L3 交互契约 | 「菜单可见」与「菜单有候选」两个状态被混为一谈 | `chat-input.tsx:272,305` + `:60` | **逻辑缺陷** |
| L4 交互契约 | 关闭菜单 = 删用户字符 | `chat-input.tsx:293` | **逻辑缺陷** |
| L5 检索 | 长描述上无排序 substring 匹配 | `:38-44` | 设计不足 |
| L6 数据语义 | 模型侧触发描述被直接当人看的标签 | SKILL.md frontmatter ↔ UI | 跨层缺口 |
| L7 可访问性 | `muted × opacity-70` @10px | `:106` | 已知反模式 |
| L8 后端错配 | 列表恒取 OpenCode 后端，与实际收信的 agent 无关 | 见 §七 | **架构缺口** |

L1/L2/L3/L4/L5/L7 全在前端两个文件内，L6/L8 需要单独决策。

---

## 六、方案

### P0 — 止血 + 修 bug（必做，单文件为主）

1. 容器加 `max-h-64 overflow-y-auto scrollbar-soft`（抄 `agent-selector.tsx:89`）。
2. 行改两行式：name 一行、description 一行 `truncate`；加 `min-h-[2.75rem]`；给按钮显式 `text-xs` 消掉 16px strut。
3. **补 scroll-into-view**：闲置的 `listRef`（:23 声明、:86 绑定、**从未被读取**）真正用起来，`selectedIndex` 变化时 `scrollIntoView({ block: "nearest" })`。**不做这条，第 1 条就会引入新缺陷**（方向键往下走，选中项滚出可视区）。
4. **修 D**：把 Enter/发送的判据从「文本以 `/` 开头」改成「菜单当前有候选」。需要把 `filtered.length` 提升到 `ChatInput` 可见（受控 `open` 状态，或 `onMatchCountChange` 回调）。
5. **修 E**：Escape 只关菜单（置一个 `dismissed` 标志），不改文本；文本再变化时复位。
6. **修 L7**：去掉 `opacity-70`，未选中行描述改用 `--color-fg-muted` 原色（4.63:1）或更深的一档。
7. **F 的连带**：加 `onMouseEnter` 同步 `selectedIndex`，并让选中态与 hover 态视觉可区分（现在同色 ⇒ 有滚动后会出现「两行同时高亮，不知道 Enter 选哪个」）。

### P1 — 让过滤器真的能用

**不要简单改成「只匹配 name」**：实测 `/ppt` → deckcraft、`/md` → markdown-exporter 这类有价值的关键词命中会一起消失，且因 `:82` 的 `return null`，菜单会直接不见。建议：

1. **改为排序而非过滤**：name 前缀 > name 子串 > description 子串，分段稳定排序，全部展示；description 命中段加分隔线 + 分组标题。
2. description 参与匹配设最小长度门槛（≥2 字符），消掉「单字母全中」。
3. 补「无匹配」空状态，替代 `return null`。

### P2 — 拆开看，必要性差异很大（下节详述）

---

## 七、完备性审查：原方案缺的四项

> 这一节是对「P0+P1+P2 是否完备」的正面回答：**原方案不完备**，缺以下四项。前两项已并入 P0。

### 7.1（已并入 P0）D/E 两个功能性 bug

原方案只解决「显示」，这两个是「功能」。**且存在一个顺序陷阱**：P1 把「过滤」改成「排序」后，候选集永不为空 ⇒ **D 再也复现不了，也就永远不会被修**（bug 仍在，只是被掩盖，未来任何一次改回过滤语义就复发）。**因此 D 必须先修或同批修，不能指望 P1 顺带。**

### 7.2（已并入 P0）对比度

不修的话，P0 把描述变成一行反而更糟：唯一那行说明文字是全列表最不可读的元素。

### 7.3 ACP / Team 会话下列表来源是错的（**新增，独立轨**）

- `showCommandSelector` 不看后端类型，只看文本形状（`chat-input.tsx:272`）。
- `useApi()` 恒定返回 **OpenCode** 后端（`use-api.ts`: `getBackend<OpenCodeBackend>(OPENCODE_BACKEND_KIND)`）。
- ⇒ 单 Agent 选了 ACP agent、或 Team 模式（leader 是 ACP agent）时，菜单展示的仍是 **OpenCode 的技能列表**，而消息发给的是另一个后端。
- 更关键：ACP 协议本身有 `available_commands_update`，而我们**明确丢弃**了它 —— `packages/agent/acp-client/src/turn-shaper.ts:153` 该 case 直接 `break`，无处理。也就是说 ACP agent 主动上报的自有斜杠命令被扔在地上。

严重性：不致数据损坏，但属「界面承诺了后端不具备的能力」。修法有两档：① 最小 —— 非 OpenCode 会话直接不显示 `/` 菜单；② 完整 —— 消费 `available_commands_update`，按当前会话绑定的后端供给列表。**建议 P0 先做①（几行判断），②单独立项。**

### 7.4 纯截断后 4/9 首行几乎一样（**P0 的已知残留**）

按 445px 单行约可见 70 字符，实测截断后：

```
/wecom-assistant     Use when the user wants to operate WeCom (企业微信) — docs, smart sheets,
/feishu-assistant    Use when the user wants to operate Feishu/Lark (飞书) — send/read messag
/doc-edit            Use when the user wants to READ or MODIFY existing Microsoft Office fi
/dingtalk-assistant  Use when the user wants to operate DingTalk (钉钉) — AI tables, docs, ca
```

`Use when the user wants to ` 这 27 字符样板吃掉约 38% 的可见宽度。

**但不要在客户端做「智能」预处理**。实测「剥离样板 + 切到首个分句」的启发式会过度截断：

```
/wecom-assistant     operate WeCom (企业微信)          ← 丢掉了 docs/smart sheets/… 这些真正有用的枚举
/feishu-assistant    operate Feishu/Lark (飞书)
```

即：把可读性绑在一个随技能作者写法漂移的正则上，正是 ADR-070 那次的教训（**为一个未经真实语料验证的副作用不断加复杂度**）。**建议 P0 用纯截断**（可预测、零智力依赖），信息损失由 §八的「选中项详情」补偿；真正的解是给技能加一个 UI 面向的短描述字段，那是内容工作，见下。

---

## 八、P2 有没有必要做？——拆开看

| P2 子项 | 必要性 | 理由 |
|---|---|---|
| **选中项显示完整描述**（右侧/下方详情） | **高 —— 建议升到 P1** | 它不是装饰，是 P0 截断的**配套补偿**。没有它，§7.4 的信息损失无处可去，4/9 技能在列表里将无法区分。最便宜的版本：行上加 `title` 属性（原生 tooltip），零布局成本。 |
| **按 `source` 分组**（command / mcp / skill） | **已决定要做，见 §8.1** | 数据已就绪（`Command.source`，vendor 侧已打标）。当前顺序是 `Object.values()` 插入序（init/review → 配置命令 → MCP prompts → skills），本身不稳定。 |
| **面板宽度对齐输入框** | 低，且有副作用 | 现 `max-w-md`=448px，Home 输入框实测 ≈672px，多换约 1/3 的行。但 Session 页输入框是 `max-w-[860px]`，860px 宽的弹层会显得很空 ⇒ 得按 `variant` 分档。收益/复杂度比一般。 |
| **中文检索 / 别名** | 需求高，但**不属于修缺陷** | 实测 `/文档`、`/使用` 均 **0 命中**——中文能不能搜到纯属技能作者有没有随手在 frontmatter 里写中文（deckcraft 写了「做PPT/演示文稿」，其余基本没有）。中文 UI 下用户一定会敲中文。但认真做需要一个显式的 UI 侧 alias/keyword 数据源（Settings 页 `INSTALLABLE_SKILLS` 已在用 `descKey` 走 i18n 短描述，可作先例）。**这是新增能力，建议单独立项，不要混进这次。** |

**小结：P2 不是一个整体。** 「选中项详情」应该提级到 P1（它是 P0 的必要配套）；**「分组」已决定纳入本批，语义见 §8.1**；「宽度」可做可不做；「中文检索」必要性高但属新功能，单独立项。

---

## 8.1 分组：已定语义与两项新发现（2026-07-28 决策）

### 决策：空查询分组，有查询转扁平匹配度排序

| 状态 | 渲染 |
|---|---|
| **空查询**（刚敲下 `/`） | 按 `source` 分组：`command → mcp → skill`，跳过空组，带分组标题 |
| **有查询**（敲了任意字符） | **切成扁平列表**，按 name 前缀 > name 子串 > 描述子串排序；`source` 降级为行内图标/badge；描述匹配段前加分隔线 |

理由：保证 `selectedIndex = 0` 永远是最佳匹配，「敲两个字母直接回车」不会选错。若永远保持分组，skill 组里一个完美的 name 前缀匹配会排在 command 组里一个很弱的描述匹配**之下** —— 这正是 §六 P1 与分组的冲突点，本决策即其解。代价：列表形态在敲下第一个字符时变一次（可接受）。

### 新发现 A — 分组基础设施已存在，`command-selector` 是它的重复实现

`lib/use-skills.ts` 已有全部所需件：

- `GROUP_ORDER = ["command", "mcp", "skill"]`（`:36`）
- 按 source 分组 + **自动跳过空组**（`:140-150`）
- `HIDDEN_BUILTIN_COMMANDS`（`:39`）—— **`command-selector.tsx:8` 逐字复制了第二份**，是会漂移的重复
- `SKILL_GROUP_ICONS` / `SOURCE_BADGE_COLORS`（`Settings.tsx:1704-1715`），`SkillSource` 与 `Command.source` 同一套取值

⇒ 分组的实现成本远低于原估。

> ⚠️ **但不要把 `useSkills()` 整个塞进 `ChatInput`**：该 hook 在 mount 时无条件并发 3 个请求（`getCommands` + `getSkills` + `getConfig`，`:52-76`），而现在的选择器是**首次敲 `/` 才拉**。Home 页常驻挂载 ⇒ 会把成本加回启动路径（ADR-055 刚把启动 4.23s → 2.22s）。**正确做法：把合并/分组逻辑抽成纯函数供两处复用，保留选择器的懒加载。**

### 新发现 B — 默认安装下只有一个非空组

| 组 | 默认安装下 | 依据 |
|---|---|---|
| `command` | **空** | `init`/`review` 被 `HIDDEN_BUILTIN_COMMANDS` 隐藏；仓库不发任何默认 config command（根 `opencode.json` / `packages/client/desktop/opencode.json` 均无 `command` 段） |
| `mcp` | **空** | `/command` 的 mcp 分支取 `mcp.prompts()`；自带的 knowledge sidecar MCP 只注册 `server.tool(...)`（`mcp-bridge.ts:33,146,178`），无 `server.prompt(...)` |
| `skill` | 9 个内置 | 唯一非空 |

⇒ **今天分组的可见效果 = 9 条上面加一个「技能」标题**。这不推翻分组（装了带 prompts 的 MCP、或用户写了 config command 就有价值，且 `use-skills.ts` 已会跳过空组，今天自动退化为无标题），但意味着：

**今天真正让用户区分类型的是逐行图标，不是分组标题。** 现在所有行共用同一个 `Terminal` 图标（`command-selector.tsx:103`）；参考产品截图正是靠逐行不同图标区分类型、且没有分组标题。**因此「按 source 分组」与「逐行 source 图标」必须一起做**，后者是今天唯一有实际收益的一半。

---

## 8.2 实现期的三项发现（2026-07-28）

写完 §六方案后实测出来的，都不在原方案里。

### 发现 1 —「把子组件状态镜像给父组件」这条路本身是错的（返工）

原方案第 3 条（修 D）的实现是：`CommandSelector` 通过 `onMatchCountChange` 把候选数推给 `ChatInput`，后者据此判断菜单是否拥有 Enter。**新写的测试立刻抓到它是坏的**：用 Enter 选中一个命令时，`onSend` 也被调用了一次（选中即发送，用户来不及补参数）。

探针（对旧代码同样跑了一遍作对照，旧代码 `onSend` = 0，**确认是我引入的回归**）打出实况：

```
PROBE effect: visible=true ranked=1     ← 子组件已算出有 1 个候选
PROBE bubble: "/deck" active=false matches=0 show=true   ← 父组件读到的仍是 0
```

根因：这个镜像走的是 **render → effect → setState**，天生落后一帧。命令列表是异步 fetch 回来的（在 React 事件体系之外），`setCommandMatches(1)` 排上了队但还没提交，键盘事件就到了 ⇒ 父组件读到陈旧的 0 ⇒ 判定"菜单没开" ⇒ 走发送分支。**把镜像做快只是把竞态窗口缩小，不是消除。**

改法：**谁知道谁决定**。选择器的监听器挂在 `document` 的**捕获阶段**，它对自己消费的键调用 `stopPropagation()`，事件根本到不了 `ChatInput`（React 17+ 把监听器挂在 root container 上，捕获阶段 stop 就够了）。于是：

- 有候选 → 选择器消费 Enter，`ChatInput` 永不执行 ⇒ 不会误发
- 无候选 → 选择器**不碰**该事件，自然落到 `ChatInput` ⇒ D 由构造保证被修，而不是靠一个布尔量

`commandMatches` / `onMatchCountChange` 因此被整个删掉 —— 更简单**且**更正确。教训：**跨组件传"当前是否…"的布尔量来决定事件归属，等于把正确性押在渲染时序上。**

### 发现 2 — 新的空状态会在每次首开时闪一下

`ranked.length === 0` 既是"没匹配"也是"还没拉到列表"。加了空状态之后，每次首次敲 `/` 都会先闪一下「没有匹配的命令」再出现列表。已用 `open = visible && hasFetched` 区分开：列表到手前不渲染面板（等同旧行为），并且**这段时间也不接管键盘** —— 否则会把 Escape 从别的监听者手里吞掉。

### 发现 3 — 去掉 `opacity-70` 还不够，选中行仍差 0.1

去掉透明度后浅色未选中行是 4.63:1 ✅，但**选中行**的强调背景比面板背景略深，`--color-fg-muted` 在它上面只有 **4.40:1**，仍然不达标 —— 差得少到肉眼绝对看不出来。选中行的描述改用 `--color-accent-fg`（语义就是"强调背景上的前景"），层级改由字号/字重承担。

现已固化为机器门禁 `command-menu-contrast.test.ts`：**token 值从 `index.css` 解析**（不是抄的，改调色板会重跑而不是静默失效），覆盖浅/深 × 8 个前景/背景组合，并反向断言"旧的 opacity-70 方案会被这道门拦下"。

---

## 8.3 真浏览器走查（2026-07-28，11/11 PASS）

**动机**：jsdom 没有排版引擎，而本次修复的核心（高度上限、截断、滚动）**全部是排版**。单测只能断言 class，证明不了「真的截断了」「真的滚动了」。

`e2e/command-menu-ui-walkthrough.e2e.ts` 用真 opencode（从发布用的 `skills-builtin.zip` 解出 **9 个真实内置技能**，描述长度实测 604/572/495/428/319/315/248/227/163）+ 真 Chrome 实测：

| 实测项 | 结果 |
|---|---|
| 面板受控 | 9 行 → 高 **285px**，完整位于 900px 视口内（top=174，旧实现是越过卡片顶部） |
| 真的滚动 | 407px 内容装进 **256px** 上限容器 |
| 键盘可达 | ArrowDown ×8 后最后一行**完整滚入视野** |
| 截断生效 | 9/9 描述**恰好 1 行**（16.5px = 1×line-height），9/9 确实被裁切 |
| 对比度 | `getComputedStyle` 实测 5 组全部 ≥4.5:1，**含选中行**（16.12:1） |
| 单一高亮 | 恰好 1 行带选中底色（`rgb(244,244,245)` vs 透明） |
| bug D | `/zzzzz` + Enter **发送成功且未插入换行**（换行这半在 jsdom 无法证伪） |
| bug E | `/deck` + Escape → 文本仍是 `/deck`，菜单关闭 |
| 响应式 | 900px / 1680px 均无横向溢出，面板不越界 |
| 未捕获异常 | 0 |

**走查自身的两个坑（都已修，值得记）**：

1. **测试测错了对象**：第 4 步（对比度）跑在第 2 步 `ArrowDown ×8` 之后，选中行早已移到第 8 行 —— 于是标着 "selected" 的三组其实全是未选中态，**恰好把这次唯一修掉的 4.40:1 场景漏测了**。改为重新开菜单让选中态复位，并增加「选中底色必须与相邻行不同」的断言，防止再次静默测空。
2. **「零 console 错误」在单 sidecar fixture 上不可达**：本走查只起 opencode，ACP/gateway/knowledge 的探针必然失败。正确做法不是不断加 mute 规则，而是**把两种信号分开**：`pageerror`（未捕获异常）=硬门禁必须为 0；`console.error`（应用主动记的日志）=先用网络层证据（失败请求与 ≥400 响应必须全部落在未启动的 sidecar 端口内）分类，再报告。中途还暴露过 Vite 代理**串到本机在跑的 dev gateway** 拿到 401 —— 已把未用代理指向死端口，避免走查触碰你正在跑的实例。

### 实现期第四项发现 — 菜单重开时选中项不复位

走查里「选中行底色」查不到，追下去发现真因：**`/` 的 query 是空串，而菜单关闭时 query 也是空串**，所以 `useEffect(..., [query])` 的复位在「关闭→重开」这条路径上**从不触发**。表现：方向键走到第 8 行 → 关掉 → 再敲 `/`，菜单带着第 8 行的选中态重开，且列表已滚到底部。

旧实现同样有这个 bug，但旧实现没有滚动，所以看不出来；**加上滚动后它变得可见**。已改为 `[query, open]` 双键复位，并补 jsdom 回归。

---

## 8.4 真机验证（Tauri 原生窗口 / WKWebView，2026-07-28）

**「真浏览器」不等于「真机」**：§8.3 跑的是 Chromium，本节是 macOS 上运行中的 Tauri 应用（WKWebView），用 `osascript` 驱动 + `screencapture` 取证。

### 引擎一致性

| 指标 | Chromium（§8.3） | 真机 WKWebView |
|---|---|---|
| 面板高度 | 285px | ≈281px |
| 面板 top | 174 | ≈175 |

截图实证：面板受控且完整在窗口内、右侧出现滚动条、每行两行式且描述以 `…` 截断、首行选中态可见、逐行技能图标、标题「命令」。`/de` 时 `/deckcraft` 排第一，其下为「描述匹配」分隔线 + 描述命中项 —— P1 排序在真机成立。

### 🔴 真机独有发现 — 中文输入法组字期间，菜单会抢走 Enter 与方向键

真机截图里出现了 Chromium 走查**不可能出现**的东西：**中文输入法候选条**（的/得/地/德…）。用户敲 `/de` 时输入法正在**组字**，而 `command-selector` 对 composition **零防护**：

- `chat-input.tsx:318` 一直有 `!isComposing && !e.nativeEvent.isComposing` 防护（旁边注释还记着「某些浏览器 compositionEnd 早于 keyDown」）；
- `command-selector.tsx` 一个字都没有 —— 而重构后**正是它**在捕获阶段吃掉 Enter/方向键。

后果（中文优先的产品上，这是主路径）：
1. 组字中按 **Enter 上屏候选** → 被菜单截走，输入框里半截中文被替换成一条命令；
2. **方向键选候选** → 被菜单截走，输入法候选翻不动。

旧实现同样有这个缺陷（同样的 document 监听、同样没有 composing 判断），但重构加了 `stopPropagation` 后，`chat-input` 的防护再也没机会兜底 ⇒ **必须在选择器内修**。

**修法**：复用 `chat-input` 已有的组字状态（含 compositionEnd 提前触发的定时器绕过）作为 `composing` prop 传下来，而不是写第二份；再叠加原生 `e.isComposing` 与遗留 `keyCode === 229`：

```ts
if (composing || e.isComposing || e.keyCode === 229) return
```

**验证**：4 条 jsdom 回归（去掉该行则其中 **3 条失败**，第 4 条是防过度修正的对照）+ **真机复验**：组字态按 Enter 后输入框为 `/de`（输入法上屏字面值，macOS 拼音标准行为），**不是** `/deckcraft ` —— 菜单没有抢走这个回车。

> **教训（与 §8.3 的两个坑同源）**：`/` 菜单的键盘处理是**全局捕获**的，凡是全局接管键盘的组件都必须显式让出输入法组字期。这一条**只有中文输入法的真机能暴露**——Chromium 走查用 Playwright 直接 `fill()`，永远进不了组字态。

---

## 8.5 面板标题：从写死的「命令」改为「名副其实」（用户提出，2026-07-28）

**用户提问**：弹窗左上角写着「命令」，但里面全是技能，这符合预期吗？

**核实（在用户真实机器上，不是 fixture）**：

| 来源 | 该机器实际 |
|---|---|
| `command` | `~/.config/ultrawork/opencode.json` **无 command 段** ⇒ 0；内置 `init`/`review` 被 `HIDDEN_BUILTIN_COMMANDS` 有意隐藏 |
| `mcp` | 装了 3 个（browser / knowledge-base / orchestrator），但 `/command` 的 mcp 分支只读 **prompts**，这几个只注册 `server.tool()` ⇒ 0 |
| `skill` | 9 个内置 ⇒ **唯一非空** |

所以「列表里只有技能」是正确反映现实，**符合预期**；但由此暴露标题是错的：

- 旧实现写死 `t("command.title")`＝「命令」，我重构时为最小改动**原样留下**，没往下想一层；
- 而设置页那一整块叫**「技能」**（`skills.source.*`），我这次新加的分组标题里 skill 组也叫**「技能」**；
- ⇒ 同一批东西，弹窗顶上叫「命令」、设置页叫「技能」、弹窗内部分组标题也叫「技能」。**三处用词打架。**

**改法（名副其实，单一命名机制）**：面板标题只在内容**同源**时出现，并且用那一源的名字；异源时由分组标题命名（空查询）或不命名（带查询的混合排序结果）。

```ts
const soleSource = new Set(ranked.map(e => e.source)).size === 1 ? [...][0] : null
```

于是今天显示「技能」；装了带 prompts 的 MCP 后自动变成分组标题；`command.title` 这个 key 已删除（含 zh-hant 重新生成）。

**验证**：4 条新单测锁死「标题必须与实际内容一致」（全技能→技能 / 全命令→命令 / 混合→无标题 / 带查询混合→无标题）+ **真机确认显示「技能」**，且该次真机顺带覆盖了此前未验的 **reply 变体（会话页）**：面板同样受控、有滚动条、描述截断、首行选中。

---

## 8.6 二轮完备性复查（2026-07-28，标题/IME 改动之后）

标题与 IME 改动之后，**上一轮的 e2e 走查与生产构建都失效了**，全部重跑，另补两处：

### 补 1 — `source` 未做白名单校验（潜在 UI 泄漏）

`toMenuEntries` 原本 `(cmd.source as SkillSource) || "command"` 是**直接强转**。图标有 `?? Terminal` 兜底，但标题走的是 `t(\`command.group.\${source}\`)` —— 上游若给出预期外的 source，**原始 i18n key 会直接渲染到界面上**。已加 `normalizeSource()` 白名单（未知一律按 command），并补测试。

### 补 2 — 单 Agent / Team 判据从"读代码保证"升级为"测试保证"

此前 Q4 是本批**唯一**靠通读 JSX 得出的结论。已把判据抽成纯函数 `commandsAvailableFor(agentId)`，两个页面共用，并补 5 条矩阵测试：

| 场景 | 传入 | 期望 |
|---|---|---|
| 单 Agent + opencode | `opencode:default` | 显示 |
| 单 Agent + ACP | `acp:*` | 隐藏 |
| Team + opencode leader | `teamEntry.leaderAgentId` | 显示 |
| Team + ACP leader | `teamEntry.leaderAgentId` | 隐藏 |
| 尚未绑定 | `undefined` | 显示（回落 opencode 默认） |

Team 传的是 **leader** 而不是会话绑定：`bindLeaders` 只在注册表加载时写绑定，只读绑定会在 ACP 主导的 team 会话前几帧回落到 opencode 默认。

### 跨平台补充结论（IME 相关）

IME 防护用了**双信号**：标准 `e.isComposing` + 遗留 `e.keyCode === 229`。后者恰恰是 **Windows 输入法**最常见的信号（微软拼音），Linux 侧 fcitx/ibus 走标准 `isComposing`。也就是说这个修复不仅不是 mac 专属，**双信号写法本身就是为跨平台准备的**——但 Windows/Linux 真机仍未验（本机无从验），归入既有的跨平台真机欠账。

### 二轮验证结果

795 单测（+6）· typecheck 8/8 · check-docs 无漂移 · **e2e 走查 11/11 重跑 PASS** · 生产构建 exit 0 且四个关键工具类均在产物 CSS 中 · 真机（Home + reply 两个变体）通过。

---

## 8.7 真机复验（2026-07-29）+ 一条新发现的**既有**缺陷

`normalizeSource` / `commandsAvailableFor` 两处改动之后重新真机复验（用剪贴板粘贴绕开输入法，避免 IME 干扰断言）：

| 验证项 | 真机结果 |
|---|---|
| 面板标题 | **「技能」** ✓（不再是「命令」） |
| 面板受控 + 滚动条 + 两行式 `…` 截断 + 首行选中 + 逐行图标 | ✓ |
| `/ppt` | 「**描述匹配**」分隔线 + 3 条描述命中（doc-edit / deckcraft / markdown-exporter）✓ |
| `/文档` | 「**没有匹配的命令**」空状态，且**无标题**（结果为空 ⇒ 无同源可言）✓ |

> 顺带解掉一个存疑项：分隔线出现在**首位**（全部是描述命中时）观感正常，读起来像个小标题，不需要特殊处理。

### 🟡 新发现（**既有缺陷，非本批引入**）：中文输入法组字含空格 → 菜单中途消失

真机用中文输入法直接敲 `/ppt`，组字串被渲染成 **`/p p t`**（macOS 拼音按音节分段，**串里真的有空格**）。而触发条件里有一条：

```ts
value.startsWith("/") && !value.includes(" ")   // ← chat-input.tsx，本批未改动
```

`git show HEAD` 确认这行在本批之前就是这样，**不是回归**。后果：中文输入法下，只要拼音超过一个音节，`/` 菜单就会在组字过程中整个消失；上屏后（无空格）才重新出现。

**影响**：中文输入法用户实际上必须切到英文输入法才能用 `/` 菜单。对一个中文优先的产品，这是真问题。

**为什么没有顺手改**：这条规则的语义是「命令名打完了、开始打参数了」，而组字期的空格是**音节分隔符**，不是参数分隔符 —— 所以原则上应当在 `isComposing` 时豁免该规则。但豁免之后菜单会在整个组字过程中挂着「没有匹配的命令」（因为要拿 `p p t` 去匹配），**未必比直接消失更好**。两种行为都说得通，属于产品判断，**留给用户定夺，不由实现者单方面决定**。

修法（若决定要做）一行即可：

```ts
// 组字期的空格是音节分隔符，不是「参数开始」的信号
const argumentsStarted = !isComposing && value.includes(" ")
```

---

## 九、副作用与风险

| 变更 | 潜在副作用 | 缓解 |
|---|---|---|
| 加 `max-h` + `overflow-y-auto` | 键盘导航走出可视区（**必然发生**） | P0-3 的 scroll-into-view，同批做 |
| 加 `max-h` + `overflow-y-auto` | 圆角 + `shadow-lg` 与滚动容器冲突（内容溢出圆角） | 滚动容器内层加 padding，或外层 `overflow-hidden` + 内层滚动 |
| description `truncate` | 信息丢失；4/9 技能首行雷同（§7.4） | 配套「选中项详情」或 `title` tooltip |
| 过滤 → 排序（P1） | ① **掩盖 D 而非修复它**（§7.1）② 用户敲了 3 个字母仍看到 9 条，观感像"没过滤" | ① D 必须显式修 ② 加分隔线 + 「名称匹配 / 描述匹配」分组标题 |
| 按 source 分组（P2） | `filtered` 索引 ≠ 渲染索引，键盘导航跨组，易 off-by-one | 用扁平化后的有序数组做单一真相源，渲染时才切段 |
| 非 OpenCode 会话隐藏菜单（§7.3①） | ACP 用户彻底失去 `/` 入口 | 这是如实反映能力，优于给出无效项；完整解见 §7.3② |
| 去掉 `opacity-70` | 描述变"重"，与 name 的层级差变小 | 用色阶而非透明度拉层级（浅色可用 `#8a8a93` 一档，仍 ≥4.5:1） |

**不可回避的残留**：L6（模型侧描述 ≠ 人看的标签）在不改 SKILL.md 的前提下无法根治，P0 只是把它的表现控制在一行内。

---

## 十、通用性

| 维度 | 是否通用 |
|---|---|
| **跨平台（mac/Win/Linux）** | ✅ 完全通用。纯 CSS + React 状态，不碰路径/进程/外部命令，`docs/conventions.md §13` 的约束不适用 |
| **两个 variant（home / reply）** | ✅ 通用。同一个 `ChatInput`。注意 Session 页输入框在底部、上方空间更大，问题较轻但同样存在（且被 `Session.tsx:546` 的 `overflow-hidden` 裁切） |
| **命令来源（command / mcp / skill）** | ✅ 通用。三种来源共用同一列表与同一渲染路径 |
| **未来用户自装技能** | ✅ 自动受益。描述同样来自 frontmatter，走同一条链路 |
| **后端（OpenCode / ACP / Team）** | ❌ **不通用 —— 最大缺口**。P0/P1 只修 OpenCode 那条链路，ACP/Team 下「列表来源就是错的」依然存在（§7.3） |
| **主题（浅色 / 深色）** | ✅ 通用，但对比度必须两个主题都验（实测两个主题**都** FAIL） |

---

## 十一、验证方案

**机器可测**（目前 `__tests__/components/chat/` 下**没有** command-selector 的任何测试；`chat-input.test.tsx:24-27` 还把它整个 mock 成 `() => null`，等于零覆盖）：

1. 容器带 `max-h-*` + `overflow-y-auto`
2. 描述节点带 `truncate`，且不含 `opacity-70`
3. 排序：`/d` 时 name 命中排在 desc 命中之前
4. **回归 D**：`/zzzzz` + Enter → `onSend` 被调用 **或** 事件被 preventDefault（二选一，不能两个都不发生）
5. **回归 E**：`/deck` + Esc → 文本仍是 `/deck`
6. 方向键走到列表末尾时 `scrollIntoView` 被调用
7. 对比度：把 §2.3 的算例固化成断言（浅/深两主题 ≥4.5:1）

**像素/观感（交用户）**：`max-h` 具体取值（256px 是否合适）、两行行高、是否显示描述、分隔线样式 —— 这类改完真机看一眼更快更准。

---

## 十二、明确不做

- ❌ **改 SKILL.md frontmatter 的 description 去迁就 UI** —— 那是模型路由的输入，缩短会直接损伤技能命中率。
- ❌ **改 vendor/opencode 加 UI 专用字段** —— 展示层能解决的问题不值一个 vendor patch。
- ❌ **在客户端用正则"智能"改写描述** —— 实测会过度截断（§7.4），且把正确性绑在随作者写法漂移的启发式上。
- ❌ **虚拟滚动** —— 量级在几十条，`max-h` + 原生滚动足够。

---

## 十三、建议落地顺序

**本批（一次做完）= P0 + P1 + 分组**，范围：

1. `max-h-64 overflow-y-auto scrollbar-soft` + 两行式 `truncate` 行 + `min-h-[2.75rem]`
2. scroll-into-view（把闲置的 `listRef` 用起来）
3. **修 D**（发送判据改成「菜单有候选」）—— **必须先修并带回归断言**，否则被第 8 条掩盖
4. **修 E**（Esc 只关菜单，不删字符）
5. 去 `opacity-70`，浅/深两主题描述文字均 ≥4.5:1
6. hover 与键盘选中态可区分 + `onMouseEnter` 同步 `selectedIndex`
7. 非 OpenCode 会话不显示 `/` 菜单（§7.3① 最小 gating）
8. 空查询分组 / 有查询扁平匹配度排序（§8.1）+ 分隔线 + 无匹配空状态
9. **逐行 source 图标**（复用 `SKILL_GROUP_ICONS`）—— 今天唯一有实际收益的一半
10. 选中项完整描述（先做 `title` tooltip 这个零成本版本）
11. 消除 `HIDDEN_BUILTIN_COMMANDS` 重复：抽纯函数复用，**保留懒加载**（§8.1 新发现 A 的警告）
12. 补测试 —— 该组件目前**零覆盖**（`chat-input.test.tsx:24-27` 把它整个 mock 成 `() => null`）

**留到后面**：

- **ACP `available_commands_update` 消费（§7.3②）** —— 独立立项，跨 `acp-client` + `connector`
- **中文别名 / 关键词检索** —— 独立立项，先定数据源（新字段 or 前端映射表）
- **面板宽度按 variant 分档** —— 可做可不做
