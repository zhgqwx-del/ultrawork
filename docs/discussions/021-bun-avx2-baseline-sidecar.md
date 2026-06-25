# 021 — Bun 无 AVX2 CPU 崩溃 与 sidecar baseline 变体方案

> **状态**：调研记录（事实部分已核验）+ 讨论中（方案未拍板、未实施）
> **日期**：2026-06-24
> **触发**：用户云桌面崩溃截图（根因分析，引用 oven-sh/bun#30613）
> **范围**：OpenCode sidecar 在不支持 AVX2 指令集的 x64 CPU 上启动即崩溃的兼容性问题

---

## 1. 现象与根因（来自用户截图的分析，已逐条核验）

### 1.1 截图根因分析原文要点

1. Bun **v1.3.8 之后**的 x64「modern」构建变体，在**不支持 AVX2 指令集**的 CPU 上启动时立即崩溃（oven-sh/bun#30613）。
2. 崩溃发生在 Bun 内部 SIMD 字符串处理库做**运行时 CPU 特性分发**时：在缺 AVX2 的机器上选了 `unsupported_implementation` stub，其方法返回 `0/false/null`，导致后续代码踩到内存空值。
3. 受影响 CPU：仅支持 `SSE4.2 + AVX`、**没有 AVX2** 的老旧型号 / 配置受限的虚拟机 / vCPU——精确命中此 Bug。
4. OpenCode Server 二进制捆绑 Bun（截图称 v1.3.14），在这类机器上 **100% 必现崩溃** → AI 核心服务永远无法启动。

### 1.2 影响范围

| 维度 | 内容 |
|------|------|
| 受影响功能 | **所有 AI 问答功能完全不可用**（OpenCode Server 是核心 sidecar） |
| 受影响用户 | **所有使用不支持 AVX2 CPU 的 Windows cowork 云桌面用户**（部分老旧 CPU 型号、配置受限虚拟机 / vCPU） |
| 不受影响 | macOS 用户；具有 AVX2 支持的 Windows 用户 |

---

## 2. 对本项目的核验结论

### 2.1 当前 bun 版本

| 位置 | 版本 |
|------|------|
| 开发机本地 `bun --version` | **1.3.12** |
| 根 `package.json` `packageManager` | **bun@1.3.12** |
| `vendor/opencode/package.json` `packageManager` | bun@1.3.11 |

- 真正决定运行时的是**编译进 sidecar 二进制里的 bun runtime 版本**，等于编译时所用的 bun（≈1.3.12）。
- 截图说捆绑 1.3.14，可能是某次更新后的发布版本；**不影响结论**——1.3.11 / 1.3.12 / 1.3.14 全部 ≥ 1.3.8，都落在受影响区间。

### 2.2 构建链路只产出 modern 变体，从不产出 baseline ⚠️

`vendor/opencode/packages/opencode/script/build.ts` 里 x64 目标有 `modern`（要求 AVX2）与 `baseline`（只要 SSE4.2）两种 Bun 产物。`allTargets` 中已为 linux-x64 / win32-x64 / darwin-x64 定义了 `avx2: false` 的 baseline 条目（line 104-159），**但两条构建路径都把它过滤掉了**：

- **交叉编译路径**（Ultrawork 经 `scripts/build-opencode.ts:131` 用 `--target=` 走这条）：
  ```js
  // build.ts:161-165
  return `${item.os}-${item.arch}` === targetFlag && !item.abi && item.avx2 !== false
  ```
  末尾 `item.avx2 !== false` **显式排除 baseline 变体**。
- **本机 `--single` 路径**：
  ```js
  // build.ts:174-176
  if (item.avx2 === false) return baselineFlag   // 只有传 --baseline 才出 baseline
  ```

而 Ultrawork 侧 **从未传 `--baseline`**（`grep -rn baseline scripts/ .github/ src-tauri` 全空）。

**结论：分发给 Windows 用户的 OpenCode sidecar 是 modern 变体 → 在不支持 AVX2 的 CPU 上 100% 必现启动崩溃。截图分析对本项目成立。**

### 2.3 为什么「打包工具」bun 会引发运行时错误

常见误解：bun 只是打包/编译器。实际上 **bun 本身是一个 JS 运行时（类比 Node）**，且 OpenCode sidecar 是用 `bun build --compile` 产出的（`build.ts:217 Bun.build({ compile: {...} })`）：

- `--compile` = 把**整个 Bun 原生运行时 + JS 代码**塞进一个独立可执行文件；用户机器**没装 bun 也能跑**，因为运行时就在 exe 里。
- 启动该 exe 本质上是在**执行内嵌的 bun native 二进制**。Bun 的字符串/SIMD 模块在启动时做 CPU dispatch，modern 变体的代码路径**假定 CPU 有 AVX2**。
- 缺 AVX2 的 CPU 上这段 native 代码选错实现（stub）→ 崩溃。

**所以崩的不是项目自身的 JS 逻辑，而是被编译进二进制的 bun 运行时本体。** bun 在这里既是编译器又是被打进产物的运行时——这就是它能引发运行时错误的根本原因。

