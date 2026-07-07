# 027 — 办公 CLI 连接器：钉钉 dws / 飞书 lark-cli / 企业微信 wecom-cli 接入方案

> 状态：**Phase 1（飞书）+ Phase 2（钉钉）均已实现并真机全流程验收**（飞书 2026-07-06 / 钉钉 2026-07-07，分支 `feat/office-cli-connectors`，ADR-043 为决策记录）——§6 待验证清单全部实测回填（lark 6 坑 + dws 契约多轴与 lark 相反，SSOT 已固化 gotchas §14 两段）；Phase 3 企微待做（同分支，合入推送待全部阶段完成；届时一并做 connector registry / probe 骨架去重 / e2e mock 工厂化三项泛化，见 ADR-043 后果节）
> 日期：2026-07-06
> 输入：用户桌面调研文档《钉钉飞书企业微信CLI能力调研.md》（2026-07，三家仓库/认证/平台等关键事实已于本文写作时上网复核）
> 关联：ADR-041（内置技能 zip 分发）· ADR-040（技能依赖探针 + 引导安装）· ADR-037（跨平台约束）· ADR-036（渐进式工具披露）· gotchas §3（MCP）/ §6（登录 shell PATH）· 本地记忆 `dingtalk-channel-plan.md`（Gateway 钉钉 channel，**与本文正交**：channel=入站消息通道，本文=出站工具能力）
> 范围：评估「设置页连接器管理 连接/鉴权 + 内置技能包装 CLI 使用」的可行性与落地路径。**不涉及**自研三家 OpenAPI 对接。

---

## 0. 一句话

**可行，且是"顺纹路"的活**：三家均已官方开源 Agent-native CLI（本地进程、JSON 输出、dry-run、schema 自省、自带 Agent Skills、凭证自管于 OS Keychain），与本项目现成基建逐环节对得上——探针复用 `check_skill_dependencies` 模式、安装复用内嵌 Node npm 或 AI 对话引导、技能走 ADR-041 zip 管线、调用走 agent bash + rich PATH（gotchas §6 已修）——**全程零 vendor patch**。唯一概念校正：三家 CLI 刻意 CLI-first、**不是 MCP server**，接入形态应为「CLI 连接器」卡片（管检测/安装/鉴权/状态，不写 OpenCode `mcp` 配置），而非包一层 MCP wrapper。

---

## 1. 三家 CLI 事实速览（2026-07 复核）

| 维度 | 钉钉 dws | 飞书 lark-cli | 企业微信 wecom-cli |
|------|---------|--------------|------------------|
| 仓库 | DingTalk-Real-AI/dingtalk-workspace-cli | larksuite/cli（14.7k★，最成熟） | WecomTeam/wecom-cli |
| 语言/许可 | Go / Apache-2.0 | Go（npm 分发）/ MIT | Rust / MIT |
| 安装 | install.sh / npm `dingtalk-workspace-cli` / 二进制；**Windows 有 PowerShell installer** | `npx @larksuite/cli@latest install` | `npm i -g @wecom/cli`（Node ≥18；mac x64/arm64、Linux x64/arm64、**Win x64**） |
| 认证 | OAuth 设备流 `dws auth login --device`；凭证 PBKDF2+AES-GCM 落 Keychain | OAuth `auth login --no-wait`（立即返回授权 URL 不阻塞）+ `--device-code` 恢复轮询；`auth status` 查登录态/scope | `wecom-cli init` 交互式配置（机器人 Bot ID/Secret） |
| 能力自省 | `dws schema` ✅ | `lark-cli schema` ✅ | 文档静态映射为主 |
| Agent 特性 | `--yes` 跳确认、`--dry-run`、`--jq`、智能输入纠错 | dry-run、多输出格式、`--page-all` 自动分页、`lark-event` WS 事件 | JSON 输出 |
| 自带 Skills | mono/multi 两布局 + 13 个 Python 脚本 | 26 个 | 12 个 |
| 规模 | 18 产品 / 331 命令 + `dws api` 直调任意 OpenAPI | 18 域 / 200+ 命令（底层 2500+ API） | 7-8 品类 |
| **准入门槛** | **高：必须企业管理员在开发者平台开通「CLI 访问管理」**（共创/灰度；CLI 内置 "Apply Now" 通知管理员流程） | 低（开源即用；`config init` 具体要求待验证，见 §7） | 中：需机器人凭证；**按企业规模分级**（>10 人=文档类；≤10 人=消息/日程/会议/待办等更全） |

