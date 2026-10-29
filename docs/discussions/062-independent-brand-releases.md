# 独立品牌发行版实施方案

> 状态：核心实现及本机自动化已完成；双品牌发行、平台实装与系统权限按 [testing §16](../testing.md#16-独立品牌发行版的验证adr-075) 分层记录证据
> 日期：2026-10-28；实施更新：2026-10-29
> 工作分支：`codex/independent-brand-releases`
> 首个定制品牌：MyWork，采用美柚 App 图标
> 当前交付：品牌配置与构建入口、MyWork 固化素材、运行隔离、启动保护及测试；保留实施前已有的 vendor/opencode patch 状态。

同一套源码按构建配置生成独立品牌应用。默认构建继续保留 Ultrawork 的安装身份、图标和既有数据；显式指定品牌文件或临时参数时，生成拥有独立名称、图标、安装身份、用户数据和后台进程归属的发行版。macOS、Windows、Linux 同时属于实施范围。

## 一 目标与范围

### 目标行为

1. 无品牌参数时，现有构建命令继续生成默认 Ultrawork，不读取附近的品牌文件，不继承上次构建选择。
2. 支持本地 JSON 品牌文件及临时 CLI 参数；一次解析，编译、资源生成、打包、签名和发布全过程使用同一个品牌快照。
3. MyWork 是首个可安装、可升级、可与支持品牌归属协议的新版默认版同时运行的独立发行版，使用本地固化的美柚图标。
4. 应用安装目录、应用自管配置、会话、知识库、技能、运行注册表和浏览器 profile 按品牌分开。
5. 同一品牌重复启动仍聚焦已有窗口；不同品牌互不聚焦、互不复用服务、互不终止对方进程。
6. 品牌身份稳定后，同品牌升级保留本品牌数据；默认 Ultrawork 用户不需要迁移数据。

### 隔离边界

隔离本应用管理的安装身份、配置、数据、凭证、缓存、状态、应用元数据和进程生命周期。用户主动选择同一工作区时，工作区内普通文件、Git 仓库、项目级 `opencode.json` 与 `.opencode` 配置仍由用户共享；应用写入工作区的附件和编排目录按品牌区分。

外部 Claude Code、Codex、Gemini、系统浏览器和办公 CLI 自身维护的全局登录信息、缓存及云端账号，继续遵守各工具原有规则。不重写第三方工具的 HOME，不将品牌隔离表述为操作系统沙箱。

不同品牌连接同一个 IM 机器人或渠道账号时，云端连接限制仍可能影响运行。现有企微适配器已处理同一 botId 被新连接接管的终态错误，Gateway 启动还会自动连接 autoConnect 渠道，见 [WeCom adapter](../../packages/channel/gateway/src/adapters/wecom/wecom-adapter.ts) 和 [channel-manager](../../packages/channel/gateway/src/channel-manager.ts)。共存验收使用不同渠道身份；其他平台按各自规则实测，不推断其行为与企微相同。本期不新增跨品牌云账号仲裁系统。

多品牌共存保证要求参与者均升级到支持新归属协议的版本。旧 Ultrawork 的全局浏览器清理和 basename 回收逻辑不受新租约约束；新 MyWork 单方面无法阻止后启动的旧版干扰。升级、回退及并行使用前须退出旧实例并升级默认版。启动时发现可识别的活跃旧宿主应进入阻断诊断，但不把该检查表述为能阻止所有历史二进制启动。

本期不做跨品牌数据自动复制、旧品牌迁移向导、跨品牌原地升级、运行时换肤或客户分支复制。源码包名、Rust crate、内部协议字段和 `ULTRAWORK_*` 环境变量名称可以保留。

版权方、作者、许可证、法律文档和支持链接不属于应用名称替换范围，继续保留原有事实；品牌文案验收不把这些合法署名或实际路径认作漏改。

## 二 源码现状与必须解决的问题

以下保留实施前的问题基线；后续章节记录最终契约，当前实现及验收证据见文末。

| 范围 | 现状与证据 | 实施要求 |
|---|---|---|
| 打包元数据 | [tauri.conf.json](../../packages/client/desktop/src-tauri/tauri.conf.json) 固定 productName、identifier、窗口标题与图标；Cargo bin 为 ultrawork | 生成本次有效配置，不覆写默认文件 |
| 构建入口 | [build-release.ts](../../scripts/build-release.ts)、[setup.ts](../../scripts/setup.ts) 和根 package 脚本分别调用 Tauri | 入口共享品牌解析与构建上下文 |
| 原生展示 | [background.rs](../../packages/client/desktop/src-tauri/src/background.rs) 独立嵌入 macOS 托盘图与启动文案；[webview_runtime.rs](../../packages/client/desktop/src-tauri/src/webview_runtime.rs) 固定应用名 | Rust 使用编译期品牌数据，不能等待 renderer 才改名 |
| 界面展示 | [logo.tsx](../../packages/client/desktop/src/components/ui/logo.tsx) 是独立 SVG；[i18n-translations.ts](../../packages/client/desktop/src/lib/i18n-translations.ts) 多处内嵌名称 | UI Logo、标题、通知、托盘、权限说明统一接入 |
| Rust 路径 | [lib.rs](../../packages/client/desktop/src-tauri/src/lib.rs) 的 OPENCODE_APP_NAME、ultrawork_dir、附件和截图临时目录含固定名称 | 建立统一品牌目录解析，覆盖所有应用自管路径 |
| TS 路径 | ACP、Gateway、Knowledge、Orchestrator 各有固定 ultrawork 路径 | 收敛为共用解析器，不能只改 OpenCode 的环境变量 |
| 孙进程 | [delegate-mcp.ts](../../packages/agent/acp-client/src/delegate-mcp.ts) 固定读取默认 ports.json；[acp-connection.ts](../../packages/agent/acp-client/src/acp-connection.ts) 存在独立 sidecar 路径和 MCP env | 传播品牌身份与解析后路径，禁止定制版回落默认品牌 |
| 进程回收 | lib.rs 的 prepare_port 会在健康检查失败后按 sidecar basename 清理；浏览器清理存在全局名称匹配 | 按品牌和实例确认归属；401、相同进程名或健康 200 均不足以证明归属 |
| 构建副作用 | [build-acp.ts](../../scripts/build-acp.ts) 重编后会直接清理默认端口上的监听进程 | 发布构建不得通过端口号清理正在运行的应用 |
| 缓存 | [turbo.json](../../turbo.json) 未声明品牌输入；素材可能位于仓库外 | 哈希纳入有效配置及实际素材字节 |

`productName` 不是完整身份开关：它影响 macOS bundle 名、Windows 安装目录及默认 MSI upgradeCode、Linux 包名和资源目录；它不会自动替换项目中固定的数据路径、主程序文件名及 React Logo。Tauri 的 `identifier` 还参与系统身份和 WebView 数据目录。[Tauri 配置说明](https://v2.tauri.app/reference/config/#productname)

## 三 品牌配置与身份契约

### 配置格式

首期只支持 JSON，避免为构建配置增加额外解析依赖。正式品牌文件示例，已落地于 `branding/mywork/brand.json`：

```json
{
  "schemaVersion": 1,
  "brandId": "mywork",
  "productName": "MyWork",
  "icon": "./assets/meiyou-app.png",
  "uiLogo": "./assets/meiyou-app.png",
  "trayIcon": "./assets/meiyou-tray.png"
}
```

| 字段 | 规则 |
|---|---|
| schemaVersion | 必填，首期仅接受 1 |
| brandId | 正式文件必填，稳定 ASCII 标识；用于数据 namespace、应用标识与程序名 |
| productName | 必填，用户可见名称，并参与平台原生打包身份；首期使用可打印 ASCII 且必须生成有效 Linux 包名；素材路径可含中文 |
| icon | 必填，本地正方形 PNG 或 SVG；构建不联网下载 |
| uiLogo | 可选，省略时使用 icon；允许与系统应用图标分别设计 |
| trayIcon | 可选，自定义 macOS 单色透明模板图；省略时按应用名首字母生成单色模板图，避免不透明 icon 变成实心方块；实机可辨识性属于验收项 |

未知字段、未知版本、非法类型均报错。首期不开放任意数据路径、identifier、packageSlug、签名主体、第三方账号或安装模板覆盖，防止简单品牌配置演变为另一套 Tauri 配置系统。

### 默认兼容与派生规则

| 项目 | 默认 Ultrawork | MyWork |
|---|---|---|
| brandId / 数据 namespace | ultrawork | mywork |
| productName | Ultrawork | MyWork |
| identifier | com.ultrawork.desktop | com.ultrawork.mywork |
| 主程序文件名 | 保留 Cargo 当前 ultrawork；mainBinaryName 仍不设置 | mainBinaryName=mywork，Windows 自动补 .exe |
| HOME 下应用根 | .ultrawork | .mywork |
| 配置 / 数据 / 缓存 / 状态目录尾段 | ultrawork | mywork |
| 工作区应用目录 | .ultrawork | .mywork |
| Linux 包名 | 保留 ultrawork | productName 转 kebab-case，当前 Tauri 对 MyWork 生成 my-work |
| MSI upgradeCode | 保留当前版本实际派生值 | 由稳定 identifier 按固定 UUID v5 规则生成并显式写入 |
| 默认 UI 大小写与素材 | 保留现有 UI UltraWork、原生 Ultrawork 及原 SVG/图标 | 全部展示 MyWork 和定制素材 |

默认品牌是内置兼容档，不应用新算法重新计算它的 identifier、upgradeCode 或文件名。MyWork 的 identifier 示例在本方案中固定为 `com.ultrawork.mywork`。

自定义品牌MSI规则固定为UUID v5，namespace采用标准DNS UUID `6ba7b810-9dad-11d1-80b4-00c04fd430c8`，输入UTF-8字符串 `<基础identifier>.exe.app.x64`，不含版本或素材摘要。MyWork输入为 `com.ultrawork.mywork.exe.app.x64`，结果为 `F53BC093-5A49-587C-962E-16AA01AD266D`。默认版继续使用当前Tauri基于 `Ultrawork.exe.app.x64` 的既有规则，本地CLI inspect已确认 `7A7C1D26-332C-5C03-818C-2F87039B20DC`；旧MSI安装升级仍需实机交叉验证，不改为新品牌算法。首期Windows目标仍为当前x64。

自定义 brandId 限定为小写字母开头、后接小写字母/数字/单个连接符，长度 2 至 32；不允许路径分隔符、点段、空串、连续或首尾连接符。拒绝 Windows 设备名，拒绝与默认身份冲突的 ultrawork、desktop，以及已知外部工具 namespace，例如 opencode、codex、claude、gemini、qoder、hermes。对 productName 按平台文件名规则校验；大小写折叠或规范化后与默认发行名称冲突时拒绝生成独立品牌。

编译前同时比较仓库全部预设及本地已有构建身份清单中的 brandId、identifier、主程序名、MSI code、Windows规范化安装名称和Linux包名。不同brandId使用相同productName，或MyWork与My Work归一到相同Linux包名，均按发行身份冲突报错。临时配置也执行这项检查；尚未登记的外部分发应用无法由构建器穷尽发现，名称唯一性属于发行契约，不能仅凭brandId不同就保证任意品牌安装隔离。

检查包含正式名与派生开发名，例如另一个品牌的 MyWork Dev 或 Ultrawork Dev 也可能撞已有开发包目录，不能只比较基础名称。已登记发行身份作为可版本控制的记录保存，按 brandId 固定基础 identifier、productName、程序名、Linux 包名和 MSI code；普通构建发现同 brandId 改变这组身份时失败。临时试包在持构建锁后原子登记 `.brand-build/identity-ledger.json`，旧成功产物manifest也参与冲突检查；`brand:inspect`只读不登记。首次正式分发前需固化到版本控制的 `identity.json` 预设发行记录，本地账本不足以约束另一台CI。图标、UI Logo 和托盘图更新不改变身份。

**发行后 brandId、identifier、productName、主程序名和升级身份都应稳定。** 当前 Tauri 无独立通用 packageSlug 配置，Linux 包名及 Windows 安装定位仍受 productName 影响；本期不承诺仅保持 brandId 就能任意改名并无缝升级。图标更新不改变身份。

自定义目录写入轻量品牌身份记录，包含 schemaVersion、brandId、基础发行 identifier，不包含凭证。基础 identifier 不带开发模式的 `.dev`，防止开发包与正式包先后使用同一 namespace 时误报身份冲突；实际 identifier 仅写入实例注册表。已有记录与本次基础身份冲突时停止启动；自定义非空目录缺少身份记录时不自动接管。默认版兼容现有无记录数据，不能因此阻断老用户。

### 开发包身份

保留现有macOS release `--unsigned` 语义：本次有效 identifier 附加 `.dev`，productName 附加 ` Dev`。默认仍得到现有默认开发包规则，MyWork 得到自己的开发包规则。

本期不额外改变现有开发包与正式包的后端数据共享语义：`.dev` 隔离系统权限和 WebView 身份，应用自管数据仍按 brandId。不同品牌始终隔离；同一 namespace 增加跨进程数据所有权租约，必须早于 sidecar 复制、身份记录写入、数据库打开和 ports.json 更新取得。正式包与开发包同时使用同一 namespace 时，后启动者明确拒绝启动后台服务，保留前者的文件、PID 和注册表；同 identifier 的重复启动仍优先由 single-instance 聚焦。

这项租约收紧此前未保证安全的同品牌跨模式并发，不改变常规默认版的安装、目录和旧数据读取。旧 ports.json 只有各 sidecar 的 port/PID，没有宿主 owner PID；兼容检查需结合 OS 父进程、路径、创建时间核验，无法核实则不接管。该规则只能约束新版，不能保证后启动的旧版遵守租约。若以后需要开发数据 namespace，再单独设计迁移与兼容。

## 四 命令行与构建入口

### 已接入的命令

以下参数已接入公共构建入口；正式发布仍须通过适用的平台验收。

```bash
bun run release
bun run release --brand ./branding/mywork/brand.json
bun run release --brand-id mywork --name MyWork --icon ./assets/meiyou.png
bun run release --name MyWork --icon ./assets/meiyou.png
bun run release --brand ./branding/mywork/brand.json --icon ./assets/meiyou-v2.png
bun run tauri:build --brand ./branding/mywork/brand.json
bun run setup --build --brand ./branding/mywork/brand.json
bun run tauri:dev --brand ./branding/mywork/brand.json
```

统一支持 `--brand`、`--brand-id`、`--name`、`--icon`、`--ui-logo`、`--tray-icon`。现有 native、unsigned、skip-sidecar 等发布参数保留，不能再靠 Set 静默忽略未知参数。

### 覆盖与失败规则

1. 不传品牌参数：直接选择内置默认品牌；工作区中的品牌文件、旧 staging 和上次构建结果都不能改变它。
2. 正式文件必须提供稳定brandId；先检查文件JSON/schema与身份，再叠加临时参数。素材存在性、可读性和图片内容只检查最终生效文件，因此配置中的旧icon失效时仍能用 `--icon` 正常覆盖；损坏JSON或非法schema不能由CLI补救。
3. 临时参数无品牌文件时，要求 name 与 icon；brandId 可以显式指定。未指定时仅对 ASCII 名称按固定规则推导，例如 MyWork→mywork、My Work→my-work，并在日志打印结果；无法推导或命中保留名则要求 `--brand-id`。
4. 本期独立发行模式不接受只有 `--icon` 或只有 `--name` 的不完整新品牌，不隐式变成默认应用的另一外观。文件加临时参数可以只覆盖一个字段。
5. 品牌文件中 brandId 不允许被临时参数改写；需要另一身份时使用另一份配置或完整临时参数，避免把品牌文件中的稳定身份误改。
6. 有效字段按默认兼容档、显式文件、临时字段顺序解析；选中自定义档后必须满足完整品牌约束，不能借默认 productName 绕过冲突校验。
7. `--brand` 文件路径相对调用 cwd，文件内素材相对配置文件目录，CLI 素材相对调用 cwd；进入构建前统一转换为绝对路径。
8. 未知参数、缺参数值、重复参数、非法 ID、不可读或无效图片在编译、网络下载和签名开始前报错；显式定制失败不得退回 Ultrawork。
9. 日志输出 brandId、名称、identifier、主程序名、包名、数据尾段和素材摘要，供用户复核；不得打印凭证。

`release`、`tauri:build`、`setup --build`、`tauri:dev` 都调用同一编排入口。底层裸 Tauri CLI 仍可构建默认版，不作为带品牌参数的公共入口，也不得读到上次定制残留。开发时固定端口策略保留：不同品牌争用固定端口时明确报错；跨品牌同时运行的验收使用安装后的生产包动态端口策略。

## 五 架构与数据传播

### 单一品牌快照

已新增轻量 `@agent/brand` 工作区包，提供无 Node 依赖的身份类型、默认兼容档、校验与派生函数；Node 路径解析放独立子入口，renderer 不导入 Node 模块。

构建解析器产出不可变 ResolvedBrand，内容包括品牌身份、素材绝对路径及字节摘要、目标平台、构建模式和有效 Tauri 配置。前端使用生成的纯数据或 Vite 注入；Rust build.rs 将同一快照编译到宿主。版本仍使用现有版本 SSOT，不增加品牌专属版本号。

宿主是运行时身份和路径的事实源，生成 RuntimeBrandContext：品牌身份、实际标识、appRoot/configRoot/dataRoot/cacheRoot/stateRoot、skillsRoot、portsRegistryPath 和实例标记。通过受控环境变量传给所有自有 sidecar；renderer 只通过编译数据或 Tauri IPC 获取展示数据与所需路径。

构建上下文与运行上下文分层：编译机绝对素材路径、签名环境、完整 process.env 不写入运行配置、公开产物清单或诊断日志。新增传播采用明确字段；保留外部 agent 已有环境继承行为，不借品牌功能重构第三方权限系统。

### 启动预检与阻断状态

启动结果显式区分 Ready 与 StartupBlocked。未取得本 namespace 数据租约、身份不匹配或关键路径预检失败时，不仅中断 boot_sidecars，还应阻断整个有副作用的启动链：

- get_sidecar_credentials 不执行 load-or-create，不创建或迁移凭证；端口 IPC 不返回可用默认端口。
- renderer 不挂载 Workspace、SSE、Agent、Model 等会创建目录、刷新技能或连接后台的 Provider，不尝试探测其他品牌默认端口。
- 仅显示本品牌、预期/实际路径、可理解的原因、复制只读诊断、修正后重试和退出。重试重新做预检，不提供未经核验的强制接管。
- blocked 实例退出不删除活动 registry，不结束其他实例进程。OS 自身可能创建 WebView/UI 存储，故无副作用承诺针对应用业务数据、凭证、工作区、技能和端口记录，不宣称系统零写入。

正常 Ready 路径保留现有启动流畅性。非 Tauri 的浏览器开发和测试仍可使用明确选择的独立测试上下文；不能把真实 Tauri 中的 StartupBlocked 当成普通 invoke 失败后默认兜底。相关触点是 [main.tsx](../../packages/client/desktop/src/main.tsx)、[workspace-context](../../packages/client/desktop/src/lib/workspace-context.tsx)、[sidecar-ports](../../packages/client/desktop/src/lib/sidecar-ports.ts) 与凭证 IPC。

### 路径规则

保持当前跨平台目录习惯，不因品牌功能顺带迁移到另一套系统目录：

| 类别 | 默认解析 | MyWork 尾段 |
|---|---|---|
| 应用根 | homedir() 下的 .namespace | .mywork |
| 配置 | 非空 XDG_CONFIG_HOME，否则 homedir()/.config，再接 namespace | mywork |
| 数据 | 非空 XDG_DATA_HOME，否则 homedir()/.local/share，再接 namespace | mywork |
| 缓存 | 非空 XDG_CACHE_HOME，否则 homedir()/.cache，再接 namespace | mywork |
| 状态 | 非空 XDG_STATE_HOME，否则 homedir()/.local/state，再接 namespace | mywork |
| 工作区元数据 | workspace 下 .namespace，含 attachments/runs | .mywork |
| 系统 WebView 存储 | Tauri 按本次 identifier 解析 | 独立 identifier |
| 截图等临时文件 | os.tmpdir()/品牌及实例专属子目录 | 不跨品牌读取或清理 |

默认命令兼容既有正常默认环境及有效绝对 XDG 根下的数据。路径解析将空 XDG 值视为未设置；宿主对默认版显式空 `XDG_DATA_HOME` 额外阻断，因为旧 TS 服务可能把它解析到工作目录，不能安全推断旧数据位置。修正方式为 unset 或指定明确绝对根，不静默迁移。相对或非法 XDG 根同样报错，不宣称这些异常环境与旧版零差异。预检阶段不创建业务目录，避免旧数据被空白首启掩盖。

原有各模块可注入路径的测试接口保留；应用受管启动时，注入值必须在本次上下文中完成归属校验，不能让外部旧 env 将 MyWork 指回 Ultrawork。独立开发测试的显式隔离目录仍可使用。

检查应用自管 namespace 根的真实路径别名：`.mywork` 或配置尾段若通过 symlink/junction 明确指向另一品牌目录，则阻断写入；不一概禁止用户对 HOME/XDG 父目录的正常重定向。活动数据库和租约首期支持本地文件系统；UNC 素材或工作区的路径解析测试，不代表已保证网络卷上的 SQLite 和跨机器锁正确。

### 父子与孙进程

- Rust 启动 OpenCode 时传 `OPENCODE_APP_NAME=<namespace>`，复用现有 vendor patch；Gateway、Knowledge、ACP 使用同一 RuntimeBrandContext。
- ACP→外部 agent→Knowledge/delegate MCP、OpenCode→delegate MCP、agent→Python 技能都显式传播本品牌必要字段和路径。
- managed MCP 配置按本品牌路径重新规范化；陈旧 `mcp.environment` 或 agent.env 不得覆盖受管品牌字段。只规范本应用管理的 MCP 条目，保留用户自定义 MCP 的边界。
- delegate shim 没有 ACP_CLIENT_PORT 时读取本品牌 portsRegistryPath。受管调用缺失/矛盾身份或有效端口时失败，不静默回落默认 `.ultrawork` 或 4099。
- standalone工具未声明受管模式时保留默认兼容行为。自有Gateway/Knowledge/ACP与shim通过显式受管调用参数携带上下文文件位置，不能只用一组可能整体漏传的env区分模式；受管技能包装器也须携带明确调用上下文。OpenCode不新增不支持的CLI参数，由宿主在spawn前验证实际env中的OPENCODE_APP_NAME和必要路径。受管上下文缺失即失败，不能解释成standalone。
- 内置技能的路径通过运行时上下文解析；默认文案和脚本行为保持兼容。定制版需要展示具体目录的技能说明，在构建 staging 中按品牌物化并打包，不修改仓库技能源码。只固化 namespace 与模板输入，不烤入构建机 HOME 或用户未来的绝对 XDG 根。
- 上游同步技能必须修改 fetch/post-patch 来源并重打 zip，不能仅手改同步生成文件。优先复用现有 `ULTRAWORK_SKILLS_DIR` 等接口；变量名称继续保留。

## 六 进程与端口隔离

这是独立发行版上线阻塞项，先于多品牌共存验收完成。

1. 扩展本品牌运行注册表，关联 brandId、实际 identifier、owner PID、实例随机标记、sidecar PID/端口和可执行路径；读旧版默认注册表时走保守兼容。
2. 自有健康响应附可验证的品牌/实例信息。OpenCode 不假设能回显自定义实例标记：活跃子进程以spawn返回handle、PID、OS进程创建时间、实际exe路径和监听PID关联核验；跨启动残留还必须确认原宿主已死亡且上述进程字段仍匹配。三平台先验证这些探针可得性；旧注册表或权限不足导致无法核实时，不kill、不复用，生产另选端口。单独密码相同、health 200、basename相同或PID相同都不能证明归属，不为品牌简单复制vendor patch。
3. 首选端口被其他品牌或陌生程序占用时，生产选择空闲端口，固定端口开发模式报错；不 kill、不复用。归属不明时宁可保留进程。
4. 残留回收需核实当前 PID 对应的实际进程身份，防 PID 重用；只回收本品牌已确认死亡实例留下的进程，不能回收仍活跃的同品牌开发/正式实例。
5. 浏览器 MCP 清理按本实例创建的子进程记录及本品牌完整 profile 路径操作，去掉全局 MCP 名称和任意 chrome-profile 的匹配清理。
6. build-acp.ts 的发布构建移除按 4099 裸清进程的副作用；开发重启若确有需要，只能显式针对可验证的本开发实例。
7. registry原子写、串行化和既有生命周期事件保持；Unix保持0600，Windows校验用户目录ACL，不以chmod结果代替权限验证。退出仅删除自己实例的记录，不能清除后启动实例的状态。
8. 不改变实际业务停止语义：停止会话、关闭窗口、退出应用、sidecar 崩溃仍沿用现有功能，但归属限定为本品牌实例。
9. 数据租约与系统单实例标识分别处理：租约按 namespace，聚焦按实际 identifier。测试同品牌 Dev→正式和正式→Dev顺序启动/退出；顺序使用成功，并发使用明确拒绝，不因 `.dev` 身份变化损坏共享数据。

租约优先采用 OS 句柄级文件锁并在宿主有效生命周期持有；进程退出后由 OS 释放锁。锁文件存在、PID 或 mtime 单独不代表仍持锁，不通过删除活跃锁文件抢占。P0 验证所选实现三平台的互斥、崩溃释放和继承行为；不在首期自制基于时间过期的分布式租约。

初始化要区分启动前已有用户内容和本次创建的锁/临时文件，不能让租约文件自身触发“非空无身份记录”拒绝。可证明属于本次中断初始化的临时元数据可安全恢复；来源不明或身份记录矛盾时保留目录，报告冲突路径，提供备份后改名隔离重试或恢复可信身份记录的步骤。不能通过删除身份记录或清空数据“修复”冲突。

## 七 修改范围

下表是实施任务地图，列出的新增路径仅为计划。实施时如发现额外生产读写点，补进此表及对应验收，不能以全仓字符串替换代替语义审查。

| 模块 | 拟修改或新增位置 | 具体职责 |
|---|---|---|
| 品牌核心 | 新增 packages/core/brand 的纯身份入口、Node 路径入口及相关测试 | 默认档、schema、派生、路径与上下文校验 |
| 品牌预设 | 新增 branding/mywork/brand.json、assets、素材来源说明 | MyWork 首个预设与固定素材摘要 |
| 构建编排 | 新增 scripts 下品牌解析/准备入口；调整 package.json、scripts/setup.ts、build-release.ts | CLI、预校验、快照、staging、输出清单、默认兼容 |
| 缓存与依赖 | turbo.json、相关 package.json、必要 bun.lock、build-hash.ts | 品牌摘要进入正确缓存；品牌中立 sidecar 可复用 |
| Tauri 构建 | src-tauri/build.rs、配置覆盖生成、必要生成文件忽略规则 | Rust 数据与图标嵌入；默认 tauri.conf.json 不被定制覆写 |
| Rust 宿主 | src-tauri/src/lib.rs，宜拆出 brand/paths 模块 | 全部应用目录、鉴权、实例、端口、sidecar、技能、CLI、MCP、附件与临时文件 |
| 原生展示 | background.rs、webview_runtime.rs、必要应用菜单设置 | 首帧名称、托盘图及文案、缺运行时提示、菜单/通知 |
| Renderer | vite.config.ts、index.html、logo.tsx、i18n-context/translations、left-sidebar、Settings、notifications、use-browser-mcp | 展示统一，去掉硬编码 profile 推导；繁体由现有脚本生成 |
| 启动门禁 | main.tsx、boot-splash、sidecar-ports/auth、workspace-context、凭证及端口 IPC | Ready/StartupBlocked 分支；blocked 不写业务数据、不连接默认端口 |
| Gateway | config-store.ts、session-store.ts、index.ts、gateway-server.ts | 渠道配置/绑定、上下文和健康身份 |
| Knowledge | index.ts、服务/MCP 入口 | KB SQLite、上下文和健康身份 |
| ACP | config-paths.ts、session-store.ts、team-store.ts、orchestration.ts、acp-connection.ts、delegate-mcp.ts、opencode-credentials.ts、服务入口 | agent/session/team/隐藏会话、sidecar 定位、MCP 与端口传播 |
| Orchestrator | run-store.ts、worktree.ts、artifacts.ts | 全局 runs/worktrees 与工作区产物目录 |
| Server manager | packages/core/server-manager 中实际宿主调用链 | 审计品牌 env 传播；仅影响被使用的生产路径 |
| 技能适配 | scripts/fetch-builtin-skills.ts、skill-installer 补丁来源、deckcraft/scripts/find_node.py、打包 staging | Python 根目录、Node 探测、技能安装与说明 |
| 进程清理 | lib.rs 端口及浏览器 helper、scripts/build-acp.ts | 去跨品牌误杀与错误复用 |
| 发布与验证 | .github/workflows/ci.yml、release.yml，现有 DMG/Windows/runtime/e2e 验证脚本 | 默认发布稳定，显式品牌构建，跨平台验收 |
| 文档 | build-and-deploy、testing、AGENTS、conventions/gotchas、CHANGELOG；实现阶段新增 ADR | 正式记录稳定契约和真实测试结果 |

优先不修改 OpenCode vendor 源码，先复用当前 OPENCODE_APP_NAME 扩展点。若实施证明必须扩展上游契约，先读 vendor-patch-workflow，仅修改既有受管 patch 来源并按流程重编，不能直接提交 submodule 修改。

## 八 素材与构建可重复性

### MyWork 素材

[美柚官网](https://www.meiyou.com/) 的[美柚 App 图标](https://sc.seeyouyima.com/www/img/63a11255e8dfc_198_198.png)作为识别参考；首个预设采用 App 图标。正式实施阶段固化高清 PNG 或 SVG、UI Logo 与 macOS 模板图，记录来源 URL、取得日期、尺寸和 SHA-256；素材不足时明确区分预览图与发布素材，不把网页小图放大后的文件称作高清原稿。

使用 Tauri icon 工具生成平台所需 PNG/ICO/ICNS。默认构建直接复用既有图标，避免重新生成引入无关外观变化。[Tauri 图标工具](https://v2.tauri.app/develop/icons/)

### staging 与缓存

- 品牌摘要包含规范化配置、实际素材字节、生成器版本、目标及构建模式；同路径换图也必须失效。
- 每次使用品牌及摘要专属 staging；不覆盖默认图标、默认配置和提交中的技能文件。Rust 编译显式监听品牌快照、环境及素材变化。
- 默认构建保留现有输出目录；定制版使用品牌专属 Cargo target/output 根，并让 app/DMG/NSIS/MSI/deb/rpm 定位都跟随本次快照。
- 仓库内仍共享 dist、sidecar 产物与部分资源准备路径，首期对受支持构建入口加跨平台构建锁。一次性构建持锁到产物清单完成；tauri:dev 在整个开发会话持锁，直到其子进程退出。首期同一 checkout 不能同时 dev 与 release/setup 构建；需要并行时使用另一 checkout/worktree，构建器不自动创建。嵌套调用传递并验证锁 token，只由最外层释放，不能子进程重复取锁自锁。失败、中断与异常退出验证可恢复；不以残留文件存在直接判忙。
- Windows embed/offline 两轮共用品牌快照，仅覆盖 WebView 安装方式；清理与 stash 限本品牌本次目录。
- 运行时注入 namespace 的品牌中立 sidecar 二进制可复用；烤入品牌的宿主、前端或技能物化包必须携带品牌摘要。
- 四个sidecar都附构建元数据，声明target、二进制hash、源代码/依赖摘要、受管上下文协议版本；OpenCode元数据还确认现有OPENCODE_APP_NAME patch能力。自定义品牌在打包前校验这些信息，不能启动仍会写默认目录的旧Gateway/Knowledge/ACP二进制。`--skip-sidecar`仅跳过编译，不跳过兼容性检查；缺元数据、hash不符或上下文协议过旧即失败，不能等health握手后才发现已经写错目录。
- 每次构建输出产物清单，记录 brandId、模式、版本、target、实际安装身份、素材摘要及本次文件路径。发布仅使用此清单，不用可能扫到旧品牌包的宽泛 glob。
- Cargo缓存根按品牌/target/profile复用，不因每次换图另开一个完整target。staging按摘要区分；只清理有清单且已结束的本构建缓存，保留最近成功版本，不触碰应用用户数据。多品牌编译缓存可能达到GB级，不能假设只增加几张图的体积。

### 品牌技能包与版本标记

定制技能在构建期完成物化，生成本品牌唯一的 skills-builtin.zip 与配套 .builtin-version。版本标记由最终技能字节、物化器版本及品牌路径模板输入决定，不包含图标字节、实例随机值或临时端口；仅换图不应重装整树技能。默认构建继续复用当前技能包及版本语义。

初装、升级、手动刷新和解除用户遮蔽后的选择性恢复，全部使用同一品牌包。提取完整后才写 sentinel 并原子切换，保留用户技能优先和原子替换契约。包资源内只允许一个有效 zip/sentinel 来源；修改 map 型 bundle.resources 时须显式移除默认源键，不能仅追加映射让默认包与定制包同时占用 skills/builtin。验收以展开安装包的实际资源为准。[技能打包器](../../scripts/pack-builtin-skills.ts)

## 九 发布与签名策略

v* 标签按同一版本构建默认 Ultrawork 与 MyWork 各自的三平台安装包，六个任务全部成功后发布到同一个 GitHub Release。workflow_dispatch 可显式选择 all / default / mywork，仅上传验证 artifact；CI 只接受仓库预设，不接受任意远端配置 URL。两品牌的 artifact 名和 manifest 按品牌/平台分离，发布前校验清单中每个安装包的大小、SHA-256 和文件名唯一性；不通过宽泛 glob 混入旧产物。

保留当前版本标签校验、macOS Universal、DMG 布局验证、签名、公证与 staple。所有路径基于 ResolvedBrand，素材和元数据在签名前完成。不同品牌通常可使用同一 Developer ID 证书，但新 identifier 有独立系统权限记录；证书主体不随应用名变化。[macOS 签名说明](https://v2.tauri.app/distribute/sign/macos/)

正式 tag 中两个 macOS 品牌均须签名、公证和 staple，缺材料或验证失败即阻断发布；ALLOW_UNSIGNED_RELEASE 只允许显式 workflow_dispatch 的开发验包，不作为正式 tag 的降级通路。构建/签名成功不推导用户机器的通知、截图授权、安装升级或卸载已通过。

Windows 保持当前 NSIS embed、offline 与 MSI 三件套。自定义品牌使用独立且稳定的 MSI upgradeCode，默认保留原值。仓库当前没有完整启用 Windows 发布签名，本期不把购买或接入新签名服务列为品牌功能前置；已有签名环境按原机制使用，未签名产物如实标记，不能宣称签名通过。

首期Windows升级范围为同品牌、同安装器类型：NSIS→NSIS及MSI→MSI。embed与offline均属于NSIS，分别验证安装；MSI与NSIS互相迁移不在首期默认保证范围。卸载默认保留用户数据，不引入静默清除本品牌或另一品牌数据的行为。

Linux 继续以现有 release 的 deb/rpm 为首期安装包范围，验证主程序、desktop 文件和资源路径互不冲突；不借品牌功能恢复目前未稳定纳入 release 的 AppImage。AppImage 后续如启用，须补等价验收。

### 升级失败与回退

仅保证受测的同品牌前向升级版本对；品牌功能原则上不改业务数据库 schema，但 OpenCode 和 Knowledge 打开数据库时已有迁移行为，不能从前向升级通过推导出任意旧版可读。

首期提供手动恢复步骤，不新增一键回滚系统：升级前退出该 namespace 全部新旧实例，保留原安装包，制作包含配置、凭证、数据库及相关文件的一致性备份；SQLite 应在停服务并确认关闭后完整备份目录，或使用正式备份接口，不能只复制运行中的主 .db 而漏掉 WAL。备份沿用用户目录权限，不输出密钥。

若升级失败，先停止新版本，再依据已测兼容表选择重装旧包或恢复升级前完整备份。不得把重新安装旧包称作数据回滚，也不依赖旧程序会识别新锁。P5 保存实际前向升级与手动恢复演练记录，未知降级行为明确标为不支持。

## 十 实施步骤与阶段出口

| 阶段 | 工作内容 | 阶段出口 |
|---|---|---|
| P0 冻结基线与身份 | 保存默认 metadata/路径/upgradeCode/图标基线；确定 schema、CLI、MyWork 预设、品牌摘要与保留名规则；验证三平台进程归属探针、文件锁及StartupBlocked最小链路 | 身份表可复核；探针不足时安全避让；租约崩溃释放；blocked不创建凭证/工作区、不连接默认端口；任何前置条件不成立则修订方案后再扩大实施 |
| P1 收敛路径 | 增加品牌核心、Rust 路径层；覆盖四个 sidecar、Orchestrator、workspace 元数据和 Python 技能 | 假 HOME 中默认旧数据可读，MyWork 不读写默认目录，XDG 语义一致 |
| P2 传播与生命周期 | 宿主→sidecar→agent/MCP/技能传播；namespace数据租约、注册表/health/残留回收/浏览器清理；移除构建杀端口副作用 | 两品牌真实后台并行、不同及相同密码下均不复用/误杀，异常恢复不影响对方；同品牌跨模式不并发双写 |
| P3 品牌表现 | UI、HTML、Rust 启动/托盘/菜单/通知/权限文案；本地素材与图标生成 | 三语及原生首帧名称正确，默认外观保持原样 |
| P4 构建与发布 | 统一四类入口、锁/staging/缓存/输出；双品牌三平台 installer、签名及 CI 接线 | 默认→MyWork→默认连续产物正确，同路径换图会更新，tag 六任务与清单校验通过后发布两品牌安装包 |
| P5 安装与升级验收 | 在专用账号/VM 安装两品牌，验证升级/卸载/权限与并行任务 | 下节全部阻塞项通过，具备品牌分别发行条件 |
| P6 文档与交付 | 构建指南、测试记录、ADR、索引与变更日志；整理实际证据 | 仅凭预设与素材即可重现构建，未通过项不标成功能完成 |

P1 是 P2 的前置，P2 是共存上线前置；P3 可以在身份契约固定后并行准备素材。P4 不以 UI 预览代替包内验证，P5 不以 CI 编译通过代替真实安装结果。

在三平台构建环境、默认签名材料与正式素材可用的前提下，完整范围按8至14人日规划，属于工程估算而非交付承诺；环境等待不计入。分项如下，部分工作可并行缩短日历时间，但不省略验收：

| 工作 | 人日估算 |
|---|---|
| 契约、CLI、身份与P0探针 | 0.5至1 |
| Rust、四sidecar、孙进程及技能路径 | 2至3 |
| 数据租约、StartupBlocked、归属清理与旧版边界 | 2至3 |
| 界面与素材 | 0.5至1 |
| 缓存、构建入口、CI与三平台封装 | 1至2 |
| 真实安装升级、并行回归、恢复演练及文档 | 2至4 |

该范围不包含旧版二进制双向并行兼容、一键数据回滚、网络文件系统锁或跨品牌云账号仲裁。P0若发现必须新增平台原生依赖或扩大vendor patch，应重新估算。后续新增品牌通常不再改产品代码，但仍有素材准备、身份校验和三平台安装抽验成本。

## 十一 验收矩阵

下表是完整发行验收标准，不能由本机单测全部替代。已完成的自动化与包内检查见文末；缺少实机证据的场景继续待验。每项保存命令、平台、版本/摘要、关键输出及 pass/fail。

| ID | 场景 | 通过标准 |
|---|---|---|
| A01 | 无参数默认构建 | 原 productName、identifier、bin、图标、大小写、正常环境数据路径、产物路径与 unsigned 规则保持基线；不自动读配置或上次选择；异常XDG按A13预检 |
| A02 | 文件与临时参数 | 三种有效调用及文件加单字段覆盖结果一致；不同 cwd、空格/中文路径解析符合契约；显式参数不持久化 |
| A03 | 输入反例 | 未知字段/参数、缺值、重复参数、非法 brandId、保留名、默认及自定义预设间规范化身份碰撞、坏图片均在编译/下载前失败；不产生默认包替代品 |
| A04 | 默认数据兼容 | 隔离 HOME 中预置旧默认配置/凭证/会话/skills/渠道 fixture，新默认版全部可读，不重命名或迁移；对比内容差异只允许预期应用写入 |
| A05 | MyWork 首启 | 同一隔离 HOME 放有默认 fixture，MyWork 看不到且不复制/修改它；自己的根目录、随机凭证和身份记录正确建立 |
| A06 | 完整持久化 | 真实 OpenCode、ACP、Gateway、Knowledge、Team、runs/worktree、workspace 附件、skills/Node/CLI/profile 均仅写本品牌预期目录 |
| A07 | 孙进程 | OpenCode delegate、ACP Knowledge/delegate、Python 安装技能及 Node 探测均使用本品牌路径；去掉端口 env 后 shim 仍正确读本品牌注册表 |
| A08 | 身份损坏与覆盖 | 受管上下文缺失/矛盾、陈旧managed MCP env、agent.env覆盖被拒绝或规范化；进入StartupBlocked后不创建凭证/工作区/技能，不连接默认端口，不挂业务Provider；只读重试/退出不清另一实例 |
| A09 | 双品牌启动 | sidecar basename 相同，凭证不同，A→B 和 B→A 均运行；401不触发误杀；含真实OpenCode的共享密码控制组也不能跨品牌复用；缺归属证据只避让 |
| A10 | 生命周期交叉 | B 持续聊天或执行任务时，A 关闭/退出/崩溃/重启/回收孤儿/断开浏览器均不改变 B 的 PID/端口/任务结果；交换角色再测 |
| A11 | 构建不扰运行 | B 正在运行时重构建 A，含实际触发 build-acp 重编；B 服务与浏览器任务持续存活，不被端口清理 |
| A12 | 单实例与陌生端口 | 同identifier第二次启动仅聚焦；不同品牌各自运行；同namespace Dev/正式顺序使用成功、并发时后者在sidecar复制前拒绝且无写入；陌生服务占默认端口不被关闭，生产安全避让、固定开发模式报错 |
| A13 | XDG 与平台路径 | 未设置、空串、自定义绝对XDG根在Rust/TS/Python解析一致；异常根预检无迁移；品牌根指向另一品牌的symlink/junction被阻断；本地中文/空格路径、UNC素材/工作区解析正确；不以此保证网络卷数据库/锁 |
| A14 | 展示完整性 | 系统安装入口、Finder/Dock、任务栏/开始菜单、Linux launcher、托盘、通知、About、缺 WebView2 和权限说明显示本品牌；三语品牌文案无旧名残留，版权/许可/内部路径按范围保留 |
| A15 | 连续构建与缓存 | 默认→MyWork→默认、MyWork→另一测试品牌结果正确；同一路径换 icon/tray/UI 字节后对应产物更新，不能只凭日志判定 |
| A16 | 构建失败与并发 | 第二次构建明确报忙；中断/坏素材后默认文件不变；下次无参数构建恢复默认；本次清单无旧品牌产物；skip-sidecar遇旧/缺元数据二进制在打包前失败 |
| A17 | 安装与卸载共存 | 三平台同时安装支持新归属协议的默认/MyWork；Linux bin/desktop/资源无冲突，Windows卸载/MSI记录独立；卸载A不删除B程序或自管数据；旧版组合明确不在并行保证内 |
| A18 | 同品牌升级 | 老默认→新默认、MyWork v1→v2各自保留会话和设置；无重复升级身份；B不受A升级影响；不要求跨品牌迁移 |
| A19 | 签名与权限 | macOS真实签名、公证、staple通过，新品牌通知/截图授权独立；unsigned不得替代正式身份验收；Windows按实际签名能力记录 |
| A20 | 功能回归 | 两品牌基本聊天、停止、ACP、Team delegate、知识检索、附件、浏览器MCP、窗口隐藏/恢复可用，未改协议与权限回环 |
| A21 | 发布范围 | v*同版本发布默认/MyWork三平台安装包；六任务全成功、清单大小/摘要及安装包重名检查通过；dispatch仅上传所选品牌验证产物，版本守卫照常生效 |

全部适用A01至A21均须通过，才能完成实施；A04至A13、A15至A18为优先执行的数据和共存门禁，展示及基本功能也不是可跳过项。Windows签名等条件项按现有能力明确记录为适用/不适用及理由，缺环境不能冒充通过。任何一平台的适用项失败，不得宣称三平台独立发行完成。

### 测试环境与自动化

以下补充场景并入原验收ID，不以重复增加编号代替覆盖：

| 对应ID | 补充判据 |
|---|---|
| A03 | 正式/派生Dev名交叉碰撞被拒绝；同brandId更改已登记发行身份也被拒绝 |
| A06/A07 | 技能初装、升级、刷新、用户遮蔽后恢复均保留本品牌路径；包内仅一个技能资源来源；仅换icon不改变技能版本 |
| A08/A12 | 锁竞争、宿主崩溃和异常退出后OS锁正确释放；锁文件残留不误阻断；未知非空目录有保留原内容的恢复指引；blocked实例退出无业务清理 |
| A10/A17 | 新版发现已运行旧宿主时不接管；记录后启动旧版可能干扰的边界，不把无法约束旧版写成通过；旧版演练在专用环境 |
| A16 | tauri:dev会话全程持构建锁，嵌套调用不自锁，停止或崩溃后可重建；缓存清理不删运行数据和活跃staging |
| A18 | 停服一致性备份及手动恢复演练通过；前向版本对清晰，未知降级不被标为兼容 |
| A20 | 两品牌使用独立渠道凭证完成各自功能；同渠道账号冲突沿用平台错误处理，不误判为本地进程隔离失败或宣称云账号也隔离 |

- sidecar/路径集成测试在子进程 import 前设置 HOME、USERPROFILE 和 XDG_*，启动后断言实际 homedir。参考现有 `e2e/orchestration-worktree.e2e.ts` 的父子进程结构；不能在模块初始化后才换环境。
- 两品牌使用同一组测试 HOME/XDG 基目录，靠 namespace 隔离；测试夹具不得写真实用户数据。日志中的凭证仅保留摘要或认证结果。
- 当前 dynamic-ports e2e 固定了 macOS target，实施需参数化或新增跨平台 harness，不能直接计作三平台覆盖。
- 记录各品牌宿主/sidecar PID、端口、registry、profile、数据文件位置和另一品牌持续任务结果。两个窗口出现不是生命周期验收证据。
- Tauri WebView、Windows known folders/注册表与安装行为不一定服从假 HOME；真实包安装、升级、卸载在专用测试账号或 VM 验证。
- 当前 CI Windows 跳过整套 TS unit tests，不能沿用“已有CI已测Windows全部逻辑”的表述。新增短生命周期品牌/路径/ownership 测试须能在Windows独立执行，配合现有三平台 typecheck/Rust job；宏观安装验收另记真机结果。
- Windows专用验收表逐项记录NSIS embed、NSIS offline、MSI的系统版本、品牌摘要、包类型、安装/共存/同类型升级结果；短生命周期品牌/路径/归属测试在Windows runner实际执行，不能将macOS/Linux结果代填。MSI↔NSIS迁移不混入同类型升级通过记录。
- P0记录默认单品牌冷/热启动、内存和磁盘基线；P5报告新默认单品牌、MyWork单品牌与两品牌并行的对应数据，并列出额外预检/资源复制的耗时。不能将双品牌额外资源成本说成默认单品牌回归，也不在未测量前承诺零开销。
- 后续代码门禁按 quality-gates 执行：相关包单测、全仓 typecheck、三平台 cargo test、繁体生成检查和文档漂移检查。测试命令使用 bun run --bun。

## 十二 风险与完成定义

### 确定会发生的行为变化与成本

| 变化 | 用户或维护者的影响 |
|---|---|
| 新品牌首次启动为空配置 | 模型/API key、知识源、渠道及系统授权需重新配置；不自动继承Ultrawork |
| 每品牌保存自管资源 | sidecar副本、Node、技能、办公CLI、浏览器profile及知识数据可能重复，占用更多磁盘 |
| 多品牌同时运行 | 各有WebView和四个后台服务，内存/CPU及模型请求成本随实际任务增加，不承诺资源零增长 |
| 严格身份与目录校验 | 配置冲突会明确拒启动，需要只读诊断和恢复步骤；归属不明的孤儿可能保留而非冒险回收 |
| 同品牌跨模式互斥 | Dev与正式版共享数据时后启动者被拒；须退出另一模式后再运行 |
| 同checkout构建串行 | dev期间不能同时release；需要停止dev或使用另一个checkout |
| 发行矩阵增加 | 每次涉及品牌/打包的改动要验证默认与MyWork的多平台结果，新增品牌仍需安装抽验 |
| 发布身份被冻结 | 正式品牌改名需新身份或另做迁移；临时参数不能绕过已登记身份 |

### 可能发生的回归与控制

| 风险 | 控制与验证 |
|---|---|
| 误改默认身份导致用户看到空数据 | 默认兼容档独立，A01/A04与旧版fixture先行 |
| 某个孙进程回落默认路径 | 受管模式严格校验，A06/A07/A08逐链路操作真实文件 |
| 多品牌凭证不同触发401后误杀 | 实例归属替代basename推定，A09/A10负控制覆盖 |
| 产品改名打断升级 | productName及稳定身份冻结，显式MSI code，改名另立迁移方案 |
| 共享dist/技能staging和缓存串品牌 | 构建锁、独立staging、字节摘要及包内检查 |
| 配置指向无效素材仍产出默认品牌 | 编译前fail-fast，A03断言失败无替代产物 |
| 系统图标缓存掩盖结果 | 检查包内素材摘要，并在干净账号/VM检查系统展示 |
| 第三方账号或同一项目仍共享 | 边界写入构建指南，不通过更改第三方HOME制造隐性行为变化 |

完成实施必须同时交付：品牌schema与CLI、MyWork本地预设与素材、统一路径/身份传播、进程归属隔离、三平台安装包、默认兼容证据、同品牌升级与双品牌共存证据，以及可重复的构建和验收说明。

核心实现和本机自动化验收已完成，不能将此状态写成三平台发行验收全部完成。默认版和 MyWork 的发布打包/签名、安装、升级、卸载、双窗口生命周期、完整业务操作与系统权限仍按 A01–A21 分层保存平台证据。vendor/opencode 源码修改继续由累计 patch 管理，submodule 提交未随品牌功能改变。

### 2026-10-29 实施证据与剩余项

- 已落地 `@agent/brand`、四类公共构建入口、身份与素材快照、构建 OS 锁、本地临时身份账本、sidecar 协议与字节校验，以及按清单导出产物。默认源码配置和图标未被覆盖。
- MyWork 预设使用美柚 App Store 官方 CDN 的 1024×1024 PNG 原图；来源、获取日期和 SHA-256 固化在 `branding/mywork/assets/source.json`，构建不联网取图。
- Rust 宿主建立品牌目录、身份记录和 namespace 数据租约；sidecar、孙进程、MCP、技能继承受管上下文。归属不明时不复用和不清理。StartupBlocked 在 renderer 业务 Provider 及凭证加载前拦截。
- 全仓 9 包 typecheck 通过；前端 111 文件、933 测试通过。品牌核心 34、ACP 142、Gateway 293、Orchestrator 74、Knowledge 20 项测试通过，包含同一假 HOME 下真实子进程存储隔离和旧默认 fixture。复审持续补充了 Rust IPC/进程退出负控制及构建安装布局反例，宿主、构建和 DMG 布局测试的最终数字以 [testing §16](../testing.md#16-独立品牌发行版的验证adr-075) 为准。
- 本机 macOS arm64 真实 8 个 sidecar 在同一临时 HOME/XDG/workspace 下同时运行；相同密码控制组仍保持配置、会话/数据库、渠道、Agent 与知识源隔离，错误密码全部返回 401。停止 Ultrawork 的四个自有进程后 MyWork 的四个保持健康，测试退出已回收全部子进程。可用 `scripts/verify-brand-sidecars.ts` 重复；报告位于忽略目录 `.brand-build/verification/sidecars-macos-arm64.json`。这不代替原生宿主双窗口、崩溃与完整业务验收。
- 已经公共入口完成 macOS arm64 默认→MyWork→默认的真实 app-only 连续构建。包内 productName、identifier、主程序正确；默认 ICNS 摘要与源码原图相同，MyWork ICNS 不同且技能资源版本独立，两者 `codesign --verify --deep --strict` 均通过本地 ad-hoc 校验。报告位于 `.brand-build/verification/packaged-apps-macos-arm64.json`；测试没有安装或启动应用，也没有正式签名身份。
- MyWork Dev 和默认 Ultrawork Dev 的 macOS ARM64 完整 release 已成功；DMG 实际图标坐标为 app.x=180、Applications.x=480，未绕过布局检查。修复了 unsigned 封装后才重签外部 `.app` 的旧顺序问题，改为封装前 ad-hoc 签名、封装后仅校验。Finder `-1712` 属于早期失败尝试，本轮已复验通过。
- 真实 DMG 的哈希、大小、Info.plist 和包内 deep/strict 签名通过；复制到包含中文和空格的临时客户目录后签名不变，269 个包内文本资源无源码 checkout 引用，五个 Mach-O 仅使用相对或 macOS 系统动态库。此检查不把编译诊断字符串中的源码位置误当作运行时依赖。
- Chrome 与 WebKit 各 30 个品牌启动场景通过，覆盖默认/MyWork、三语及五类阻断/错误状态；复制诊断、重试、退出、图标及无业务副作用检查通过。国际化持久化、真实 ACP 计划与设置三分区的既有浏览器回归也通过。此前请求判据误将 Vite 模块识别为 API 的问题已修正。
- 搬迁后的包内 sidecar 跑通真实 ACP 单 Agent→Knowledge MCP、Team→delegate MCP→成员、权限门控、Pipeline/worktree/产物、重启恢复；真实 OpenCode 对接本地 SSE 模型 fixture 的单回合和 Team 工具循环均通过，不依赖真实模型账号。
- 真实 macOS 双宿主已验证八个后台并行、同 identifier 重复启动退出、默认宿主崩溃/重启回收/干净退出均不影响 MyWork，以及最终自有进程回收。更新后的完整记录和剩余原生场景以 testing §16 为准。
- 最终扩展原生验收为九项，使用中文及空格 HOME/安装路径与 `LC_ALL=C`；实际 PATCH 全局配置后写入注释、尾逗号和旧 managed MCP 环境，宿主崩溃重启后保留用户字段、移除旧环境，Knowledge/delegate MCP 均重新连接。旧包负控制先明确检出失败，再由修复后的包通过。
- 使用已安装默认包与当前构建的真实 sidecar 完成数据前向读取：旧构建写入的配置、会话、渠道、Agent、知识源可由当前默认版读回，MyWork 不暴露这些记录；沙箱限制写入临时目录，十二个测试进程全部回收。双方版本均为 0.3.9，该结果不代替跨版本安装器升级或降级验收。
- Windows/Linux CI 门禁已接入品牌短生命周期测试，本次未触发远端 CI；三平台实装、同品牌升级/恢复、跨品牌完整业务并行及正式签名/系统授权仍待专用账号或 VM 验证。

实施中收窄输入契约：当前 Tauri Linux 包名由 productName 派生，首期产品名仅接受可打印 ASCII，且因 Tauri DMG 模板插值排除 `$` 与 `@`；显式 brandId 也不开放中文产品名。品牌配置和素材路径仍可含中文。新增默认运行依赖为零，OS 数据租约要求 Rust 1.89+。

多角度复审修复了实际缺陷：Linux 自定义包的 sidecar 改用带 namespace 的 `/usr/bin` 文件名，并在打包后检查真实 deb/rpm 文件清单；预检比较全部程序名，防止另一品牌主程序撞上 sidecar。macOS 额外比较 single-instance 对 identifier 点号/连字符归一后的键，避免基础包与另一品牌 Dev 包碰撞。Windows PowerShell JSON 查询统一 UTF-8，进程退出由真实子进程句柄、退出事件及 OS 创建身份共同确认。原生应用 IPC 增加集中 Ready 门禁，阻断状态仅允许启动诊断命令；普通写命令无法绕过 renderer 门禁执行。相关回归与尚未实测的平台边界保存在 testing §16。

追加日志复核修复了两条重启/预热边界：Rust 全局配置读取兼容 OpenCode 写出的 JSONC（注释、尾逗号、BOM），配置读取与迁移失败明确阻断；delegate MCP 在每次工具调用时读取当前品牌/实例注册表，不再永久缓存预热时尚未确定的 ACP 端口。macOS 内部进程探针固定 UTF-8 locale，保证 GUI 环境下中文路径身份稳定。最终测试数字、日志和包摘要统一保存在 testing §16。

## 十三 参考

- [ADR 020 配置隔离](../decisions/020-config-isolation.md)
- [ADR 037 跨平台兼容](../decisions/037-cross-platform-compat.md)
- [ADR 045 动态端口与生命周期](../decisions/045-dynamic-sidecar-ports.md)
- [ADR 069 macOS CI 签名](../decisions/069-ci-macos-code-signing.md)
- [构建部署指南](../build-and-deploy.md)
- [质量门禁](../quality-gates.md)
- [Vendor patch 工作流](../vendor-patch-workflow.md)
- [Tauri 配置与 MSI upgradeCode](https://v2.tauri.app/reference/config/#wixconfig)
