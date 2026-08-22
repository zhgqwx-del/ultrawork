# Desktop e2e harnesses

Browser-driven walkthroughs that exercise the **real** desktop app (Vite + system
Chrome via `playwright-core`, with a Tauri `invoke` shim) against real sidecars —
catching integration bugs that vitest can't.

## `message-timestamp.e2e.ts` — 用户消息发送时间 + 三处时间格式统一

Guards the sent-at timestamp under the user bubble and the single shared formatter
behind it (`src/lib/format-time.ts`, used by the bubble, the assistant turn footer
and the sidebar tooltip). Real (mock-driven) **opencode** + Vite + a real engine.

The turn is created over **HTTP** (`POST /session` → `prompt_async`) instead of by
typing, so the run does not hinge on keyboard input reaching the app page; the
assertions then compare the DOM against the server's own `info.time.created`
rather than against "some time is displayed".

Covers: `<time datetime>` === the server epoch · the visible text follows the **UI
language** (not the OS locale) and differs from en-US's · the assistant footer uses
the same format · a **warm-cache** locale switch doesn't bleed between languages ·
a **live** language switch through the settings popover (no reload, no remount —
the only arrangement that can catch a missing `useMemo` dep) re-formats both ·
hover reveals copy with **zero layout shift** · a 420px window doesn't overflow ·
dark-mode contrast measured from the RENDERED colors (≥ AA at 10px, no `opacity`).

```bash
cd packages/client/desktop
bun run --bun e2e:message-timestamp                    # exit 0 = PASS
E2E_ENGINE=webkit bun run --bun e2e:message-timestamp  # WKWebView = the macOS runtime
```

**Negative control** (built in, run it after touching any of this):
`E2E_BREAK=wiring bun run --bun e2e:message-timestamp` drops MessageList's
`createdAt` hand-off, runs, and restores the file — 11 of the 15 checks must go
red. If they don't, the harness has stopped measuring. (One earlier version had a
check that compared `null === null` when the element was absent, so it passed
inside the control arm — the arm is what caught it.)

## `switchback-gap.e2e.ts` — switch-back streamed-text gap (ADR/discussions 022, Issue 1)

Verifies that switching away from a streaming opencode turn and back loses **no**
answer text. Uses [`mock-llm.ts`](./mock-llm.ts) (an OpenAI-compatible server that
streams marker tokens `M001 M002 …`) to drive a **real opencode** turn — opencode
has the incremental-persistence lag that causes the bug, so it's the only path
that can reproduce it (the ACP path folds history synchronously and is immune).

Flow: send a prompt → stream starts → SPA-navigate to Home for 3s (markers keep
streaming server-side) → navigate back → assert the answer's marker sequence is
**contiguous** (no gap) right after switch-back and again at completion.

```bash
cd packages/client/desktop
bun run --bun e2e:switchback        # exit 0 = PASS, 1 = FAIL
```

Requirements: system Chrome (used via `channel:"chrome"`, no chromium download);
built sidecar binaries in `src-tauri/binaries` (`bun run --bun scripts/build-opencode.ts`).
Isolated per run: temp `HOME`/`XDG`, temp workspace, random sidecar password;
standard ports 4096/1420 (kill stragglers first if a prior run crashed).

**Negative control** (proves the harness detects the bug — not run by default):
temporarily no-op the global message-cache listener in `src/lib/use-sessions.ts`
(`applyMessageEventToCache`); the harness then reports a gap (`firstGap != null`)
at switch-back, healed only at completion — exactly the original symptom.

## `meta-passthrough.e2e.ts` — opencode forwards sessionID via MCP `_meta` (ADR-035)

