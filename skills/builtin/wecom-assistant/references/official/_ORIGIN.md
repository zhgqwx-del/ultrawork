# 来源与许可（provenance）

本目录是企业微信官方 wecom-cli 仓库 `skills/` 的 vendored 快照：

- 上游仓库：https://github.com/WecomTeam/wecom-cli
- 快照 commit：`9eb7898b959861af879495e211e37431fa908f19`（vendoring 当日 2026-07-07 的 main HEAD，**整树单一 commit**）
- 许可：MIT（见同目录 `LICENSE`）
- 唯一改动：各技能的 `SKILL.md` 改名为 `INDEX.md`（避免被 OpenCode 的 `skills/**/SKILL.md` 递归扫描识别成独立技能，绕过 wecom-assistant 的健康检查路由）；内容零改动，内部 `references/` 相对链接不受影响。

**为什么不是 pin 的 CLI 版本对应的 gitHead**：npm `@wecom/cli@0.1.9` 的 gitHead（`72e14f7`）只有 7 个技能——`wecomcli-sheet`/`wecomcli-smartpage` 是其后新增，且旧版 `wecomcli-doc` 对 `/sheet/*` 的路由说法与新技能矛盾。工具可用性由企业服务端动态下发（`tools/list` 服务发现）、与 CLI 二进制版本解耦，取更新的完整文档树对 pin 的 CLI 同样有效且内部自洽。

**维护**：bump `WECOM_CLI_VERSION`（lib.rs）时，从当时的上游 main HEAD 重新快照本目录（**整树同一 commit、勿混合**；保持 INDEX.md 改名），并复核 gotchas §14 wecom 段契约。

上游无随版本分发的技能工件（官方走 `npx skills add` 拉 repo HEAD、不 pin），vendored 快照是可控可复现的唯一方式——工具 schema 本就由 CLI 服务端动态发现，文档漂移风险低。
