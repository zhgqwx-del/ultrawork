import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

const invoke = vi.hoisted(() => vi.fn())
vi.mock("@tauri-apps/api/core", () => ({ invoke }))

import {
  __setSidecarCredentialsForTest,
  loadSidecarCredentials,
  sidecarAuthHeaders,
} from "@/lib/sidecar-auth"

describe("sidecar-auth", () => {
  beforeEach(() => {
    invoke.mockReset()
    __setSidecarCredentialsForTest(null)
  })
  afterEach(() => vi.restoreAllMocks())

  describe("loadSidecarCredentials", () => {
    it("adopts the credentials the host reports", async () => {
      invoke.mockResolvedValue({ username: "opencode", password: "s3cret" })
      await expect(loadSidecarCredentials()).resolves.toEqual({ username: "opencode", password: "s3cret" })
      expect(invoke).toHaveBeenCalledWith("get_sidecar_credentials")
    })

    // Same trap as get_sidecar_ports: the e2e Tauri shim answers `null` for an unknown
    // command rather than throwing. Adopting that would put "undefined:undefined" into
    // every Authorization header.
    it.each([
      ["a rejection (not running in Tauri)", undefined, new Error("no tauri")],
      ["null", null, undefined],
      ["a non-object", "s3cret", undefined],
      ["a missing password", { username: "opencode" }, undefined],
      ["an empty password", { username: "opencode", password: "" }, undefined],
      ["a non-string password", { username: "opencode", password: 123 }, undefined],
    ])("yields no credential on %s", async (_label, resolved, rejected) => {
      vi.spyOn(console, "warn").mockImplementation(() => {})
      if (rejected) invoke.mockRejectedValue(rejected)
      else invoke.mockResolvedValue(resolved)

      await expect(loadSidecarCredentials()).resolves.toBeNull()
      expect(sidecarAuthHeaders()).toEqual({})
    })

    it("never rejects — the startup gate awaits it", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {})
      invoke.mockRejectedValue(new Error("boom"))
      await expect(loadSidecarCredentials()).resolves.toBeNull()
    })
  })

  describe("sidecarAuthHeaders", () => {
    it("encodes user:password as Basic", () => {
      __setSidecarCredentialsForTest({ username: "opencode", password: "s3cret" })
      expect(sidecarAuthHeaders()).toEqual({ Authorization: `Basic ${btoa("opencode:s3cret")}` })
    })

    it("honours a non-default username", () => {
      __setSidecarCredentialsForTest({ username: "alice", password: "pw" })
      expect(sidecarAuthHeaders()).toEqual({ Authorization: `Basic ${btoa("alice:pw")}` })
    })

    // The negative direction: returning a header with an empty credential would look
    // like auth while always 401-ing.
    it("returns no header at all when there is no credential", () => {
      __setSidecarCredentialsForTest(null)
      expect(sidecarAuthHeaders()).toEqual({})
      expect(sidecarAuthHeaders().Authorization).toBeUndefined()
    })
  })
})