三家共性（对本项目决定性有利）：本地单进程 CLI + JSON stdout（天然适配 spawn+parse）；dry-run 可做写操作安全预览；**token 由 CLI 自己存 Keychain，app 不碰任何凭证**；自带的 Agent Skills（Markdown）可转译复用（MIT/Apache-2.0 许可均过 gotchas §10 再分发门槛）。

## 2. 概念校正：不是 MCP，两条接入路线

三家不约而同拒绝 MCP-first、走 CLI-first（背景分析见桌面调研文档参考来源）。因此：

| | A. 「CLI 连接器」卡片类型（**推荐**） | B. 包一层 MCP server wrapper |
|---|---|---|
| 形态 | 设置页管 检测/安装/鉴权/健康状态；**不写 OpenCode `mcp` 配置**；调用由技能引导 agent 走 bash | 自研 wrapper 把 CLI 命令暴露为 MCP 工具 |
| 原生特性 | 保留 `--dry-run`/`--jq`/schema 自省/输入纠错 | 全部丢失或需自己转译 |
| 工具表影响 | 零（bash 调用，不加条目）→ 对渐进式工具披露（ADR-036）零影响 | 数百命令进工具表 → 披露折叠压力 + EAGER 名单维护 |
| 维护 | CLI 升级由官方管 | wrapper 随三家 CLI 各自演进持续维护 |
| 进程 | 用时 spawn、用完即走 | 常驻 stdio 子进程 ×3 |

**连带产品决策（已拍板 2026-07-06，用户选 ①）**：设置分区「MCP 连接器」更名为「连接器」总分区，内部分「MCP」/「办公 CLI」两组。（原倾向 ② 独立「办公连接器」分区，实测后用户拍板收敛为单一「连接器」分区。）

## 3. 逐环节基建映射（可行性论据，全部有现成先例）

| 环节 | 现成先例（文件位置） | 增量工作 |
|------|---------------------|---------|
| CLI 检测 | `check_skill_dependencies`（lib.rs，ADR-040 D3）：`rich_path()` 探测 + `run_probe` 5s 超时 + Windows `CREATE_NO_WINDOW` | 加三个 CLI 探针；`auth status`（dws/lark 确认有，wecom 待验）作连接健康检查 |
| 安装 | ① ppt-master `handleDepGuide`（Settings.tsx）：组 prompt 开 AI 会话引导平台化安装；② Browser MCP 内嵌 Node v22 + `node npm-cli.js install -g`（gotchas §3，不依赖系统 Node）；③ `download_node` 的 Rust curl 直下+解压先例（lib.rs） | **已拍板走 ③ 直下 Go 二进制**（GitHub→npmmirror `/-/binary/` fallback + pin 版本 + sha256 硬编码校验，落自管目录进 rich PATH；见 §6 安装机制结论）；①作兜底 |
| 鉴权 UI | 无直接先例，但同构于异步探针 + `test_search_provider` invoke 模式（ADR-042） | Rust command：spawn `lark-cli auth login --no-wait` 捕获 stdout 里的授权 URL → UI 弹链接/开浏览器 → 轮询 `auth status`；dws `--device` 同理展示设备码 |
| 状态卡片 | `ServiceCard` 五态 UI + `use-mcp-servers.ts` hook 模式（Settings.tsx） | 新 `use-cli-connectors.ts` + 卡片（未安装/未授权/未开通白名单/已连接/失败） |
| 技能分发 | ADR-041：`skills/builtin/` → 构建期 `pack-builtin-skills.ts` zip → 首启解压 + sentinel + 遮蔽 reconcile | 加 3 个技能目录（如 `feishu-assistant`/`dingtalk-assistant`/`wecom-assistant`），转译官方 Skills；`x-requires: [lark-cli]` 等虚拟依赖挂 `BUILTIN_DEP_MAP`（use-skill-deps.ts），就绪徽标免费获得 |
| agent 调 CLI | gotchas §6：opencode sidecar 已注入登录 shell rich PATH（2026-07-02 起），npm -g CLI 可被 bash 工具找到 | 技能文档约定 `--yes -f json --jq` 收敛输出（省 token）；钉钉/飞书优先教 agent 用 `schema` 自省而非硬编码命令 |
| 写操作安全 | opencode bash 权限确认体系 | 技能约定写操作先 `--dry-run` 预览再执行 |

与既有钉钉 Gateway channel 规划（本地记忆 `dingtalk-channel-plan.md`，2026-03，未实施）**正交可共存**：channel 是钉钉→app 的入站消息通道，本文是 agent→钉钉的出站工具；长期互补（channel 收消息、CLI 干活）。