---

## 3. 候选方案（未拍板）

### 方案 A：仅分发 baseline（最简单，全员降级）

x64 全部改用 baseline 变体，不再发 modern。

- 改动面最小：构建脚本加 `--baseline` / 放行过滤即可，分发逻辑零改。
- 代价：**所有 x64 用户（含有 AVX2 的）都吃 baseline 的 SIMD 降速**（见 §4）。
- arm64（Apple Silicon / Windows on ARM）不涉及 AVX2，不受影响、不变。

### 方案 B：同时分发 modern + baseline，运行时按 CPU 选择（兼顾性能与兼容）

为 x64 同时构建两个变体，启动前探测 AVX2 决定用哪个。

- 性能无损（有 AVX2 走 modern），兼容性全覆盖。
- 代价：**安装包/分发体积翻倍**（单个 sidecar ≈ 122MB，见 §4）+ 需要 CPU 探测与二进制选择逻辑。
- **关键障碍**：Tauri `externalBin`（`tauri.conf.json:38`）按**构建目标三元组**解析 sidecar 名（`opencode-server-<target-triple>`），**不按运行时 CPU**。要按 CPU feature 切换得**绕过标准 sidecar 自动解析**——自定义 spawn / 启动 shim / 或在 Rust 侧探测后拼路径。

### 方案 C：仅对受影响渠道（Windows 云桌面）发 baseline

主流渠道发 modern，针对云桌面客户单出一个 baseline 安装包。

- 主流用户性能无损，体积不翻倍。
- 代价：多一条发布产物线 + 分发/选择心智负担；用户拿错包仍崩。

---

## 4. 加 `--baseline` 的影响与负面作用（用户关注点）

| 维度 | 影响 |
|------|------|
| **运行时性能** | baseline 用通用 SSE2/SSE4.2 代码路径替代 AVX2 SIMD，**字符串处理 / JSON 解析 / 编解码等 SIMD 密集操作变慢**。但 AI sidecar 主要是 **IO/LLM 流式等待瓶颈**，CPU-SIMD 占比低，**端到端实际体感差异通常很小**；需 profiling 实测确认幅度。 |
| **构建复杂度 / 稳定性** | `build.ts:172-173` 原注释明确：**「Baseline binaries require additional Bun artifacts and can be flaky to download」**——baseline 需额外下载 Bun 产物，CI 偶发拉取失败，构建时间与失败率上升。 |
| **分发体积** | 单个 sidecar ≈ **122MB**。方案 B 同发两份 → x64 安装包/下载 **多约 122MB**；方案 A 仅替换则体积不变。 |
| **运行时选择逻辑（仅方案 B/C）** | Tauri externalBin 不按 CPU 选 → 需自写 CPU 探测 + 二进制路径选择（Rust 侧 `is_x86_feature_detected!("avx2")` 等），新增可出错的代码路径与测试面。 |
| **跨平台一致性** | arm64 无此概念、不变；只 x64 受影响。需保证脚本只对 x64 启用 baseline 分支，别误伤 arm64。 |
| **vendor patch 维护成本** | 改动落在 `vendor/opencode/.../build.ts`，属于 vendor 源码 → 必须走 `patches/vendor-opencode-config-fix.patch` 流程（重新生成 patch + 列全文件），且 vendor bump 时可能与上游漂移冲突。 |
| **正确性收益** | 唯一根治崩溃的方向：baseline 在缺 AVX2 机器上正常启动。**对受影响用户是「不可用 → 可用」的质变**，权衡时性能/体积代价相对次要。 |

**初步倾向**（待讨论）：若云桌面是重要客户群，**方案 A（全员 baseline）实现成本最低、无分发选择心智**，先以可用性优先、用 profiling 验证降速可接受；若实测降速明显再升级到方案 B。

---

## 5. 若实施的步骤（草案，先不操作）

> 以下为 **方案 A** 的最小步骤草案；方案 B/C 在此之上增加「双变体构建 + Rust CPU 探测选择」。

1. **改 vendor 构建过滤**：在 `vendor/opencode/.../build.ts` 让 x64 baseline 条目对 Ultrawork 的 `--target=` 路径放行（或本机构建链路传 `--baseline`）；只针对 x64，arm64 不动。
2. **改 `scripts/build-opencode.ts`**：x64 目标传递 baseline 标志 / 选用 baseline 产物名。
3. **重新生成 vendor patch**：`git diff` **列全 patch 涉及的所有文件**（含 build.ts）覆盖 `patches/vendor-opencode-config-fix.patch`（遵循 CLAUDE.md vendor patch 流程）。
4. **重编译 sidecar**：`bun run --bun scripts/build-opencode.ts`（按目标）。
5. **验证**：
   - 在无 AVX2 环境（或 QEMU/禁 AVX2 的 VM）启动 sidecar，确认不再崩溃、`/global/health` 正常；
   - profiling 对比 modern vs baseline 的端到端延迟，量化降速；
   - 有 AVX2 机器回归确认无功能/性能退化（若走方案 A）。
