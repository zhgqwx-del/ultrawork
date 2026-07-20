# 047 — 「设置-关于」第三方开源软件声明 + 商用合规基线

> 状态：**🟢 Phase 1+2 已实现（生成器 + 关于页三入口 + 法律草稿）· 真机视觉验收与 follow-up 待办** · 2026-07-20
> 范围：为「打包编译后可商业售卖」，在设置-关于页新增第三方开源软件声明，并评估其是否充分、还需补什么。
> 依据：许可证与捆绑组件盘点为**实测**（扫过 npm 626 包 / cargo 560 crate / externalBin 二进制 / vendored 资源），非凭印象。
> 参考形态：某桌面云产品的「关于」页 —— 底部一排入口（官网 / 问题反馈 / 第三方开源软件 / 用户服务协议 / 隐私政策）→ 点「第三方开源软件」进独立整页表格（序号 / 名称+版本 / 许可协议 / 是否修改 / 网址）。

---

## 一、缘起

用户问三件事：
1. 项目用了 opencode 等开源软件，想在「设置-关于」加类似截图的第三方开源软件声明。
2. 为后续**商业售卖**，仅在关于页加声明是否 OK、是否足够，还要做什么。
3. 若足够，是弹窗还是翻页？UI/UE 方案，且尽量把该声明的都声明了。

先给结论：**方向对、法律基础干净、可行；但"只在关于页放一张手写表格"必要但不充分**。需配套自动生成的完整 NOTICES + 保留许可证全文 + 标注修改 + EULA/隐私政策。

---

## 二、现状盘点（实测）

### 2.1 当前关于页（`packages/client/desktop/src/pages/Settings.tsx` `AboutSection`）
- 有：Logo/品牌、版本(`APP_VERSION`)、构建、作者、版权、License(占位 "UltraWork Community License")、opencode 端口行、一排 quick-links（官网/源码/社区/Twitter/反馈）。
- **无**：第三方开源软件声明入口；无用户服务协议 / 隐私政策入口。
- License 行 `about.licenseValue = "UltraWork Community License"` 是**占位**，非真商用协议。

### 2.2 许可证分布（可否商用的地基）

| 层 | 数量 | 分布 | 商用判断 |
|---|---|---|---|
| **npm 依赖树**（扫 `node_modules/.bun` store） | 626 唯一包 | 540 MIT / 22 Apache-2.0 / 18 ISC / 15 BSD-3 / 7 BSD-2 / 6 MPL-2.0 / 5 (MIT OR Apache) / 其余零星 | ✅ **无** GPL/AGPL/SSPL/BUSL/Commons-Clause 等阻断项 |
| **Rust crates**（`Cargo.lock`） | 560 crate | Tauri 生态：MIT/Apache/BSD/MPL/Unicode/Zlib/ISC | ✅ 无阻断 |
| **捆绑二进制**（`tauri.conf.json` externalBin，进安装包再分发） | 4 | opencode-server / channel-gateway / knowledge-sidecar / acp-client | ⚠️ 见 §三缺口 |
| **捆绑资源**（resources/builtin-skills） | builtin-skills 10 个 | 内含 vendored **pptxgenjs**(MIT) 等 | ⚠️ 见 §三缺口 |
| **运行时下载**（不进安装包） | Node.js(MIT)、Chrome(用户自备/系统)、python(系统) | — | ✅ 再分发义务轻 |
| **WebView** | Win=WebView2(MS 可再分发 EULA) / Linux=WebKitGTK(LGPL 动态链接) / mac=系统 WKWebView | — | ✅ 均合规 |

**非阻断但需处理的**：
- `jszip`（MIT OR GPL-3.0-or-later）→ 选 MIT 即可。
- `caniuse-lite`（CC-BY-4.0，browserslist 构建期数据）→ 需署名，易满足。
- `lightningcss` / `@resvg/resvg-js`（MPL-2.0）→ **原样使用**只需保留声明并提供源码获取途径；未改 MPL 文件即无额外义务。

### 2.3 需要「是否修改=是」的组件
- **opencode**（MIT）：本仓通过 `patches/vendor-opencode-config-fix.patch` 改过源码 → 清单「是否修改」必须填**是**，且 MIT 要求保留版权+许可全文。

---

## 三、最大缺口（"是否足够"的核心）

