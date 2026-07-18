# Desktop e2e harnesses

Browser-driven walkthroughs that exercise the **real** desktop app (Vite + system
Chrome via `playwright-core`, with a Tauri `invoke` shim) against real sidecars —
catching integration bugs that vitest can't.

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
