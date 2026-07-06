# 027 — 办公 CLI 连接器：钉钉 dws / 飞书 lark-cli / 企业微信 wecom-cli 接入方案

> 状态：Phase 1（飞书）已开工（2026-07-06，分支 `feat/office-cli-connectors`）——§6 待验证清单已实测回填，UI 归属/技能形态/安装方式三项已拍板
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
- [ ] wecom `init` 有无非交互配置（flag/env/配置文件直写）；配置文件路径与格式；有无 auth status 等价命令（Phase 3 再验）。
- [x] ~~UI 归属命名拍板~~ **已拍板（2026-07-06）**：方案 ①——「MCP 连接器」分区更名「连接器」，内分「MCP」/「办公 CLI」两组（见 §2）。**技能形态与安装方式两项方案偏差同日拍板**：薄路由技能 + Rust 直下二进制（见上方两条结论）。
- [x] ~~lark 授权成功态输出结构~~ **真机验收实拍（2026-07-06，用户账号全流程走通）——四个契约与文档推定全面不符，均已修（review-r3）**：
  - **错误态 JSON 走 stderr**（stdout 为空）+ 非零退出；成功态走 stdout。机器读输出必须两路都接。
  - **`auth status` 成功态 = exit 0 状态文档，无 `ok` 字段**：`{appId, brand, defaultAs, identities:{bot:{status,available,message}, user:{status,available,message,openId,userName,tokenStatus,scope,expiresAt,refreshExpiresAt,grantedAt}}, identity}`。未授权时 `user.status:"missing"/available:false`；授权后 `status:"ready"/available:true/tokenStatus:"valid"`。**授权判据 = `identities.user.available` 布尔**。
  - **设备流字段实为 `verification_url`**（user_code 内嵌在 URL query 里），无独立 user_code/interval 字段；实拍 shape=`{device_code, expires_in:600, hint, verification_url}`。二进制 strings 里的 `verification_uri`/`_complete` json tag 属于其它内部结构体，不是本命令输出。
  - **`--domain all` 对新建托管应用必然部分授予**：CLI 完成授权仍非零退出，输出 `{event:"authorization_complete", granted:[...], missing:[...], already_granted:[]}`——**这是成功不是失败**；新应用默认只授基础 scope（basic_profile/auth:user.id/offline_access 等），calendar/approval 等缺失域由 agent 运行时按 lark-shared 指引增量 `auth login --domain X` 补授。
  - agent E2E 实录：`tool_search → skill(feishu-assistant) → bash(lark-cli auth status --json，自带静噪 env)` → 返回真实身份数据，薄路由全链路成立。
  - **连接器级授权必须用 `--recommend` 而非 `--domain all`（复验发现，review-r5）**：`--domain all` 首次授权只静默授予基础 scope；**重复授权**时托管页会把缺失域路由进「开通申请审核」流（提示"已提交申请，正在审核中"，人工审核、不发 token）——连接器的「授权」按钮必须零摩擦，`--recommend` 只请求免审批 scope 秒过；业务域由技能在任务时增量 `auth login --domain <x>` 补授（可能触发开通审核，属平台正常流程，SKILL.md 已教 agent 如实告知用户等待）。

**lark-cli 其它实测要点（2026-07-06，供实现参考）**：配置落点 `~/.lark-cli/`（config.json + cache/logs；token 在 macOS 走 Keychain，`config keychain-downgrade` 可降级文件存储）；错误输出全线结构化 JSON + 类型化 exit code（not_configured=3）；`--domain` 支持 21 个业务域 + `all`，`--recommend` 只请求免审批 scope；`auth qrcode` 可生成 PNG/ASCII 二维码；`config remove` 清配置与 token。

## 7. 参考来源

- 桌面调研文档：`~/Desktop/最新的Agent技术/钉钉飞书企业微信CLI能力调研.md`（2026-07，含背景分析链接）
- https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli · https://github.com/larksuite/cli · https://github.com/WecomTeam/wecom-cli
- 钉钉开放平台 CLI 文档：https://open.dingtalk.com/document/development/dingtalk-cli-performing-tasks-within
- 企业微信开放平台 CLI 帮助：https://open.work.weixin.qq.com/help2/pc/21676