1. **捆绑二进制内部的传递依赖未被声明**：`opencode-server` 是 bun 编译单文件，内部嵌入**几百个 npm 包**（各家 AI SDK 等），而 `vendor/opencode/` **无 NOTICE/THIRD-PARTY 文件**。把该二进制装进安装包再分发 → 这一整层的 MIT/BSD/Apache 署名义务落到本产品头上。**手写表格必漏此层。**
2. **vendored pptxgenjs 许可头被剥离**：`skills/builtin/deckcraft/scripts/html2pptx/vendor/pptxgen.vendor.cjs` 开头无版权声明（esbuild 打包剥了注释）——MIT 要求保留版权，现成义务瑕疵。
3. **署名义务是"保留许可证全文 + 版权声明"**：截图那种"名字 + MIT 链接"是**清单**；严格讲还需能拿到**全文**（折叠展开或附 `NOTICES.txt`）。

---

## 四、关于页声明是否 OK / 是否足够

**OK，是正确且必须的第一步；单靠它不够。** 商用需要凑齐一整套，关于页只是展示层：

| 要素 | 现状 | 商用必须 |
|---|---|---|
| 第三方开源软件清单（截图那张表） | ❌ 无入口 | ✅ |
| 许可证**全文**留存（不只列名字） | ❌ | ✅（MIT/BSD/Apache 硬要求） |
| 捆绑二进制**内嵌依赖**纳入清单 | ❌ 完全缺失 | ✅（最大风险） |
| 标注**已修改**组件（opencode） | ❌ | ✅ |
| 产品自身 **EULA / 用户服务协议** | ⚠️ 占位非真协议 | ✅ |
| **隐私政策**（AI agent 会传数据） | ❌ | ✅ |
| 商标/品牌不侵权、默认模型/搜索服务 ToS 合规 | — | ⚠️ 需法务过一遍 |

一句话：**关于页 →「第三方开源软件声明」解决署名义务的展示；商用还要补 EULA + 隐私政策 + 一份自动生成且完整的 NOTICES。**

---

## 五、UI/UE 方案（含"弹窗 vs 翻页"）

照抄参考产品骨架：**关于页底部一排入口** → 点「第三方开源软件」进**独立整页**表格。

**结论：独立子页（翻页），不用小弹窗。** 理由：
- 内容长（叠加内嵌依赖会有几百上千条），需滚动 + 搜索 + 复制 + 行内展开全文，小 Dialog 装不下也不好用。
- Settings 已是"左导航 + 右内容"结构，加一个二级视图最自然，且与截图一致。
- 表格列对齐截图：**序号 / 名称+版本 / 许可类型 / 是否修改 / 链接** + 行内展开「许可证全文」。
- 数据来源必须**构建期自动生成 JSON**（随包内置，运行时读取渲染），杜绝手写漂移，接上项目已有 `check-docs.ts` 漂移门禁文化。
- 全离线；i18n（协议类型名不译，说明文字走 `about.*`/`oss.*`）。

---

## 六、决策（已拍板）

1. **展示形态** = 独立子页 / 整页表格。
2. **完整度** = 清单表 **+ 完整 NOTICES 全文**（商用达标，覆盖内嵌依赖）。
3. **范围** = 一并补齐**第三方开源软件 / 用户服务协议 / 隐私政策**三个入口。

---

## 七、落地计划（分阶段）

### Phase 0 — 合规基线
- 商用无 copyleft 阻断（§2.2 已实测 ✅）。
- 准备真正的 EULA / 用户服务协议 / 隐私政策**文案**（法务向，非工程；工程侧先接占位）。
- **已起草**（2026-07-20）：`docs/legal/user-service-agreement.md`（EULA/用户服务协议）+ `docs/legal/privacy-policy.md`（隐私政策）+ `docs/legal/README.md`（占位符替换清单 + 免责/法务提示）。以某同类桌面云产品公开协议为**结构参考**，实质条款按本产品真实形态（本地优先 + BYOK 直连、无第一方数据收集后端——经代码实证：无友盟/sentry 埋点、无自建收集后端）重写，避免照抄云服务条款造成虚假陈述。**主体状态=尚未注册公司**，法律事实统一留占位符（【产品名】【公司主体】【管辖法院】等），商用前须注册真实主体 + 法务定稿。

### Phase 1 — NOTICES 自动生成（工程核心，先做）
1. 新增 `scripts/gen-notices.ts`（`bun run --bun`），聚合四类来源：
   - **npm 树**：遍历 `node_modules/.bun` store（已验证可扫），取 name/version/license/repository + 读每包 `LICENSE` 全文。
   - **cargo 树**：`Cargo.lock` 560 crate → 引入 `cargo-license`/`cargo-about` 生成清单 + 全文。
   - **捆绑二进制内嵌依赖**（最大缺口）：build sidecar 时对其源树跑同款 npm 扫描，为 opencode-server 等各自生成 third-party notice 并汇入。
   - **vendored 资源**：补 `pptxgen.vendor.cjs` MIT 版权头，pptxgenjs 纳入清单。
