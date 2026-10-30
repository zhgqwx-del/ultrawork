// migrateLegacyClaudeAdapter: configs written with the renamed claude adapter
// package are rewritten on load (exact token match; explicit pins respected).

import { describe, it, expect } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { migrateLegacyClaudeAdapter } from "../agents-config.js"
import { configFile, resolveConfigDir } from "../config-paths.js"
import type { AgentsFile } from "../types.js"

const LEGACY = "@zed-industries/claude-code-acp"
const CURRENT = "@agentclientprotocol/claude-agent-acp"

type AgentEntry = NonNullable<AgentsFile["agents"]>[string]

function legacyClaude(overrides: Partial<AgentEntry> = {}): AgentEntry {
  return {
    label: "Claude Code",
    description: `Claude Code via ${LEGACY}`,
    command: "bunx",
    args: ["--bun", LEGACY],
    env: { MAX_THINKING_TOKENS: "8192" },
    ...overrides,
  }
}

describe("migrateLegacyClaudeAdapter", () => {
  it("rewrites the bare legacy package name and the default description", () => {
    const file: AgentsFile = { agents: { claude: legacyClaude() }, default: "claude" }
    expect(migrateLegacyClaudeAdapter(file)).toBe(true)
    expect(file.agents?.claude?.args).toEqual(["--bun", CURRENT])
    expect(file.agents?.claude?.description).toBe(`Claude Code via ${CURRENT}`)
  })

  it("leaves an explicit version pin alone", () => {
    const file: AgentsFile = {
      agents: { claude: legacyClaude({ args: ["--bun", `${LEGACY}@0.16.2`] }) },
    }
    expect(migrateLegacyClaudeAdapter(file)).toBe(false)
    expect(file.agents?.claude?.args).toEqual(["--bun", `${LEGACY}@0.16.2`])
  })

  it("keeps a custom description even when args are migrated", () => {
    const file: AgentsFile = {
      agents: { claude: legacyClaude({ description: "my tuned claude" }) },
    }
    expect(migrateLegacyClaudeAdapter(file)).toBe(true)
    expect(file.agents?.claude?.args).toEqual(["--bun", CURRENT])
    expect(file.agents?.claude?.description).toBe("my tuned claude")
  })

  it("does not touch the legacy default description of an unmigrated agent", () => {
    const file: AgentsFile = {
      agents: {
        claude: legacyClaude(),
        other: legacyClaude({ args: ["some-other-agent"] }),
      },
    }
    expect(migrateLegacyClaudeAdapter(file)).toBe(true)
    expect(file.agents?.other?.description).toBe(`Claude Code via ${LEGACY}`)
    expect(file.agents?.other?.args).toEqual(["some-other-agent"])
  })

  it("reports no change for current configs and unrelated agents", () => {
    const file: AgentsFile = {
      agents: {
        claude: legacyClaude({ args: ["--bun", CURRENT], description: `Claude Code via ${CURRENT}` }),
        gemini: { label: "Gemini", command: "gemini", args: ["acp"] },
      },
    }
    expect(migrateLegacyClaudeAdapter(file)).toBe(false)
  })

  it("tolerates empty/missing agents", () => {
    expect(migrateLegacyClaudeAdapter({ agents: {} })).toBe(false)
    expect(migrateLegacyClaudeAdapter({} as AgentsFile)).toBe(false)
  })
})

describe("resolveConfigDir", () => {
  it("honors a non-empty XDG_CONFIG_HOME (mirrors Rust global_config_dir)", () => {
    expect(resolveConfigDir({ XDG_CONFIG_HOME: "/tmp/xdg" })).toBe(join("/tmp/xdg", "ultrawork"))
  })

  it("falls back to ~/.config when XDG_CONFIG_HOME is unset or empty", () => {
    const fallback = join(homedir(), ".config", "ultrawork")
    expect(resolveConfigDir({})).toBe(fallback)
    expect(resolveConfigDir({ XDG_CONFIG_HOME: "" })).toBe(fallback)
  })

  it("configFile places every config file under the same resolved dir", () => {
    // agents.json / gemini-acp-settings.json / sidecar-auth.json must all share
    // one isolation namespace — they go through this single helper.
    const env = { XDG_CONFIG_HOME: "/tmp/xdg" }
    for (const name of ["agents.json", "gemini-acp-settings.json", "sidecar-auth.json"]) {
      expect(configFile(name, env)).toBe(join("/tmp/xdg", "ultrawork", name))
    }
    expect(configFile("agents.json", {})).toBe(join(homedir(), ".config", "ultrawork", "agents.json"))
  })
})