## 4. 风险与对策

1. **钉钉白名单（最大准入风险）**：共创灰度，管理员不开通则登录必败。连接器需识别「未开通」态给引导（透传 CLI 的 Apply Now 流程）。
2. **企微 init 交互式**：README 未见非交互 flag/配置文件路径 → Phase 3 先装上验证；若无非交互路径，UI 收集 Bot ID/Secret 后代写其配置文件——三家中唯一可能需 app 碰凭证的点。另：10 人规模分级导致能力矩阵不同，技能文档写清。
3. **CLI 版本漂移**：dws 共创、wecom 新。对策：安装锁版本；技能教 agent `schema` 自省。
4. **PATH 时序**：`login_shell_path()` memoize——运行中新装 CLI 若落到 PATH 外目录当前进程找不到。若用内嵌 node 装到自管目录，需把该目录加进探针与 sidecar PATH（`EXTRA_PATH_DIRS`/`augmentPath` 有先例，gotchas §8）。设计时明确安装落点。
5. **三平台（ADR-037）**：三家均声明支持 Windows，但运行时行为需真机验（与 Browser MCP Windows 待验项同类）。
6. **提示词注入/误操作**：授权后 agent 以用户身份发消息、操作日程文档，三家官方均警示。dry-run + bash 确认为底线；操作日志为后续增强。
7. **国内网络**：安装引导内置 npmmirror；钉钉有 Gitee 镜像。

## 5. 分期建议

1. **Phase 1 飞书**：门槛最低、`--no-wait` 授权流对连接器最友好、schema 自省完善——用它跑通「连接器 UI 骨架 + 探针 + 安装 + 鉴权流 + 1 个技能」整套框架。体量估计与 BYOK websearch 相仿或略小（Rust command 3-4 个 + 设置分区 + 技能 + i18n + 测试，**零 vendor patch**）。
2. **Phase 2 钉钉**：能力最丰富（331 命令），增量主要是「白名单未开通」引导态。
3. **Phase 3 企业微信**：先验证 init 非交互问题，再处理规模分级。

## 6. 已上网复核 vs 待落地验证

**已复核（2026-07-06，GitHub README）**：三家仓库存在与活跃；lark `--no-wait`/`--device-code`/`auth status`/schema/26 Skills/MIT；dws `--device`/白名单必需/Apply Now/schema/mono+multi Skills/PowerShell installer/Apache-2.0/共创状态；wecom `@wecom/cli`/init 交互式/三平台 Node≥18/MIT/10 人分级。

**待落地验证（不阻塞方案成立）**：
- [x] ~~lark `config init` 具体要求~~ **已实测（2026-07-06，v1.0.65 本机 darwin-arm64）：不必手动自建应用**——`config init --new` 走设备流式托管页：stdout 输出 `https://open.feishu.cn/page/cli?user_code=XXXX-XXXX&...` 一行 URL + ASCII 二维码，用户浏览器完成建应用（命令阻塞至完成/过期）；也支持 `--app-id` + `--app-secret-stdin` 非交互绑定已有应用、`--brand feishu|lark`、`--lang zh`。「飞书门槛最低」结论**成立且强化**。注意：`config init` 无 `--json`（URL 用正则 `https://open\.\S+` 从 stdout 提取）；env 里有 `OPENCLAW_HOME`/`HERMES_HOME` 时 init 默认拒绝（要求 `config bind`）——我们 Rust spawn 的干净 env 不受影响。
- [x] ~~`auth login --no-wait` 的 URL 输出格式~~ **已实测**：`auth login --no-wait --json` 结构化 JSON（标准 OAuth 设备流字段：`device_code`/`user_code`/`verification_uri`/`verification_uri_complete`/`expires_in`/`interval`，二进制 json tag 确认）；后续 `auth login --device-code <code>` 恢复轮询完成授权。未配置时输出类型化错误 `{ok:false,error:{type:"config",subtype:"not_configured",hint:...}}` + exit 3。`auth status --json [--verify]` 同为结构化（成功态字段 `identity`/`verified`/`identities.user.{status,userName,openId,tokenStatus,scope}`，官方 lark-shared 技能载明，成功态真机验收时核）。**额外发现**：`doctor`（JSON、恒 exit 0、逐项 `checks[].{name,status,message,hint}`）是比 auth status 更全的健康探针；`whoami` 查当前生效身份；`LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1 LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1` 可静噪 `_notice`（探针 spawn 时建议带上）。
- [x] ~~lark-cli Windows 实测~~ **安装层已确认**：npm 包 `os` 声明含 win32（x64/arm64），GitHub Release 有 `windows-{amd64,arm64}.zip` 产物，install.js 有完整 Windows 路径（PowerShell 双解压 fallback + `--ssl-revoke-best-effort`）。运行时行为真机验留待 Windows 批次（与 Browser MCP 同类，ADR-037）。
- [x] ~~三家自带 Skills 的实际质量与转译工作量~~ **飞书已评估：质量极高，且转译不必要**——27 个技能**内嵌在 CLI 二进制里**（`lark-cli skills list` / `skills read <name>`，构建期嵌入、与 CLI 版本永远同步），含意图路由/身份选择/dry-run 约定/跨技能引用，`lark-shared` 甚至载明了完整 agent 接入流程（background init + URL 提取 + `--no-wait --json` + 字段名）。**内置技能应做成薄路由**：教 agent 先 `skills list`、按域 `skills read`，而非复制 26 份进 `skills/builtin/`（避免与已装 CLI 版本漂移 + 零维护）。钉钉/企微的评估留各自 Phase。
- [x] **安装机制已摸清（新增结论）**：npm 包只是 wrapper（`run.js` + postinstall），真身是 Go 二进制，从 GitHub Release（fallback npmmirror `/-/binary/lark-cli/v{V}/{archive}`）下载 + npm 包内 `checksums.txt` sha256 校验。**推荐直接下二进制**（Rust 侧 curl + sha256 + 解压到自管目录，复用 `download_node` 先例），不必经内嵌 Node npm——少一层依赖、锁版本天然、双源 fallback 与校验逻辑照抄官方 install.js 即可（§3 安装环节相应修正，属方案偏差、待用户确认）。
- [x] ~~wecom `init` 有无非交互配置；有无 auth status 等价命令~~ **已实测（2026-07-07，见下方 Phase 3 Step 0 段）**：`init --noninteractive` 存在（扫码流，凭证自动下发，app 全程零碰凭证——原「UI 收集凭证代写配置」兜底方案不需要）；auth 等价命令 = 隐藏命令 `auth show [--auth-status]`。

