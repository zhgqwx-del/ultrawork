// Credential resolution: env overrides beat the persisted sidecar-auth file.

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getOpencodePassword } from "../opencode-credentials.js"

const ENV_KEYS = ["OPENCODE_SERVER_PASSWORD", "ULTRAWORK_SIDECAR_PASSWORD", "XDG_CONFIG_HOME"] as const
const saved: Record<string, string | undefined> = {}
let configHome: string

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  configHome = mkdtempSync(join(tmpdir(), "uw-config-"))
  process.env.XDG_CONFIG_HOME = configHome
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  rmSync(configHome, { recursive: true, force: true })
})

function writeAuthFile(password: string) {
  const dir = join(configHome, "ultrawork")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "sidecar-auth.json"), JSON.stringify({ username: "opencode", password }))
}

describe("getOpencodePassword", () => {
  it("prefers OPENCODE_SERVER_PASSWORD", () => {
    process.env.OPENCODE_SERVER_PASSWORD = "from-host"
    process.env.ULTRAWORK_SIDECAR_PASSWORD = "from-ci"
    writeAuthFile("from-file")
    expect(getOpencodePassword()).toBe("from-host")
  })

  it("falls back to ULTRAWORK_SIDECAR_PASSWORD", () => {
    process.env.ULTRAWORK_SIDECAR_PASSWORD = "from-ci"
    writeAuthFile("from-file")
    expect(getOpencodePassword()).toBe("from-ci")
  })

  it("reads sidecar-auth.json under XDG_CONFIG_HOME (dev mode)", () => {
    writeAuthFile("from-file")
    expect(getOpencodePassword()).toBe("from-file")
  })

  it("returns undefined when nothing is configured", () => {
    expect(getOpencodePassword()).toBeUndefined()
  })

  it("tolerates a corrupt auth file", () => {
    const dir = join(configHome, "ultrawork")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "sidecar-auth.json"), "{nope")
    expect(getOpencodePassword()).toBeUndefined()
  })
})