describe("metaSystemPrompt configuration roundtrip", () => {
  it("retains true, false and automatic detection through REST, disk and reload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-config-roundtrip-"))
    const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: dir }
    for (const key of ["ULTRAWORK_BRAND_CONTEXT", "ULTRAWORK_BRAND_CONTEXT_FILE", "ULTRAWORK_BRAND_MANAGED", "OPENCODE_APP_NAME"]) delete env[key]
    try {
      // The registry captures its path at import. A fresh process guarantees
      // all actual read/write operations resolve inside this fixture directory.
      const script = `
        import * as config from ${JSON.stringify(new URL("../agents-config.ts", import.meta.url).href)};
        import { createServer } from ${JSON.stringify(new URL("../acp-server.ts", import.meta.url).href)};
        import { readFileSync, writeFileSync } from "node:fs";
        const app = createServer({
          saveAgent: agent => config.saveAgentConfig(agent),
          getAgentConfig: id => config.loadAgentConfigs().find(agent => agent.id === id),
        }, null);
        const records = [];
        for (const value of [true, false, undefined]) {
          const id = "custom-" + (value ?? "auto");
          const response = await app.request("/acp/agents/" + id, {
            method: "PUT", headers: { "content-type": "application/json" },
            body: JSON.stringify({ label: "Custom", command: "fixture-agent", metaSystemPrompt: value }),
          });
          const loaded = await app.request("/acp/agents/" + id + "/config");
          const stored = JSON.parse(readFileSync(config.agentsConfigPath(), "utf8"));
          const edited = await app.request("/acp/agents/" + id, {
            method: "PUT", headers: { "content-type": "application/json" },
            body: JSON.stringify({ label: "Edited label", command: "fixture-agent" }),
          });
          records.push({ status: response.status,
            disk: stored.agents[id].metaSystemPrompt ?? "auto",
            reload: config.loadAgentConfigs().find(agent => agent.id === id).metaSystemPrompt ?? "auto",
            api: (await loaded.json()).metaSystemPrompt ?? "auto",
            edited: edited.status });
        }
        const invalid = [];
        for (const value of ["false", 1, null]) {
          const response = await app.request("/acp/agents/custom", {
            method: "PUT", headers: { "content-type": "application/json" },
            body: JSON.stringify({ label: "Custom", command: "fixture-agent", metaSystemPrompt: value }),
          });
          invalid.push(response.status);
        }
        const rejected = [];
        for (const value of ["false", 1, null]) {
          writeFileSync(config.agentsConfigPath(), JSON.stringify({ agents: { bad: { label: "Bad", command: "fixture", metaSystemPrompt: value } } }));
          try { config.loadAgentConfigs(); rejected.push(false); }
          catch (error) { rejected.push(error.message.includes("metaSystemPrompt must be a boolean")); }
        }
        console.log(JSON.stringify({ path: config.agentsConfigPath(), records, invalid, rejected }));
      `
      const child = Bun.spawn([process.execPath, "--eval", script], { env, stdout: "pipe", stderr: "pipe" })
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      expect(stderr).toBe("")
      expect(code).toBe(0)
      const result = JSON.parse(stdout)
      expect(result.path).toBe(join(dir, "ultrawork", "agents.json"))
      expect(result.records).toEqual([true, false, "auto"].map(value => ({ status: 200, disk: value, reload: value, api: value, edited: 200 })))
      expect(result.invalid).toEqual([400, 400, 400])
      expect(result.rejected).toEqual([true, true, true])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