**Phase 2 钉钉 dws Step 0 实测（2026-07-06，v1.0.47 darwin-arm64 本机 + 上网复核）**：

- [x] **仓库归属复核**：真身 = `DingTalk-Real-AI/dingtalk-workspace-cli`（2.3k★，日更活跃）；npm package.json 的 homepage 指向 `open-dingtalk/...` 是 404 陈旧指针，勿信。
- [x] **安装产物结构（与 lark 结构性不同）**：npm 包（41MB）**内嵌全部 6 平台二进制 + dws-skills.zip**（非 lark 式 wrapper 下载器），postinstall 无网络、无 sha256 校验环节；且会把 mono 技能**强推进 `~/.claude/skills/dws` 等 16 个 agent 目录**（副作用，Rust 直下提取可完全避开）。GitHub Release 有同名 6 平台产物 + `checksums.txt`（D2 模式可原样复刻）。**⚠️ 双源同版本产物字节不同**（darwin 两源 sha256 不同、windows 相同；版本串同 `b63e1b4`，疑签名差异）→ 双源 fallback 必须按源分别 pin sha256（GitHub 按 checksums.txt；npm 源按 tarball 内资产实测值）。
- [x] **无 config init/建应用环节**：OAuth client 内置（`--client-id/--client-secret` 仅自有应用/ISV 场景覆盖用），装完即 `auth login`——比 lark 少一整个「托管页建应用」流程，连接器少一个状态。
- [x] **输出契约实拍（未登录态；照文档写必错项加粗）**：
  - `auth status`（`-f` 默认即 json）未登录 = **exit 0** + stdout `{"success":true,"authenticated":false,"message":"未登录"}`——与 lark（exit 3 + stderr 错误对象）完全相反；成功信封 = `success`/`authenticated` 字段。错误信封 = `{"success":false,"code","message"}`（官方 error-codes.md 载明）。
  - **`auth login --device` 全部输出走 stderr、人类可读 box、`-f json` 无效**：从 stderr 正则提取 `https://login.dingtalk.com/oauth2/device/verify.htm?user_code=XXXX-XXXX`；900s 过期、5s 轮询；**无 `--no-wait`/`--device-code` 恢复机制 → login 是单个阻塞轮询子进程**，需常驻托管至授权完成（正好接 LARK_INIT_CHILD→HashMap 多槽改造）。默认（不带 `--device`）走 loopback 流（本机 127.0.0.1 回调 + 自动开浏览器，`--no-browser` 可抑制）。
  - **`doctor` 不是 lark 式 JSON 探针**：stdout 人类可读表格（`-f json` 无效）+ stderr error JSON `{"error":{"category","code","message"}}` + 失败时 exit 5；且含网络连通/版本更新检查（外呼、慢）→ 轮询健康探针应用 `auth status`（快、纯本地、恒 exit 0）。
  - `profile list` 未登录 = exit 0 + `{"success":true,"profiles":[]}`；多组织 = profile 体系（corpId 一 profile）。
  - Agent 契约糖：`--yes`（AI agent 模式跳确认）、`--mock`、`--jq`、`--dry-run` 全局可用。
