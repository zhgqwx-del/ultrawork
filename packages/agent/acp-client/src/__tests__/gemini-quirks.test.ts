// applyGeminiQuirks: env defaults + managed settings provisioning for
// @google/gemini-cli agents (see the quirk block in acp-connection.ts).

import { describe, it, expect } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyGeminiQuirks } from "../acp-connection.js"

function withTmpSettings(fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "gemini-quirks-"))
  try {
    fn(join(dir, "settings.json"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("applyGeminiQuirks", () => {
  it("injects defaults and provisions the settings file for gemini agents", () => {
    withTmpSettings((settingsPath) => {
      const env: Record<string, string | undefined> = {}
      applyGeminiQuirks(
        { command: "bunx", args: ["@google/gemini-cli", "--experimental-acp"] },
        env,
        settingsPath,
      )
      expect(env.GEMINI_CLI_TRUST_WORKSPACE).toBe("true")
      expect(env.GEMINI_CLI_NO_RELAUNCH).toBe("true")
      expect(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBe(settingsPath)
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"))
      expect(settings.tools.shell.enableInteractiveShell).toBe(false)
    })
  })

  it("recognizes a bare global gemini binary", () => {
    withTmpSettings((settingsPath) => {
      const env: Record<string, string | undefined> = {}
      applyGeminiQuirks({ command: "gemini", args: ["--experimental-acp"] }, env, settingsPath)
      expect(env.GEMINI_CLI_TRUST_WORKSPACE).toBe("true")
    })
  })

  it("never overrides explicit agent env", () => {
    withTmpSettings((settingsPath) => {
      const config = {
        command: "bunx",
        args: ["@google/gemini-cli", "--experimental-acp"],
        env: {
          GEMINI_CLI_TRUST_WORKSPACE: "false",
          GEMINI_CLI_NO_RELAUNCH: "false",
          GEMINI_CLI_SYSTEM_SETTINGS_PATH: "/elsewhere.json",
        },
      }
      const env: Record<string, string | undefined> = { ...config.env }
      applyGeminiQuirks(config, env, settingsPath)
      expect(env.GEMINI_CLI_TRUST_WORKSPACE).toBe("false")
      expect(env.GEMINI_CLI_NO_RELAUNCH).toBe("false")
      expect(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBe("/elsewhere.json")
      expect(existsSync(settingsPath)).toBe(false)
    })
  })

  it("leaves an existing settings file untouched (user-customizable)", () => {
    withTmpSettings((settingsPath) => {
      writeFileSync(settingsPath, '{"custom": true}\n')
      const env: Record<string, string | undefined> = {}
      applyGeminiQuirks({ command: "gemini", args: [] }, env, settingsPath)
      expect(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBe(settingsPath)
      expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({ custom: true })
    })
  })

  it("does nothing for non-gemini agents", () => {
    withTmpSettings((settingsPath) => {
      const env: Record<string, string | undefined> = {}
      applyGeminiQuirks({ command: "qodercli", args: ["--acp"] }, env, settingsPath)
      expect(env.GEMINI_CLI_TRUST_WORKSPACE).toBeUndefined()
      expect(existsSync(settingsPath)).toBe(false)
    })
  })
})