6. **（方案 B 额外）**：Rust 侧 `is_x86_feature_detected!` 探测 + 绕过 externalBin 自动解析，按 CPU 选 `opencode-server-...-baseline`；新增选择逻辑单测。
7. **收尾**：CHANGELOG Fixed / gotchas（构建章节记 baseline 触发条件与坑）/ 视情况升级为 ADR。

---

## 6. 待确认问题（讨论用）

1. 受影响云桌面客户体量？是否值得为兼容性牺牲全员/部分性能？
2. 选 A（全员 baseline，简单）还是 B（双变体，性能无损但体积+逻辑翻倍）还是 C（单独渠道）？
3. baseline 的实际降速幅度——是否需要先做一次 profiling 再定方案？
4. 是否借此把 bun 版本策略一并梳理（pin / bump 与上游修复进展联动）？

---

## 7. 零开发核实结论（2026-06-24）

> 用户要求开发前先做「零开发、纯核实」4 件事。以下为可自主完成部分的结论；标 ❓ 的需用户/外部信息。

### 7.1【#1 Windows 二进制来源】部分坐实

- `docs/build-and-deploy.md` §8.3/§8.5 记载 **Windows 包 = 在 `windows-latest` 原生构建**（`bun run build:opencode` → `tauri build`），bun 版本 pin **1.3.12**（与本机一致；截图所称 1.3.14 存疑）。
- 原生构建时 `scripts/build-opencode.ts` 走 `isNative=true` → `bun run build --single`（**非** `--target=`）→ vendor `build.ts` 在无 `--baseline` 时**只产 modern（要求 AVX2）变体** → **正是会崩的二进制**。
- 推论：**修改 build.ts / build-opencode.ts 确实能触达 Windows 产物**（不像 `--target=` 交叉编译那条对 windows 命名不匹配、产不出东西）。
- ❓ 但仓库**无 committed `.github/workflows/`**——CI 是「文档建议、尚未落地」。所以实际崩溃的那个二进制是**手动 Windows 构建**还是**某 fork**（内存里曾有「桌面 fork」性能报告），仍需用户确认。若来自 fork 且其 bun 版本/flag 不同，本仓库改动未必生效。

### 7.2【#4 上游修复进度】重大发现——baseline 不是「保证修复」⚠️

查上游（issue 实际为 **#28399 / #27090**，非截图所称 #30613）：

| Issue | 版本 | 内容 | 状态 |
|-------|------|------|------|
| oven-sh/bun **#28399** | v1.3.11 | Windows x64 **无 AVX/AVX2** 的 **baseline** 构建启动即 `panic: attempt to use null value`（与截图症状一致） | **Open（未修）** |
| oven-sh/bun **#27090** | v1.3.6+ | **bundled（`--compile`）的 baseline** 在 **无 AVX** CPU 上崩溃，而**独立 baseline 二进制在同机正常** | Closed as duplicate |

**关键区分（决定方案A 能否成立）**：

- 截图所述受影响 CPU = **SSE4.2 + AVX，仅缺 AVX2**。Bun baseline 只要求 SSE4.2 → **这类「有 AVX、缺 AVX2」的机器，baseline 应能正常运行** → **方案A 对此情形有效**。
- 但 #28399/#27090 针对的是**完全无 AVX**的 CPU——那里**连 baseline（尤其 bundled baseline）都还在崩，且是上游未修的 bun bug**。若部分云桌面机器**连 AVX 都没有**，则 **方案A 也救不了**，只能等 bun 上游修或换 bun 版本，**无本地构建 workaround**。

**因此原核实项 #2「拿到受影响机器的 CPU 特性标志」从一般性升级为枢纽问题**：
- 若 CPU **有 AVX、仅缺 AVX2** → 方案A 成立，按 §5 推进。
- 若 CPU **连 AVX 都没有** → 方案A 无效，转为「跟踪 bun #28399 修复 / 评估 bun 版本」，本地无解。

### 7.3 仍需用户/外部信息（无法自主核实）

- ❓【#2】受影响机器的 **CPU 型号 + AVX/AVX2 标志**（`coreinfo` / CPU-Z）+ 真实崩溃日志栈——**枢纽，先于一切方案**。
- ❓【#1 收尾】崩溃二进制是本仓库手动 Windows 构建还是 fork。
- ❓【#3a】无 AVX2 云桌面用户体量。
- ⏳【#3b】baseline vs modern 端到端降速——可本机各编一份 darwin-x64 变体 benchmark（约 10min，需用户点头再做，非纯只读）。

---

## 关联

- vendor patch 流程：`CLAUDE.md` §Vendor Patch 管理
- 构建脚本：`scripts/build-opencode.ts`、`vendor/opencode/packages/opencode/script/build.ts`
- sidecar 分发：`packages/client/desktop/src-tauri/tauri.conf.json` `externalBin`
- 上游：截图所称 oven-sh/bun#30613；实测更相关的是 **#28399**（Windows x64 无 AVX baseline panic，Open）与 **#27090**（bundled baseline 在无 AVX 机器崩，closed as duplicate）