2. 产出 `licenses.json`（结构化，供 UI）+ `NOTICES.txt`（纯文本全文，供打包/审计），随包内置。
3. **标注修改**：opencode `modified=true`，其余 `false`。
4. 纳入 `check-docs.ts` 漂移校验（依赖变更后必须重生成）。

### Phase 2 — UI
1. 关于页把 quick-links 收敛/新增为三个**合规入口**：第三方开源软件、用户服务协议、隐私政策（+ 保留官网/反馈）。
2. 新增 Settings 二级视图（如 `about/oss-licenses`）：搜索框 + 计数；表格列 序号/名称+版本/许可类型/是否修改/链接；行内展开许可证全文（读 `licenses.json`）；全离线 + i18n。
3. 用户服务协议 / 隐私政策：接入**占位文案**，入口与视图先就位。

### Phase 3 — 收尾
- 新建 ADR（第三方声明与商用合规基线）；更新 CHANGELOG、AGENTS.md Key Files、check-docs；真机验收（表格渲染 / 搜索 / 全文展开 / 三入口）。

---

## 十、实现记录（2026-07-20，Phase 1+2 已落地）

**新增/改动文件**：
- `scripts/gen-notices.ts`（生成器）+ root `package.json` `gen:notices` 脚本。
- 产物 `packages/client/desktop/src/generated/{licenses,license-texts,legal}.json` + 根 `NOTICES.txt`（提交快照）。
- `packages/client/desktop/src/components/settings/about-legal.tsx`（`OssLicensesView` / `LegalDocView` / `LegalEntryButton`）。
- `packages/client/desktop/src/pages/Settings.tsx` `AboutSection` 加 sub-view 状态 + 「法律与合规」三入口。
- i18n `about.legal.*` / `about.oss.*` / `about.back`（en + zh-Hans，zh-Hant 已重生成）。
- 单测 `src/__tests__/components/settings/about-legal.test.tsx`（+5）。

**覆盖**：3751 组件 = npm 626（含全文）+ opencode 内嵌 2564（解析 `vendor/opencode/bun.lock`）+ cargo 559（SPDX）+ 捆绑 2（opencode 已修改 / pptxgenjs）。

**验证**：typecheck 0 · desktop 683→**688** · 真实 `vite build` 确认 `licenses`/`legal` 各自独立异步 chunk（不进启动包）· check-docs 绿。

**关键决策/坑**：
- 元数据与许可全文**分文件**、UI **dynamic import**——2.6MB 全文与 620KB 清单不落启动包（vite build 实证）。
- bun.lock 是 JSONC（尾逗号），**不能用 `//` 注释剥离**（会误伤字符串里的 `https://` → parse 失败），只去尾逗号。
- 协议草稿含 `【】` 占位符时视图**自动显「草稿未生效」提示条**（`md.includes("【")`），占位符填完自动消失。

**Follow-up（未静默，见 CHANGELOG）**：
1. opencode 内嵌 2564 多为仅 SPDX+链接（无本地全文）→ 需 build-opencode 时 populate node_modules 或读 registry 补全文。
2. 生成产物暂为提交快照 → 接入 `beforeBuildCommand` + check-docs 漂移门禁（类比 gen-zh-hant），杜绝依赖 bump 后清单陈旧。
3. EULA/隐私政策正文与占位符替换、真实注册主体、法务定稿（Phase 0 未竟）。
4. 真机视觉走查（表格滚动/搜索/展开全文/三入口/协议渲染）——e2e 结构上难覆盖，留人工。

---

## 八、待用户/法务提供
1. **EULA + 用户服务协议 + 隐私政策正文文案**（工程侧只能接占位）。
2. 确认 **opencode 内嵌依赖 notice** 采用"build sidecar 时多跑一次扫描"生成（略增构建时间，是覆盖最大缺口的唯一正解）。

---

## 九、关联
- 参考形态：某桌面云产品关于页（截图）。
- 相关：`patches/vendor-opencode-config-fix.patch`（opencode 修改来源，决定「是否修改=是」）、ADR-041（内置技能 zip 分发）、ADR-062/discussions/045（应用内 HTML 预览，deckcraft/pptxgenjs 上下文）、`docs/vendor-patch-workflow.md`。
- 后续：实施时新建 ADR，收尾按 CLAUDE.md 流程更新 CHANGELOG / AGENTS.md / check-docs。
