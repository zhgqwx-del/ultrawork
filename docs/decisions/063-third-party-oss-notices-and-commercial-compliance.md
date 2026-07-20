# ADR-063: 「设置-关于」第三方开源软件声明 + 商用合规入口

- 状态：Accepted（✅ 已实现 + macOS 真机验收通过，2026-07-20）
- 日期：2026-07-20
- 关联：discussions/047（完整盘点、许可证实测、UI 决策、法律草稿）、docs/legal/（EULA + 隐私政策草稿）、ADR-041（内置技能 zip 分发）、ADR-037（跨平台）

## 背景

为后续把打包产物**商业售卖**，需要在「设置-关于」补齐两类合规内容：① 第三方开源软件署名声明（履行 MIT/BSD/Apache 等的 attribution 义务）；② 产品自身的用户服务协议(EULA) + 隐私政策入口。此前关于页只有版本/版权/若干社交链接，无任何第三方声明入口，`about.licenseValue` 是占位。

**许可证实测盘点**（可否商用的地基）：npm 依赖树 626 唯一包（540 MIT，全树无 GPL/AGPL/SSPL/BUSL 阻断项）+ cargo 560 crate（Tauri 生态全 permissive）+ 4 个 externalBin 二进制 + vendored 资源 → **商用地基干净**。最大缺口=`opencode-server` 是 bun 编译单文件，**内嵌数百 npm 包**且 `vendor/opencode` 无 NOTICE，手写表格必漏此层。

## 决策

### D1 — 构建期自动生成 NOTICES（`scripts/gen-notices.ts`）
聚合四类来源产出，**杜绝手写漂移**：
- npm 依赖树（遍历 `node_modules/.bun` store）：name/version/SPDX + 读取每包 LICENSE 全文（626）。
- **opencode 内嵌树**（解析 `vendor/opencode/bun.lock`）：闭合「捆绑二进制内嵌依赖未声明」最大缺口（2564，root store 重叠者复用许可全文，其余仅 SPDX+npm 链接）。
- Rust crates（`cargo metadata`）：SPDX + repo 链接（559）。
- 捆绑/vendored：opencode 本身**标注「已修改」**（经 `patches/vendor-opencode-config-fix.patch`）、vendored pptxgenjs 补回被 esbuild 剥掉的 MIT 版权头（2）。

产物：`packages/client/desktop/src/generated/{licenses,license-texts,legal}.json` + 根 `NOTICES.txt`（合规全量，随包分发）。

### D2 — 元数据 / 许可全文分文件 + UI dynamic import（保住启动性能）
`licenses.json`（620KB 元数据）与 `license-texts.json`（2.6MB 全文）分离，UI 均 `import()` 按需加载 → vite build 实证二者各为**独立异步 chunk、不进启动包**（守 ADR-055 启动不变量）。

### D3 — 关于页新增合规入口 → 独立整页子视图
底部**一行** 5 项（官网 / 问题反馈 / 第三方开源软件 / 用户服务协议 / 隐私政策，对齐参考产品；移除低价值「查看源码/加入社区/关注我们」）。点后三者进 `about-legal.tsx` 独立整页：
- **开源声明视图**：表格（序号/名称+版本/许可协议/是否修改/网址）+ **来源筛选 chips**（全部/npm/opencode内嵌/cargo/捆绑 + 计数）+ 搜索 + **经典翻页**（每页 50，DOM/页高恒定）+ 行内展开许可全文（懒加载）。
- **协议视图**：渲染 `docs/legal/` 草稿（复用 `MarkdownContent`），含 `【】` 占位符时**自动显「草稿未生效」提示条**（`md.includes("【")`，占位符填完自动消失）。

### D4 — 法律草稿：结构参考、实质重写（不逐字替换品牌）
`docs/legal/` 起草 EULA + 隐私政策：以同类桌面云产品公开协议为**结构骨架**，但按本产品真实形态（**本地优先 + BYOK 直连第三方、经代码实证无第一方遥测/收集后端**）**重写实质条款**——照抄云服务条款（云账号/第三方支付/埋点 SDK/收集上传数据）会构成**虚假陈述**。法律事实统一留占位符（【产品名】【公司主体】【管辖法院】等），商用前须注册真实主体 + 法务定稿。

## 后果

- 纯 renderer + 构建期脚本 + 生成数据（平台无关 JSON），**无 Rust/vendor 改动、无硬编码本机路径、三平台一致、mode 无关**（关于页全局，单/Team 共用）。
- **合规原则**：`NOTICES.txt` 始终全量（分发物义务，含 opencode 内嵌层——其代码物理打进二进制、随分发须保留署名，不能因「声明了 opencode」省掉）；UI 靠筛选/翻页精简观感，不砍分发物。
- **验证**：typecheck 0 · desktop 690（+7 单测）· 真 Chrome+Vite+Playwright 走查 10/10（清单/筛选/翻页/懒加载全文/协议/草稿横幅/响应式 640-1680/0 console 错误）· 真实 vite build 拆包 · check-docs 绿 · macOS 真机验收通过。

## 被否 / 待办

- **否决**「声明了 opencode 就不声明其内嵌依赖」：法律上不成立（见 D1/后果）。
- **否决**从 NOTICES 里筛掉某些协议（如 Apache-2.0/BSD）：它们是宽松商用友好协议，隐藏反而违反 attribution 义务。
- **Follow-up**：opencode 内嵌 2564 多为仅 SPDX+链接（补全文需 build-opencode 时 populate node_modules）；生成产物暂为提交快照，应接入 `beforeBuildCommand` + check-docs 漂移门禁（类比 gen-zh-hant）；EULA/隐私政策正文法务定稿 + 占位符替换 + 真实注册主体；`gen-notices.ts` 的 ROOT 取自 `import.meta.url.pathname`，Windows CI 重跑需修（构建工具层面，不影响交付物）。
