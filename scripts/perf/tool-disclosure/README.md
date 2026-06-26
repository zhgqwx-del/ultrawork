# Progressive Tool Disclosure — engine tests (ADR-036 / discussions/023)

Drive the disclosure plugin (`vendor/opencode/.../plugin/tool-disclosure.ts`) hooks
directly — no model/server needed. Requires the vendor patch applied (`./setup.sh`).

```bash
bun run scripts/perf/tool-disclosure/disclosure-comp-test.ts          # collapse/policy/concurrency/demotion/return-shape (23)
ULTRAWORK_DISCLOSE_MAX_SESSIONS=2 ULTRAWORK_DISCLOSE_TTL_MS=60 \
  bun run scripts/perf/tool-disclosure/disclosure-lifecycle-test.ts   # TTL + LRU cleanup (3)
```
