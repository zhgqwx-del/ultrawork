import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"

const invoke = vi.hoisted(() => vi.fn())
vi.mock("@tauri-apps/api/core", () => ({ invoke }))

import {
  PREFERRED_PORTS,
  __resetSidecarPortsForTest,
  acpBaseUrl,
  gatewayBaseUrl,
  knowledgeBaseUrl,
  loadSidecarPorts,
  opencodeBaseUrl,
  sidecarPorts,
} from "@/lib/sidecar-ports"

const DYNAMIC = { opencode: 51234, gateway: 51235, knowledge: 51236, acp: 51237 }

describe("sidecar-ports", () => {
  beforeEach(() => {
    invoke.mockReset()
    __resetSidecarPortsForTest()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe("loadSidecarPorts", () => {
    it("adopts the ports the Tauri host reports", async () => {
      invoke.mockResolvedValue(DYNAMIC)
      await expect(loadSidecarPorts()).resolves.toEqual(DYNAMIC)
      expect(invoke).toHaveBeenCalledWith("get_sidecar_ports")
      expect(sidecarPorts()).toEqual(DYNAMIC)
    })

    // Outside Tauri (vitest, e2e in a plain browser) `invoke` rejects. The gate in
    // main.tsx awaits this promise, so a rejection here would wedge the boot.
    it("falls back to the preferred ports instead of rejecting", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {})
      invoke.mockRejectedValue(new Error("not running in Tauri"))
      await expect(loadSidecarPorts()).resolves.toEqual(PREFERRED_PORTS)
      expect(sidecarPorts()).toEqual(PREFERRED_PORTS)
    })

    // Rejection is not the only failure mode. The e2e Tauri shim answers unknown
    // commands with `null`, and an older host would omit the command entirely.
    // Adopting that verbatim puts `undefined` into every base URL and crashes the
    // first backend construction — a real blank-page bug this suite now pins.
    it.each([
      ["null (the e2e shim's answer for an unknown command)", null],
      ["undefined", undefined],
      ["a non-object", "4096"],
      ["a partial object", { opencode: 4096, gateway: 4097 }],
      ["a non-numeric port", { opencode: "4096", gateway: 4097, knowledge: 4098, acp: 4099 }],
      ["an out-of-range port", { opencode: 0, gateway: 4097, knowledge: 4098, acp: 4099 }],
    ])("falls back when the host resolves %s", async (_label, response) => {
      vi.spyOn(console, "warn").mockImplementation(() => {})
      invoke.mockResolvedValue(response)
      await expect(loadSidecarPorts()).resolves.toEqual(PREFERRED_PORTS)
      expect(sidecarPorts()).toEqual(PREFERRED_PORTS)
    })
  })

  // import.meta.env.DEV is true under vitest: opencode/gateway/knowledge go through
  // the Vite proxy and must stay relative regardless of the resolved port, while the
  // ACP sidecar has no proxy entry and is always absolute.
  describe("base URLs in DEV", () => {
    beforeEach(() => __resetSidecarPortsForTest(DYNAMIC))

    it("keeps the proxied sidecars relative", () => {
      expect(opencodeBaseUrl()).toBe("")
      expect(gatewayBaseUrl()).toBe("/channel")
      expect(knowledgeBaseUrl()).toBe("/kb")
    })

    it("points the ACP sidecar at the resolved port", () => {
      expect(acpBaseUrl()).toBe(`http://localhost:${DYNAMIC.acp}`)
    })

    // The negative direction: assertions that only pin the relative strings would
    // pass even if the resolved ports were being ignored everywhere.
    it("tracks the resolved ACP port rather than the preferred one", () => {
      expect(acpBaseUrl()).not.toBe(`http://localhost:${PREFERRED_PORTS.acp}`)
      __resetSidecarPortsForTest()
      expect(acpBaseUrl()).toBe(`http://localhost:${PREFERRED_PORTS.acp}`)
    })
  })
})