- [x] **白名单未开通契约（strings 实证 + 官方 README，实拍形态待真机登录）**：错误码 **`cli_not_enabled`**；明文 "CLI data access is not enabled for this organization, please contact admin to enable it / please submit an authorization request in the browser..."；**Apply Now 内置于授权流**（用户选组织后可向管理员发申请卡片，管理员一键批准；CLI 侧 `/api/sendApply?adminStaffId=` → `{"clientId","applySent","selectedAdminId"}`）。管理员开通入口 = **open-dev.dingtalk.com →「CLI 访问管理」→ 开启**。scope 增量补授指引 `run 'dws auth login --scope <x>'`（与 lark 同款路由进技能）。
- [x] **`--recommend` 存在**（"登录成功后无交互批量授权服务端推荐权限"）→ 连接器级授权策略与 lark D4 对齐（真机验证其语义后定）。
- [x] **schema 自省登录前基本为空**（仅 3 个本地 helper 条目）：产品 schema 登录后从企业 MCP gateway **服务发现**；官方 SKILL.md 明示「命令可用性因企业服务发现配置而异」→ 技能要教 agent 用 `--help`/`--dry-run` 验证命令存在性（027 §1 表「schema ✅」需按此理解）。
- [x] **自带 Skills 质量极高且薄路由可行**：mono（235 行主路由 + references/products 22 域 + best_practices + 13 个 python scripts）/ multi 18 个（官方标 EXPERIMENTAL）；**技能源内嵌二进制**（`dws skill setup` 默认取内嵌版、升级二进制即升级 skill，`--source` 可覆盖；`--target` 支持 opencode/claude/.../`.`任意目录）→ dingtalk-assistant 薄路由成立：install 时 `skill setup --mode mono --target <自管目录>` materialize 官方 mono 技能，agent 按需读（与 lark `skills read` 等效，零转译零漂移）。
- [x] **token 存储**：Keychain（PBKDF2+AES-256-GCM，MAC 地址绑定）+ `auth-token.enc` 文件回退；`~/.dws/`（identity.json/cache/logs）；`auth export/import` 可迁移认证包。
- [ ] **准入（最关键，待用户确认）**：共创阶段，须企业管理员在 open-dev.dingtalk.com 开通「CLI 访问管理」。用户企业能否开通/用户是否管理员待确认；确认路径 = 管理员登 open-dev.dingtalk.com 找该菜单，或直接真跑 `dws auth login` 走到组织选择页看 Apply Now。
- [x] **`cli_not_enabled` 实拍报错形态（2026-07-07 真机，用户扫码授权后触发）**：白名单检查是 **CLI 侧、token 交换成功之后**做的（Step 4 "Checking organization CLI auth status"），不是浏览器拦截——即用户能完整走完扫码授权，最后才在 CLI 报错。stderr = 人类可读警告块（含**组织主管理员姓名** + 管理后台直达 URL **`https://open-dev.dingtalk.com/fe/old#/developerSettings`**，注意是**旧版**设置页）+ 结构化 error JSON `{"error":{"category":"auth","code":2,"message":"device authorization failed: CLI data access is not enabled for this organization, please contact admin to enable it"}}`；stdout 空；exit 2。**引导态分类器判据 = stderr JSON `error.category=="auth"` + message 含 "CLI data access is not enabled"**；引导 UI 应展示主管理员姓名（CLI 已给出）+ 旧版设置页直达链接。设备流轮询实测 5s/次、~45s 内完成授权链路。
- [x] **授权成功态实拍（2026-07-07 真机，管理员在旧版设置页开通开关后全链走通）**：
  - `auth login --device` 成功 = **exit 0 + stdout JSON** `{"success":true,"message":"登录成功","token_valid":true,"refresh_token_valid":true,"expires_at","refresh_expires_at","corp_id","corp_name","user_id","user_name"}`（人类过程输出恒 stderr，结果 JSON 恒 stdout——与错误态 stderr JSON 对称）。token 有效期 2h、refresh 30 天。
  - `auth status` 已登录 = exit 0 + `{"success":true,"authenticated":true,"token_valid":true,…同上}`——**连接器探针判据 = `authenticated` 布尔**（比 lark 嵌套 identities 简单）。
  - `profile list` = `{"success":true,"primaryProfile","currentProfile","profiles":[{corpId,corpName,userId,userName,clientId,status:"active",expiresAt,refreshExpAt,lastLoginAt,lastUsedAt,isPrimary,isCurrent}]}`；内置 OAuth clientId 实拍 `dingmbw5n9ktkkbbjv3g`。
  - **默认登录即可读业务数据**（`contact user get-self -f json` 直接成功，未要求任何 scope 授权）——scope 模型比 lark 宽松，无「部分授予」概念；缺 scope 时 CLI 指引 `auth login --scope <x>`（strings 实证，实拍待遇到时补）。**`--recommend` 语义未实测**（需再扫码；留待连接器真机验收时实验，决定连接器授权按钮是否带它——与 lark 不同，dws 默认登录已可用，`--recommend` 只是锦上添花而非避审核刚需）。
  - **schema 自省需登录后 `dws cache refresh` 预热**：刷新前仅 3 个本地条目，刷新后 24 个产品展开（本机实拍 22 成功 1 失败 + 2 个哈希名残留条目）——连接器安装/授权完成后应触发一次 cache refresh；技能文档教 agent schema 为空时先刷缓存。
  - 白名单开关实操确认：新版 open-dev.dingtalk.com 首页侧栏「基本信息 → CLI访问管理」用户实际未找到，**生效路径 = CLI 报错给出的旧版直达 URL `open-dev.dingtalk.com/fe/old#/developerSettings`**——引导态 UI 直接用这个 URL。
