# ADR-075：独立品牌发行版 — 构建期身份、运行时上下文与命名空间隔离

**状态**: Accepted（实现已落地；各平台安装与签名验收边界见 [testing §16](../testing.md#16-独立品牌发行版的验证adr-075)）

**日期**: 2026-10-29

**关联**: [discussions/062](../discussions/062-independent-brand-releases.md)、ADR-020（配置隔离）、ADR-028（凭证与 sidecar 副本）、ADR-037（三平台）、ADR-041（技能打包）、ADR-045（动态端口）、ADR-069（macOS 签名）

## 背景

项目需要从同一份源码编译出名称和图标不同的安装包，默认继续发行 Ultrawork，首个品牌为 MyWork，使用美柚图标。最初设想只调整展示名称和图标并沿用 Ultrawork 数据目录；讨论后接受每个品牌拥有独立安装身份和用户数据。

只覆盖 Tauri 的 `productName` 无法完成独立发行：bundle identifier、主程序名、Windows 升级身份、Linux 包名、OpenCode 的应用命名空间，以及 Gateway/Knowledge/ACP/技能和孙进程的数据路径仍可能指向 Ultrawork。多个品牌还会共享源码目录中的 sidecar 和部分构建输入，因此必须同时处理运行时与构建时隔离。

## 决策

### 1. 默认兼容，自定义品牌在构建时确定

不传品牌参数时保留默认身份：`Ultrawork`、`com.ultrawork.desktop`、namespace `ultrawork`，保留既有主程序命名与数据位置。构建入口清理上一次生成的品牌环境，不能依靠残留环境自动选择品牌；默认入口不加载自定义预置/账本，损坏的自定义状态不应阻断默认构建。

品牌配置只接受 `schemaVersion: 1`、稳定的 `brandId`、`productName`、`icon`，以及可选 `uiLogo`、`trayIcon`。入口支持配置文件和临时 CLI 参数，命令及优先级以 [build-and-deploy §0.6](../build-and-deploy.md#06-独立品牌发行版adr-075) 为准；无效配置直接失败，不能回退默认品牌。

`@agent/brand` 的纯入口统一身份契约与派生规则，构建工具、renderer 和 Node/Bun 运行时共用。自定义 `brandId` 为 2–32 位非保留的小写 ASCII 标识，以字母开头、连字符分段；namespace 和主程序名均由它派生，identifier 为 `com.ultrawork.<brandId>`。不开放任意 identifier、namespace 或数据目录覆盖。

当前发行构建要求 `productName` 使用 ASCII，并能派生合法 Linux 包名；拒绝 macOS DMG 模板会插值的 `$` / `@`，UI 国际化与中文正文不受影响。首个预置固定为 `mywork` / `MyWork`，素材在仓库内固定，构建不从官网即时抓取图标。素材来源说明保留在预置目录。

### 2. 安装身份稳定，不能把改名当作普通版本升级

自定义品牌具有自己的 Tauri productName/identifier/mainBinaryName、应用图标、窗口标题、托盘图标与产品文案。Linux 包名从 productName 规范化派生；Windows WiX upgradeCode 按安装身份确定性派生，各品牌分属不同升级家族。

预置的 `identity.json`、当前 checkout 的 `.brand-build/identity-ledger.json` 与已导出 manifest 共同检查身份冲突。首次准备临时品牌时写入本地账本，后续同 brandId 不得改变 productName、安装标识或包名；不同品牌也不能碰撞正式/Dev 名称、规范化包名、安装二进制文件集合或 macOS single-instance 插件实际派生的 socket 键。后者将点和连接符统一为下划线，不能只比较 identifier 原文。图标可更新。账本是本地保护，正式品牌还须把身份快照纳入版本控制，不能把删除账本当作改名流程。

版本号仍与项目共同维护。此次不提供品牌重命名、旧数据迁移、跨品牌账户共享或独立自动更新渠道。

### 3. 每个品牌独立拥有数据命名空间

运行时以用户 home 和绝对 XDG 根派生 `appRoot/configRoot/dataRoot/cacheRoot/stateRoot`，自定义 namespace 为 brandId，默认仍为 `ultrawork`。完整目录表见 [构建指南](../build-and-deploy.md#06-独立品牌发行版adr-075)。三平台保留项目现有 home/XDG 目录约定，不另切换为平台原生目录规则。

Rust 宿主在启动业务前校验编译身份与实际 Tauri identifier、数据身份标记及目录冲突，并取得 appRoot 的 OS 文件租约。正式版与 `.dev` 包共用同一品牌的数据和租约，不能同时运行；不同品牌各持有自己的租约。进程退出或崩溃由 OS 释放租约。Rust 最低版本提升到 1.89，以使用标准库文件锁。

自定义品牌不接管没有可信身份标记的非空目录，不读取或自动复制 Ultrawork 配置/凭证/历史。标记冲突、路径别名冲突或租约失败进入 Blocked 启动状态。Blocked 页面不挂载业务 providers，不读取端口/凭证，不初始化 workspace、技能、渠道或数据库；相关写命令也由宿主 ready 状态守卫。

ready 守卫在集中 IPC 入口执行，不能仅依赖 renderer 不挂载业务组件。进程清理以 OS 身份或宿主实际持有的子进程句柄为依据；事件流关闭不能替代终止证明，未确认结束时保留归属记录。Unix 正常关闭先给子进程 flush 机会，再以精确句柄兜底回收；Windows 进程查询须显式使用 UTF-8，macOS 内部 `ps` 查询固定 UTF-8 locale，不能因客户路径含中文或 GUI 环境缺省编码就丢失身份。具体负例与平台执行边界以 [testing §16](../testing.md#16-独立品牌发行版的验证adr-075) 为准。

### 4. 宿主发布上下文，sidecar 和孙进程必须显式继承

宿主在 `<appRoot>/run/brand-context.json` 发布 schemaVersion 1 的 RuntimeContext，包含纯 identity、instanceId、actualIdentifier、ownerPid 和全部绝对路径。通过 `ULTRAWORK_BRAND_CONTEXT` JSON、`ULTRAWORK_BRAND_CONTEXT_FILE` 路径向子进程传播；Gateway/Knowledge/ACP 及受管 MCP 额外带 `--brand-context <file>`。OpenCode 使用既有 `OPENCODE_APP_NAME=<namespace>`，无需改 vendor 协议。

`@agent/brand/node` 统一解析与路径适配。受管进程遇到缺失/损坏/冲突上下文或缺失路由时失败，不能回落默认目录、4099 或默认凭证。无上下文的 standalone 模式继续兼容既有默认行为。端口注册表附带品牌和 instanceId，delegate shim 在每次工具调用时校验并解析当前端口，不能在 stdio 预热/握手时固定尚未就绪的动态路由；ACP 明确注入的自身端口仍优先。

外部 agent 的用户环境、持久化 MCP environment 不能覆盖宿主品牌上下文、受管路径、路由和凭证。仅归一系统管理的 Knowledge/delegate MCP 条目；保留其余用户 MCP 配置。Python 技能安装器和内置 Node 探测读取同一上下文；品牌技能包从 staging 物化，不能改写源码树或默认技能包。

宿主必须读取 OpenCode PATCH 实际写出的 JSONC（注释、尾逗号、BOM），再归一受管 MCP 命令和 environment；解析不能误改字符串，也不能自动修复无效 JSON。已有配置发生 I/O/解析错误时在业务初始化前阻断，不得当空配置覆盖。受管旧端口与品牌 environment 在每次启动时清除，其他用户配置保留；重启后的 MCP 连通须以真实宿主验收验证。

### 5. 构建资源分离，checkout 内构建串行

公开入口为 setup、tauri:dev、tauri:build、release。自定义品牌在 `.brand-build/<brandId>/` 下生成图标、Tauri overlay、身份文件、技能 staging 和独立 Cargo target；默认不重写受版本控制的 tauri.conf、icons 或默认主程序名。

同一 checkout 的这些入口持有 SQLite OS 构建锁，涵盖完整 dev/build 生命周期；内部受管嵌套调用共享租约。并行品牌构建使用不同 checkout，避免共享 sidecar、Vite 与默认输出互相覆盖。构建租约只用于构建链，不属于业务进程上下文。

四个 sidecar 保持固定逻辑角色；Linux 的自定义发行包将安装文件名加 namespace 前缀（如 `mywork-opencode-server`），避免共享 `/usr/bin` 文件被两个 deb/rpm 占用。默认 Linux 及 macOS/Windows 保留内部原名。构建锁内物化 externalBin staging，宿主按平台/品牌解析相同名称；Linux 打包后再从真实 deb/rpm 读取安装清单，检查主程序、sidecar、资源路径及默认品牌冲突，并写入 manifest。不能只检查生成的配置就宣称包内无冲突。

默认和定制公共入口在打包前都检查目标 triple、上下文协议、二进制 SHA-256 和当前源码/依赖指纹。`--skip-sidecar` 只跳过编译，不能跳过兼容与新鲜度检查；校验复用各 builder 的 `--check`，不维护另一套 hash 规则。Universal 的来源由两架构已验证的 sourceHash 和二进制 SHA 派生，与品牌无关。品牌技能 source 通过临时树、原子发布及 source 外完成标记保证中断后不复用半成品。OpenCode vendor build 的版本探针使用独立应用 home/XDG，避免构建副作用影响用户运行数据。只导出本次成功构建、属于当前品牌的安装包，并生成带身份、实际签名模式、大小与校验和的 manifest。release 运行时必须从安装包解析 sidecar；源码 checkout fallback 仅供 debug，不能掩盖客户包缺文件。构建机器的素材/staging 绝对路径不作为客户运行配置。

### 6. 签名沿用平台流程，每个品牌单独验证

名称和图标在签名前生成，不做已签安装包的事后替换。macOS 正式发行沿用 Developer ID 签名、公证和 stapling；同一开发者证书可以签多个 bundle identifier，权限仍需按实际品牌验收。`release --unsigned` 使用 `<identifier>.dev` 与 `<productName> Dev`，隔离正式应用的 TCC/WebView 身份，但不另建品牌数据 namespace；Tauri 以 `signingIdentity="-"` 在封装前 ad-hoc 签名，封装后仅校验，保证容器内外使用同一签名副本。

Windows 签名与 Linux 仓库/包分发签名维持现有流程边界；本次没有新增证书签发或签名服务。CI `v*` tag 按同一版本同时构建默认 Ultrawork 与 MyWork 的三平台安装包，六个构建任务全部成功后才发布到同一个 GitHub Release。品牌/平台 artifact 与 manifest 独立收集，发布前逐项校验 manifest 列出的文件大小和 SHA-256，并拒绝同名安装包；不能用宽泛 glob 混入旧产物。

正式 tag 的两个 macOS 品牌均须通过 Developer ID、公证与 staple 验证，不能以 `ALLOW_UNSIGNED_RELEASE` 降级为 ad-hoc 正式发布。workflow_dispatch 可选择 `all`、`default` 或 `mywork`，仅上传验证 artifact；显式 unsigned 验包仍使用独立 `.dev` 身份。实现配置、本机单测、发布构建与三平台原生安装/升级/卸载是不同验收层次，状态分别记录。

### 7. 模型身份与模型可读内容跟随品牌（2026-10-30 补齐）

产品自称使用上下文中的 `identity.productName`，默认 `Ultrawork`。OpenCode 内置插件在每次 `system.transform` 追加身份，保留模型基座与 Team 角色；身份不随 `rich_output` 格式开关关闭。vendor 使用无工作区依赖的身份适配器，并用跨适配器契约测试保持校验一致；上下文缺失、损坏或冲突必须在实际 transform 阶段阻止请求，上游会吞掉插件初始化错误，不能只在初始化时报错。

ACP 在 manager 统一组合原有角色与宿主身份，追加到支持 `_meta.systemPrompt.append` 的 adapter；其它 adapter 通过既有 wire prefix 发送，用户回显不变。外部 Agent 保留自身身份、能力和工具指令。持久化可选身份送达标记，兼容旧会话，恢复失败重建时重新发送；`metaSystemPrompt` 显式布尔覆盖经 REST/文件往返保留，普通编辑省略字段时保留原设置。

技能宿主能力说明使用中性文案；钉钉路由文档的具体安装路径在品牌 staging 中定向改写。DOCX 产物元信息及默认修订/批注作者读取已有上下文，显式作者优先，原文档创建者与版权/来源保留。Python 仅消费身份，不据此计算路径，env/file 不一致采用严格拒绝；名称校验与 JS 的空白、UTF-16 长度保持一致。历史聊天、引用、代码、技术标识及法律归属不做全局替换。

## 考虑过的替代方案

| 方案 | 未采用原因 |
|---|---|
| 只覆盖 `productName` 与图标，仍共享 Ultrawork 目录 | 同时安装会共用凭证、端口注册表、技能与历史，品牌名称和真实数据归属不一致 |
| 全仓字符串替换 `ultrawork` | 会改到第三方名称、版权、协议环境和源码路径；难以保持默认兼容 |
| 每个品牌复制一份源码或维护长期分支 | 修复同步与发布维护成本随品牌数量增长 |
| 打包后修改安装包名称和图标 | 不能补齐运行时隔离，并会使签名失效 |
| 允许任意 identifier/路径参数 | 扩大身份碰撞和误接管存量目录的范围，缺少稳定升级边界 |

## 后果

- 一个 checkout 可重复构建默认与自定义发行版，品牌资源和身份可追溯；各品牌独立安装、运行和保存用户数据。
- 品牌首次启动需要重新配置模型、渠道与连接器，并重新授予平台权限；不会自动带入 Ultrawork 配置或历史。
- 同品牌 Dev/正式版共享数据，切换前要退出另一实例。品牌更名或 namespace 变更需要另行设计迁移与升级方案。
- 构建链增加身份账本、metadata、staging 和锁；不同品牌占用额外构建缓存与运行数据空间。
- macOS `.app` 生成、浏览器 E2E、DMG 布局/签名及 Windows/Linux 原生安装是不同验收层次，状态单独记录在 [testing §16](../testing.md#16-独立品牌发行版的验证adr-075)，不能互相替代。
- 本机已取得最新源码的默认 ARM64/MyWork Universal Dev DMG、中文/空格路径搬迁、C locale/中文 HOME 原生 9 项（含 JSONC/MCP 重启恢复）、包内 sidecar 单 Agent/Team/Pipeline 工具循环 12 项及 Chrome/WebKit 证据；外部模型与 ACP 产品使用本地 fixture 的部分须明确标注，不能由此承诺所有客户环境零缺陷。