Guards the opencode vendor patch that tags delegates with their owner (leader)
session so two Teams in one workspace never cross-show. Real (patched) **opencode**
+ [`mock-llm-toolcall.ts`](./mock-llm-toolcall.ts) (emits one tool_call) +
[`stub-mcp.ts`](./stub-mcp.ts) (echoes the call's `_meta`). Asserts the tool
result's `_meta.ultrawork_session === ` the session id.

```bash
cd packages/client/desktop
bun run --bun e2e:meta              # exit 0 = PASS, 1 = FAIL
```

If an opencode bump silently drops the patch (`session/llm.ts`
`experimental_context` or `mcp/index.ts` `_meta` injection), this flips to FAIL —
that's why it's kept. Same isolation as above (temp `HOME`/`XDG`, port 4096).

## `mcp-status-dynamic.e2e.ts` — `MCP.status()` surfaces dynamically-added MCPs

Guards the vendor patch (`mcp/index.ts` `MCP.status()`) that includes runtime
`s.status` entries not yet in the persisted config, so a server registered via
`POST /mcp` is visible in `GET /mcp`. Pure-HTTP (no browser): real (patched)
**opencode** with an **empty** mcp config → `POST /mcp` registers `knowledge-base`
at the real knowledge-sidecar → asserts `GET /mcp` now shows it (only the patch
can surface it, since config is empty). Bonus: asserts `status==="connected"`,
re-confirming the knowledge-sidecar `mcp-stdio` stays alive under opencode's
held-open stdin (so no keep-alive hack is needed).

```bash
cd packages/client/desktop
bun run --bun e2e:mcp-status        # exit 0 = PASS, 1 = FAIL
```

Isolated: temp `HOME`/`XDG`, non-standard port 4196 (avoids a running dev app).

## `kb-mcp-autoregister.e2e.ts` — IMA/remote-only KB auto-registers its MCP

Browser walkthrough of the `fix/knowledge-mcp-ima-autoregister` fix. Seeds an
`ima` source directly via `POST /kb/sources` (the add-source-dialog path — no
folder, no MCP registration), boots opencode with an **empty** mcp config, then
drives real Chrome → Settings → Knowledge Base so the real `useKnowledgeBase()`
auto-restore effect runs against real sidecars. Asserts opencode `GET /mcp` shows
`knowledge-base === connected`. The Tauri-invoke shim provides the real
knowledge-sidecar path for `get_sidecar_path`; `write_mcp_config` is a no-op (the
assertion is the runtime registration, not the persisted file).

```bash
cd packages/client/desktop
bun run --bun e2e:kb-autoregister   # exit 0 = PASS, 1 = FAIL
```

Negative control: revert the auto-restore effect in `use-knowledge-base.ts` and
the harness FAILs (knowledge-base never registered) — exactly the original bug.
Same isolation (temp `HOME`/`XDG`, ports 4096/4098/1420).

## `kb-mcp-restart-persist.e2e.ts` — persisted KB MCP survives an app restart

The persistence half of the fix. After `registerKnowledgeMCP` writes the entry to
the global `opencode.json` (what the Rust `write_mcp_config` command does), a FRESH
OpenCode process must auto-connect the knowledge-base MCP on boot from that config
— so the one-time auto-restore registration keeps working across restarts with no
UI involvement. Pure-HTTP: boot opencode (empty config) → mirror `write_mcp_config`
into `root.mcp` → kill opencode → restart on the same config → assert `GET /mcp`
shows `knowledge-base === connected` with no `POST /mcp`.

```bash
cd packages/client/desktop
bun run --bun e2e:kb-restart        # exit 0 = PASS, 1 = FAIL
```

Isolated: temp `HOME`/`XDG`, non-standard port 4296.

## `builtin-skill-shadowing.e2e.ts` — builtin-vs-user same-name shadowing (ADR-040 阶段 2)

The opencode half of the deterministic-shadowing proof (the Rust half —
`reconcile_builtin_shadowing` prune/restore — is covered by cargo tests).
Against a real opencode: (A) both same-name copies on disk collapse to ONE
arbitrary winner (the race reconcile exists to prevent — logged, not asserted);
(B) after the prune state (builtin copy removed) + `POST /global/refresh` the
USER version is served immediately; (C) after the restore state (user removed,
builtin recopied) the builtin returns — all live, no restart (ADR-039).

```bash
cd packages/client/desktop
bun run --bun e2e:builtin-shadowing   # exit 0 = PASS, 1 = FAIL
```

Isolated: temp `HOME`/`XDG`, non-standard port 4302.

## `builtin-shadow-ui.e2e.ts` — shadow-state Settings UI + restore flow

Real React app (Chrome + Vite + real opencode). Fixture = the `pdf` builtin
(Apache upstream + ultrawork patch — the shadow card's "raw upstream without the
built-in copy's bundled patches" copy fits it). The two Tauri commands are
shimmed onto a local helper HTTP server (port 4977) that performs REAL fs
mutations mirroring the Rust reconcile, so the restore flow exercises a real
opencode rescan: shadow card (overridden badge + raw-upstream copy + restore
button) → custom tab shows the user copy → confirm dialog → fs truth asserted →
builtin card back with the upstream description. (The catalog Installed→Install /
`--method git` cross-checks were dropped in P3 — ppt-master, the only skill that
was both bundled AND a curated catalog entry, left the bundle, so that dual-role
scenario no longer exists; catalog rendering is covered by settings-skills.test.tsx
+ settings-tabs-ui-walkthrough.e2e.ts.)

```bash
cd packages/client/desktop
bun run --bun e2e:builtin-shadow-ui   # exit 0 = PASS, 1 = FAIL
```

Standard ports 4096/1420 (kill a running dev instance first, like
builtin-deckcraft-ui).

## `deckcraft-routing-realmodel.e2e.ts` — REAL-MODEL: 做PPT routes to deckcraft (ADR-061 P3)

Pure HTTP against a real opencode + real qwen3.7-max (DashScope; needs a `myqwen`
key in `~/.local/share/ultrawork/auth.json`, like the other `*-realmodel` tests).
Proves the P3 core claim that structural tests can't: given a plain "做PPT" prompt
(no skill name), a real model — reading deckcraft's widened description in the
`skill` tool's list — actually calls `skill({name:"deckcraft"})`. Asserts GET /skill
lists deckcraft and NOT ppt-master, then stops at the routing decision (does not run
the full deck pipeline). Override the intent with `ROUTE_PROMPT="..."` to spot-check
trigger breadth (中文 PPT / English slide deck / 幻灯片 all route to deckcraft).

```bash
cd packages/client/desktop
bun run --bun e2e:deckcraft-routing   # exit 0 = PASS, 1 = FAIL
```

Isolated: temp `HOME`/`XDG`, port 4306 (override `ROUTE_PORT`).

## `deckcraft-fullpipeline-realmodel.e2e.ts` — REAL-MODEL end-to-end deck build (ADR-061)

The full model-authored flow the routing test stops short of: drives real qwen3.7-max
from a plain "做PPT" prompt through skill-load → project → the two question rounds →
outline → gates → per-page generation → `deck.html`, while a background autopilot
auto-approves every permission and auto-answers each question (picks the first option).
Asserts a valid multi-page `deck.html` is produced. Verifies FLOW + STRUCTURE, not
visual quality (human judgment) and not the final --pdf/--pptx export (covered by
deckcraft-selftest + the examples gate chain). SLOW — drives a real model through a
whole deck (minutes). Needs the same `myqwen` key as the other `*-realmodel` tests.

```bash
cd packages/client/desktop
bun run --bun e2e:deckcraft-fullpipeline   # exit 0 = PASS, 1 = FAIL
```

Isolated: temp `HOME`/`XDG`, port 4311 (override `ROUTE_PORT`).

## `websearch-byok.e2e.ts` — BYOK websearch ladder against real opencode (ADR-042)

Real (patched) opencode + in-process stub Tavily/IQS HTTP server (endpoints
overridden via `ULTRAWORK_TAVILY_BASE_URL` / `ULTRAWORK_ALIYUN_IQS_BASE_URL`) +
in-process mock OpenAI-compatible LLM that records every request's `tools[]` and
emits a `websearch` tool_call when the tool is present. 15 checks: no key → tool
absent; `PUT /auth/search-tavily` → tool appears next prompt (auth.json read
fresh, no refresh) + Bearer key reaches the stub + formatted results reach the
answer; `GET /global/auth/:id/status` flips; explicit `provider:"aliyun-iqs"`
via `PATCH /global/config?refresh=soft` routes to IQS (body shape asserted);
`provider:"auto"` clears the explicit choice; `enabled:false` (soft) hides the
tool again.

```bash
cd packages/client/desktop
bun run --bun e2e:websearch   # exit 0 = PASS, 1 = FAIL
```

Isolated: temp `HOME`/`XDG`, ports 4103 (opencode) / 8092 (LLM) / 8093 (stub).

## `websearch-ui-walkthrough.e2e.ts` — Tools settings + per-model toggle, real browser (ADR-042)

Real React app (Chrome + Vite + real patched opencode) walking the whole BYOK
websearch surface with DISK-truth assertions after every step: Tools section
renders → test disabled without key → wrong key hits the CORS-enabled stub and
surfaces the auth toast (the `test_search_provider` Tauri shim does a REAL HTTP
round-trip with the entered key, classified like the Rust command) → save lands
`search-tavily`/`search-aliyun-iqs` in auth.json + chips flip + input clears →
default-provider Select options track configured state → Exa advanced opt-in →
master enable round-trip → remove-key confirm flow cleans auth.json AND resets a
stale preferred provider to "auto" → models-section per-model 联网搜索 toggle
writes `enable_search` true→false into the global opencode.json.

```bash
cd packages/client/desktop
bun run --bun e2e:websearch-ui   # exit 0 = PASS, 1 = FAIL
```

Standard ports 4096/1420 (kill a running dev instance first) + stub on 8095.

## `html-preview-iframe.e2e.ts` — in-app HTML preview iframe, both shipping engines

Engine-level proof for the artifact preview's in-app HTML rendering: a REAL
self-contained deckcraft `deck.html` fed to the exact `<iframe srcDoc={content}
sandbox="allow-scripts">` markup the component emits, run on **both** engines
Tauri ships — Chromium (Windows WebView2) and WebKit (macOS WKWebView / Linux
WebKitGTK) — so the two together cover all three platforms' renderers. Asserts:
deck renders (all slides) → the deck's inline fit script RAN under
`allow-scripts` (no `allow-same-origin` needed) → sandbox isolation holds (opaque
origin; parent DOM + a parent-exposed `window.__TAURI__` both throw
SecurityError) → control with `sandbox=""` proves the fit-script assertion
discriminates. The vitest `artifact-preview-html.test.tsx` covers the
complementary half (the real component emits that iframe + the preview⇄source
toggle).

```bash
cd packages/client/desktop
bun run --bun e2e:html-preview   # exit 0 = PASS, 1 = FAIL
```

Self-contained — NO opencode server, NO model, NO auth key. Needs system Chrome
and/or the bundled WebKit; each engine is skipped (not failed) if it can't launch.

## 数学公式三件套：`math-css-layout` / `math-render-realapp` / `im-math-degrade`（ADR-070）

三个 harness 分别守住渲染链路的一段，缺一段就有验不到的东西：

| harness | 覆盖 | 为什么单测不行 |
|---|---|---|
| `math-css-layout.e2e.ts`（`e2e:math-css`） | **真实打包 CSS** 下的字体请求、`.katex-display` 溢出（W1）、拖蓝选中不含 LaTeX 源码（W3） | jsdom 没有布局引擎、不加载字体 |
| `math-render-realapp.e2e.ts`（`e2e:math-real`） | mock-llm-math → 真 opencode → 真 `MarkdownContent` → 真浏览器：一次真实流式回合里公式是否渲染、流式抖动幅度（W2） | 前者用手工 HTML，从没跑过 React 与真实 turn |
| `im-math-degrade.e2e.ts`（`e2e:im-math`） | 同一份 mock 回答走 **IM 出站**：真 SSE → 真 BlockChunker → 真 `bridge.send()` → 抓到的四家 adapter 文本 | 单测直接调降级函数，不经过分块、串流与出站漏斗 |
| `im-math-sidecar-blackbox.e2e.ts`（`e2e:im-math-blackbox`） | **编译后的 sidecar 二进制**（客户真正装到机器上的那个）：真 ChannelManager + 真微信 adapter + Bridge + `stripMarkdown`，断言打在它真实 POST 出去的 HTTP 报文上 | 前三个都 import 源码；`bun build --compile` 的打包层（依赖内联、正则特性、模块解析）从源码完全看不见 |

后两个刻意共用 `mock-llm-math.ts` 的同一份回答，所以它们是**同一输入的真 A/B**：桌面端渲染成排版、IM 端降级成 Unicode，两边对同一份语料负责。

```bash
cd packages/client/desktop
bun run --bun e2e:math-css      # 支持 E2E_ENGINE=webkit
bun run --bun e2e:math-real     # 支持 E2E_ENGINE=webkit
bun run --bun e2e:im-math       # 无浏览器，纯 gateway 链路（进程内 Bridge）
bun run --bun e2e:im-math-blackbox  # 黑盒：跑编译后的 sidecar 二进制，抓真实出站报文
```

> **非空转自检是硬要求**（conventions §19）：三个 harness 里凡「X 不存在」类断言都配了前置的非空转门。`im-math-degrade` 首次运行时 opencode 少配了 `OPENCODE_APP_NAME`，回合直接报错，4 条断言在一句 51 字符的错误消息上全绿 —— 现在 check 0 不过就 `exit 1`，不给出绿色的假报告。

## `orchestration-worktree.e2e.ts` — worktree 隔离的三条回收分支

守 2026-07-30 修的那个泄漏：`createWorktree` 建 `<root>/<runId>/<stepId>` 两层，
而 `removeWorktree` 只回收 `<stepId>` 那层 ⇒ **每个用过 worktree 隔离的 run 永久
留下一个空目录**（71 分钟 soak / 523 run 实测残留 168 个、166 个全空、重启不回收）。

`worktree.test.ts` 直接调 `removeWorktree`，证的是函数契约；这个 e2e 证的是
**orchestrator 真实分支 + fan-out 并行形状**——两者缺一不可：

| 分支 | 期望 |
|---|---|
| A 5 个 worker 并行、全成功 | run 目录被回收（含非空转门：峰值真有 5 个 worktree 并存） |
| B 某 worker 不写产物 | 该 worktree **保留**供排查，run 目录存活 |
| C 中途取消 | 取消路径拆掉 worktree，run 目录被回收 |

**为什么必须是 fan-out**：Pipeline tab 的扇出模式给每个 worker 相同的 `inputs`，
它们**并行**起多个 worktree；串行链 recipe（`inputs:["s0"]`）永远产生不了这个形状，
soak 当初就是这么漏掉并发场景的。

```bash
cd packages/client/desktop
bun run --bun e2e:orch-worktree      # E2E_VERBOSE=1 转发 sidecar/mock 日志
```

需要已构建的 opencode + acp-client sidecar 与 git。隔离：临时 HOME/XDG，端口 4696/4699/8696。

> **两个踩过的坑，都会伪装成「turn timed out」**：
> ① `Bun.spawn` 用 `stdout:"pipe"` 却不读 ⇒ 管道满后子进程阻塞（`plan` 输出少能过，
>   5 个并发 worker 全卡死）。要么 drain，要么别建管道。
> ② **临时根目录必须 `realpathSync`**：macOS 上 `/var`→`/private/var`，而
>   `worktreesRoot()` 原样派生自 `XDG_DATA_HOME` ⇒ worker 的产物路径（`/var/...`）
>   与它自己被 opencode 解析过的 cwd（`/private/var/...`）对不上，写入被当作越出沙箱，
>   工具调用永不返回。