- [x] ~~UI 归属命名拍板~~ **已拍板（2026-07-06）**：方案 ①——「MCP 连接器」分区更名「连接器」，内分「MCP」/「办公 CLI」两组（见 §2）。**技能形态与安装方式两项方案偏差同日拍板**：薄路由技能 + Rust 直下二进制（见上方两条结论）。
- [x] ~~lark 授权成功态输出结构~~ **真机验收实拍（2026-07-06，用户账号全流程走通）——四个契约与文档推定全面不符，均已修（review-r3）**：
  - **错误态 JSON 走 stderr**（stdout 为空）+ 非零退出；成功态走 stdout。机器读输出必须两路都接。
  - **`auth status` 成功态 = exit 0 状态文档，无 `ok` 字段**：`{appId, brand, defaultAs, identities:{bot:{status,available,message}, user:{status,available,message,openId,userName,tokenStatus,scope,expiresAt,refreshExpiresAt,grantedAt}}, identity}`。未授权时 `user.status:"missing"/available:false`；授权后 `status:"ready"/available:true/tokenStatus:"valid"`。**授权判据 = `identities.user.available` 布尔**。
  - **设备流字段实为 `verification_url`**（user_code 内嵌在 URL query 里），无独立 user_code/interval 字段；实拍 shape=`{device_code, expires_in:600, hint, verification_url}`。二进制 strings 里的 `verification_uri`/`_complete` json tag 属于其它内部结构体，不是本命令输出。
  - **`--domain all` 对新建托管应用必然部分授予**：CLI 完成授权仍非零退出，输出 `{event:"authorization_complete", granted:[...], missing:[...], already_granted:[]}`——**这是成功不是失败**；新应用默认只授基础 scope（basic_profile/auth:user.id/offline_access 等），calendar/approval 等缺失域由 agent 运行时按 lark-shared 指引增量 `auth login --domain X` 补授。
  - agent E2E 实录：`tool_search → skill(feishu-assistant) → bash(lark-cli auth status --json，自带静噪 env)` → 返回真实身份数据，薄路由全链路成立。
  - **连接器级授权必须用 `--recommend` 而非 `--domain all`（复验发现，review-r5）**：`--domain all` 首次授权只静默授予基础 scope；**重复授权**时托管页会把缺失域路由进「开通申请审核」流（提示"已提交申请，正在审核中"，人工审核、不发 token）——连接器的「授权」按钮必须零摩擦，`--recommend` 只请求免审批 scope 秒过；业务域由技能在任务时增量 `auth login --domain <x>` 补授（可能触发开通审核，属平台正常流程，SKILL.md 已教 agent 如实告知用户等待）。

**Phase 3 企微 wecom-cli Step 0 实测（2026-07-07，v0.1.9 darwin-arm64 本机实拍 + 全源码审读——该仓库是三家中唯一全源码开放的，`src/` 即真相，但输出契约仍逐条实拍核验）**：

