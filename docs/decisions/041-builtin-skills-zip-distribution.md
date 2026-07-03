# ADR-041: 内置技能 zip 分发 + 首启解压

- 状态：Accepted（✅ 已实现并真机验收，2026-07-03）
- 日期：2026-07-03
- 关联：ADR-032（内置技能管线，本 ADR 修订其分发形态）、ADR-040（ppt-master 与遮蔽机制，restore 路径随动）、ADR-037（跨平台约束）、gotchas §10（zip 分发坑点合集）/ §12（MSI 路标）

## 背景

ppt-master 合入后 `skills/builtin/` 达 53MB / 1.2 万文件，以松散树进 Tauri `bundle.resources`：
mac 签名/公证要逐文件处理、CI 打包与用户安装 inode 压力大、Windows MSI（WiX v3 File Table
1.2 万行）直接打挂被迫停用（gotchas §12）。同时首启 `install_builtin_tree` 整树拷贝耗秒级。
装机后 bundle + config 目录双份存储 ~100MB。

## 决策

### D1 — git 保持松散树，zip 是构建期产物
`skills/builtin/` 松散树继续 git 跟踪（fetch 脚本、代码审查、遮蔽语义地基全不动）。新增
`scripts/pack-builtin-skills.ts`：按内容 hash 惰性打 `skills-builtin.zip`（新鲜时瞬时跳过），挂
`beforeDevCommand`/`beforeBuildCommand`/`build-release.ts`（双保险）。产物目录
`src-tauri/resources/builtin-skills/` gitignore、以 `.gitkeep` 入 git——`tauri::generate_context!`
**编译期**要求 bundle.resources 源路径存在，CI 裸 `cargo test` 不打包也能过编译。

### D2 — sentinel 外置 + zip 内不含 + 解压后写入（原子不变式强化）
bundle 携带 zip + 并排外置 `.builtin-version`（`find_builtin_source` 锚点逻辑零改动）。zip 内
**刻意不含** sentinel：`install_builtin_tree` 全量解压到 `.builtin.staging` 成功后才把外置
sentinel 写进 staging、再 rename——不变式从「staging+rename」强化为「**sentinel 可见 ⇔ 整树完整**」
（有 cargo 测试锚定 extract-先于-删旧树 顺序；corrupt zip 失败保留旧一致树）。hash 算法与 fetch
脚本逐字节一致（喂「相对路径+`\0` 分隔」——裸 basename 对目录改名失明；**改一处必须同步另一处**），
树未手改时 pack hash == git 提交的 sentinel（可对账）；dev 改技能 → hash 变 → 自动重打 + 桌面端重装。

### D3 — Rust 用 zip crate 直读，不引入 manifest
`zip` crate（default-features 关、只留 deflate）。`reconcile_builtin_shadowing` 从 zip central
directory 枚举 bundled（entry 恰为 `<dir>/SKILL.md`，复用 `skill_registration_name_from_str` 谓词）
——不产构建期 manifest（避免 TS/Rust 双 frontmatter 解析器漂移；central directory 解析 ms 级、
调用点低频）。restore 改**按前缀选择性解压**（component 级 strip_prefix；0 匹配报错防空树自愈死循环）。

### D4 — 篡改即拒的多重设防（八路对抗审查产出）
- extract：`enclosed_name()` 对绝对路径是**消毒**非拒绝 → 显式拒绝 `/` 开头、`\`、`:`、symlink entry；
  unix mode 回写掩 `0o777`（剥 setuid）。
- reconcile 枚举的顶层目录名对称设防（拒 dot 开头/`\`/`:`——恶意 `../SKILL.md` 否则可把 prune 指向
  skills 根；`.builtin-version/` 可删活 sentinel 造成重装 thrash）。
- `clear_staging` 替代裸 `remove_dir_all`（对预置 symlink 静默失败 → 解压穿透写外部目录）。
- 空/不可读 sentinel 硬失败（否则 `needs_refresh` 恒真、每启动全量重装）。
- pack 期 fail-fast：文件名含 `:`/`\`、symlink 直接 throw（把「用户首启零内置技能」拉回构建面）；
  `.DS_Store`/`Thumbs.db` 不入 hash 不入 zip；zip/sentinel temp+rename+pid 原子落位
  （beforeDevCommand wait:false，孤儿 vite 下与 cargo build 并发；并行 pack 互踩）。

### D5 — TS 侧选型 fflate
纯 JS、跨平台（Windows 无 zip 命令，不 shell-out）、快（12k 文件 ~0.8s）；`os:3 + attrs:(mode<<16)`
保 unix 可执行位（源码级核验负数位运算写出字节正确）。每平台 CI 打自己的 zip 自己消费
（Windows CRLF checkout 使其 sentinel 与 git 值不同——per-platform 自洽，勿跨平台对账）。

### 刻意不做
- **MSI 不加回 targets**：本 ADR 只使 gotchas §12 的复活前提成立（File Table 1.2 万行 → 3 行），
  复活需 release CI 实证 MSI 构建+安装后再改 `build-release.ts --bundles`，届时对比 MSIX。
- fetch 脚本拉取/patch 逻辑不动（仅 sentinel hash 算法同步）。
- 前端零改动（审查证实所有新错误面已有 catch/降级）。

## 影响与验证

- **app Resources 53MB/12k+ 文件 → 10MB/4 文件**；Windows 安装器 15 文件；下载体积不变。
- 首启解压 ~1.3s（旧整树拷贝更慢）；稳态启动零写盘；恢复单技能 ~1.0s。
- 验证：cargo 36（+7 安全/原子性）· vitest 281 · 四 builtin e2e（共享 `builtin-zip-helper.ts`）·
  真 .app 生命周期自动化 22/22 · tauri dev 冒烟 · CI 两轮三平台全绿 + mac/Windows 产物抽查 ·
  真机人机走查（真实 HOME 升级重装 → curated 装用户版遮蔽 → 恢复内置全链）。
- 坑点固化：gotchas §10「zip 分发管线坑点合集」。