- [x] **【最关键】init 非交互路径存在 = `--noninteractive`（扫码流）**：跳过交互选择直接走扫码接入；`--no-open` 抑制自动开浏览器。非 TTY 下不带该 flag 直接 bail（stderr `Error: 当前环境不支持交互式操作…` + exit 1）。**无 `--botId`/`--secret` flag**（第三方博客谬传，实测 `unexpected argument` exit 2；手动输入 Bot ID/Secret 仅存在于交互式 TTY 分支）。**扫码即自动创建/绑定机器人并下发凭证**（轮询响应含 `bot_info.{botid,secret}`，CLI 自存）——app 全程零碰凭证，「UI 收集凭证代写配置文件」方案**不需要**，三家中唯一的例外点消除。
- [x] **init QR 流实拍（连接器托管契约，套 dws slot 模式）**：stdout 依次输出 `请打开二维码链接扫码:` + **URL 单独一行**（`https://work.weixin.qq.com/ai/qc/gen?source=wecom_cli_external&scode=XXXX`，正则可提取）+ Unicode 二维码（non-TTY 自动无 ANSI）+ `等待扫码中...`；cliclack 装饰框（`┌ 企业微信机器人初始化`）走 **stderr**（与 dws 的「URL 在 stderr」相反——**又一条轴相反**）。阻塞轮询 **3s/次、300s 超时**（dws 是 5s/900s）；成功后自动调 `get_mcp_config` 验证凭证（失败则 rollback 清凭证 + exit 1）；源码成功态 = stdout `✔ 扫码成功！…` + exit 0（实拍待真机验收）。单个阻塞子进程、无恢复机制 → 必须 slot 托管，禁 agent bash 代跑（同 dws）。
- [x] **探针 = 隐藏命令 `auth show`（`.hide(true)`，help 不列但可调，单测锚定防上游变动）**：未授权 = **exit 0 + stdout 纯文本 `unauthorized`**（**非 JSON**——第三种契约形状：lark=stderr 错误对象+exit 3，dws=stdout success 信封，wecom=纯文本 sentinel）；`--auth-status`（**kebab-case**，源码字段 `auth_status` 直译会错）= 恒纯文本 `authorized`/`unauthorized`；已授权不带 flag = pretty JSON `{id, create_time}`（源码，实拍待验收）。**注意 init 成功 ≠ 每次探活**：`auth show` 只查本地 bot.enc 存在性、纯本地零网络（好探针），不验证凭证在服务端是否仍有效。
- [x] **错误契约**：全线 anyhow → **stderr 人类可读中文 `Error: <msg>` + exit 1，无结构化 JSON 错误信封**（三家中最简陋）；工具调用成功 = **完整 JSON-RPC 响应信封原样打 stdout**（`{"jsonrpc":…,"result":{"content":[{"type":"text","text":"<真正业务 JSON 字符串>"}]}}`——技能要教 agent 解两层）。业务错误 = `业务错误 (errcode=N)：{...}`、接口错误 = `接口错误 (code=N)：{...}`（均 stderr 文本内嵌 JSON）。
- [x] **安装产物 = 第三种形态（无 GitHub Release）**：GitHub Releases 实测**空数组**、无 checksums.txt；npm 主包 `@wecom/cli` 只是 16KB JS wrapper（`bin/wecom.js` execFileSync 转发），真身 = **npm 平台分包** `@wecom/cli-{darwin-arm64,darwin-x64,linux-x64,linux-arm64,win32-x64}`（v0.1.9 起 5 平台，win 仅 x64；0.1.0-0.1.x 早期无 linux-arm64），每包单 Rust 二进制于 `package/bin/wecom-cli[.exe]`（darwin-arm64 9.7MB）。**双源字节相同**：npm registry ↔ npmmirror 同 tarball sha256 实测一致（`050d251c…`）——与 dws 的「双源不同 hash」相反，**每平台 pin 单 sha256 即可**，大陆 fallback 天然成立（npmmirror 常规镜像，无需 `/-/binary/`）。Rust 直下 tarball + `tar -xzf` 提取（复用 dws helpers），Node≥18 前置仅对 npm 装法成立、对我们不适用。
- [x] **凭证/配置落点**：`~/.config/wecom/`（**`WECOM_CLI_CONFIG_DIR` env 可整体重定向**——cargo/e2e 测试沙箱免费获得，lark/dws 均无此便利）：`bot.enc`（AES-256-GCM）+ `mcp_config.enc` + `cache/service_<品类>.json`（工具表明文缓存，**24h TTL**）+ `.encryption_key`（0600 文件 fallback，keyring 写失败仅 warn 不阻断；读取顺序文件优先 → 无 Keychain 弹窗风险）。媒体临时目录 `<tmp>/wecom/media`（`WECOM_CLI_TMP_DIR` 覆盖）。
- [x] **架构 = 企业 MCP gateway 瘦客户端（与 dws 同族但更彻底）**：init 后从 `qyapi.weixin.qq.com/cgi-bin/aibot/cli/get_mcp_config` 拉各品类 MCP 端点（`{biz_type,url,is_authed}` 列表，签名 sha256(secret+bot_id+time+nonce)）；**6 品类静态注册**（contact/doc/meeting/msg/schedule/todo），品类下工具全动态发现（`tools/list`，24h 文件缓存，`cache clear` 重刷 / `cache status` 查看）——**连 `<category> --help` 都需凭证+网络**（未 init = `Error: 未找到 MCP 配置缓存，请先运行 wecom-cli init`）。每工具 `--schema` 可自省、`--json` 传参、默认超时 30s（`get_msg_media` 120s 下载媒体到本地并回 `local_path`）。
- [x] **规模分级的技术表现形式**：分级由**服务端** get_mcp_config 按企业规模下发品类列表（>10 人=文档+待办；≤10 人=消息/文档/日程/会议/待办，README 口径）；调用未下发品类 = stderr `当前企业暂不支持授权机器人「消息」使用权限` + exit 1。**无 dws 式白名单审核门槛 → 无 not_enabled 态**（六态裁剪掉 not_configured 和 not_enabled，比两家都少）；「品类无权限」属技能文档层（教 agent 识别该报错并如实告知），非连接器状态。用户企业落哪档 = 真机 init 后逐品类跑一遍实测，能力矩阵按实测写进技能。
- [x] **官方技能 = 9 个（非 §1 表的 12）**，repo `skills/` 目录（wecomcli-{contact,doc,meeting,msg,schedule,sheet,smartpage,smartsheet,todo}，208KB/3.6k 行，frontmatter 标准）；官方分发 = `npx skills add WeComTeam/wecom-cli`（**拉 repo HEAD、不 pin、依赖第三方 skills 工具**）；技能既不内嵌二进制（lark 式）也无独立 zip 工件（dws 式）→ **建议 vendored**：把 pin commit 的 9 份官方技能收进我们 builtin zip 作 wecom-assistant 的 `references/official/`（MIT + 注明出处与 commit，bump CLI pin 时同步刷新）——漂移风险低（工具 schema 本就服务端动态发现，文档只教用法）。**方案偏差待用户确认**。
- [x] **机器人创建配合步骤（上网复核 + 源码）**：首选**扫码流全自动**（用户手机企业微信扫 CLI 二维码 → 确认 → 凭证自动下发，无需预先建机器人）；手动路径 = 企业微信工作台 → 智能机器人 → 手动创建 → API 模式（普通企业成员可创建；**CLI 授权的机器人仅创建者本人可对话**——防冒用的官方限制）。无企业者可自建企业成为管理员。
- [ ] **待真机验收实拍**：① 扫码成功态输出（stdout `✔ 扫码成功` / `auth show` 已授权 JSON 形状）；② 用户企业规模档位（逐品类探测）；③ 扫码是否要求管理员身份/审批（README 口径普通成员即可，待证）；④ Windows 运行时（随 Windows 批次，ADR-037 同类）。

**lark-cli 其它实测要点（2026-07-06，供实现参考）**：配置落点 `~/.lark-cli/`（config.json + cache/logs；token 在 macOS 走 Keychain，`config keychain-downgrade` 可降级文件存储）；错误输出全线结构化 JSON + 类型化 exit code（not_configured=3）；`--domain` 支持 21 个业务域 + `all`，`--recommend` 只请求免审批 scope；`auth qrcode` 可生成 PNG/ASCII 二维码；`config remove` 清配置与 token。

## 7. 参考来源

- 桌面调研文档：`~/Desktop/最新的Agent技术/钉钉飞书企业微信CLI能力调研.md`（2026-07，含背景分析链接）
- https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli · https://github.com/larksuite/cli · https://github.com/WecomTeam/wecom-cli
- 钉钉开放平台 CLI 文档：https://open.dingtalk.com/document/development/dingtalk-cli-performing-tasks-within
- 企业微信开放平台 CLI 帮助：https://open.work.weixin.qq.com/help2/pc/21676
