import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock config-store before importing
vi.mock("../config-store.js", () => ({
  loadConfigs: vi.fn(),
  addConfig: vi.fn(),
  removeConfig: vi.fn(),
}))

import { loadConfigs, addConfig, removeConfig } from "../config-store.js"
import { ChannelManager } from "../channel-manager.js"
import type {
  ChannelAdapter,
  ChannelConfig,
  ChannelStatus,
  AdapterFactory,
} from "../types.js"

const mockLoadConfigs = vi.mocked(loadConfigs)
const mockAddConfig = vi.mocked(addConfig)
const mockRemoveConfig = vi.mocked(removeConfig)

function createMockAdapter(config: ChannelConfig): ChannelAdapter {
  let state: "disconnected" | "connected" = "disconnected"
  return {
    type: config.type,
    name: config.name,
    id: config.id,
    connect: vi.fn(async () => { state = "connected" }),
    disconnect: vi.fn(async () => { state = "disconnected" }),
    getStatus: vi.fn(() => ({
      id: config.id,
      type: config.type,
      name: config.name,
      state,
    } as ChannelStatus)),
    sendMessage: vi.fn(async () => {}),
  }
}

const sampleConfig: ChannelConfig = {
  id: "ch_test",
  type: "dingtalk",
  name: "Test",
  clientId: "cid",
  clientSecret: "cs",
  workspaceDir: "/ws",
  autoConnect: false,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockLoadConfigs.mockResolvedValue([])
  mockAddConfig.mockResolvedValue(undefined)
  mockRemoveConfig.mockResolvedValue(undefined)
})

describe("ChannelManager", () => {
  describe("registerFactory", () => {
    it("registers a factory for a type", async () => {
      const manager = new ChannelManager()
      const factory: AdapterFactory = vi.fn(createMockAdapter)
      manager.registerFactory("dingtalk", factory)

      mockLoadConfigs.mockResolvedValue([sampleConfig])
      await manager.init()

      expect(factory).toHaveBeenCalledWith(sampleConfig, expect.any(Function))
    })

    it("logs warning for unregistered type", async () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {})
      const manager = new ChannelManager()
      mockLoadConfigs.mockResolvedValue([sampleConfig])
      await manager.init()

      expect(spy).toHaveBeenCalledWith(expect.stringContaining("No adapter factory"))
      spy.mockRestore()
    })
  })

  describe("init", () => {
    it("loads configs from disk", async () => {
      const manager = new ChannelManager()
      manager.registerFactory("dingtalk", createMockAdapter)
      await manager.init()
      expect(mockLoadConfigs).toHaveBeenCalled()
    })

    it("auto-connects channels with autoConnect=true", async () => {
      const autoConfig = { ...sampleConfig, autoConnect: true }
      mockLoadConfigs.mockResolvedValue([autoConfig])

      const mockAdapter = createMockAdapter(autoConfig)
      const factory = vi.fn(() => mockAdapter)

      const manager = new ChannelManager()
      manager.registerFactory("dingtalk", factory)
      await manager.init()

      // Wait for async auto-connect
      await vi.waitFor(() => {
        expect(mockAdapter.connect).toHaveBeenCalled()
      })
    })

    it("does not auto-connect when autoConnect=false", async () => {
      mockLoadConfigs.mockResolvedValue([sampleConfig])
      const mockAdapter = createMockAdapter(sampleConfig)
      const factory = vi.fn(() => mockAdapter)

      const manager = new ChannelManager()
      manager.registerFactory("dingtalk", factory)
      await manager.init()

      expect(mockAdapter.connect).not.toHaveBeenCalled()
    })
  })

  describe("addChannel", () => {
    it("persists config and creates adapter", async () => {
      const manager = new ChannelManager()
      const factory: AdapterFactory = vi.fn(createMockAdapter)
      manager.registerFactory("dingtalk", factory)

      await manager.addChannel(sampleConfig)

      expect(mockAddConfig).toHaveBeenCalledWith(sampleConfig)
      expect(factory).toHaveBeenCalledWith(sampleConfig, expect.any(Function))
      expect(manager.listConfigs()).toHaveLength(1)
    })

    it("throws on duplicate id", async () => {
      const manager = new ChannelManager()
      manager.registerFactory("dingtalk", createMockAdapter)

      await manager.addChannel(sampleConfig)
      await expect(manager.addChannel(sampleConfig)).rejects.toThrow("already exists")
    })
  })

  describe("removeChannel", () => {
    it("disconnects, removes adapter and config", async () => {
      const manager = new ChannelManager()
      const mockAdapter = createMockAdapter(sampleConfig)
      manager.registerFactory("dingtalk", vi.fn(() => mockAdapter))

      await manager.addChannel(sampleConfig)
      await manager.removeChannel(sampleConfig.id)

      expect(mockAdapter.disconnect).toHaveBeenCalled()
      expect(mockRemoveConfig).toHaveBeenCalledWith(sampleConfig.id)
      expect(manager.listConfigs()).toHaveLength(0)
    })

    it("removes config even when adapter is missing", async () => {
      const manager = new ChannelManager()
      // No factory registered, so no adapter created
      mockLoadConfigs.mockResolvedValue([sampleConfig])
      await manager.init()

      await manager.removeChannel(sampleConfig.id)
      expect(mockRemoveConfig).toHaveBeenCalledWith(sampleConfig.id)
    })
  })

  describe("connectChannel", () => {
    it("connects adapter by id", async () => {
      const manager = new ChannelManager()
      const mockAdapter = createMockAdapter(sampleConfig)
      manager.registerFactory("dingtalk", vi.fn(() => mockAdapter))

      await manager.addChannel(sampleConfig)
      await manager.connectChannel(sampleConfig.id)

      expect(mockAdapter.connect).toHaveBeenCalled()
    })

    it("throws for unknown id", async () => {
      const manager = new ChannelManager()
      await expect(manager.connectChannel("unknown")).rejects.toThrow("not found")
    })
  })

  describe("disconnectChannel", () => {
    it("disconnects adapter by id", async () => {
      const manager = new ChannelManager()
      const mockAdapter = createMockAdapter(sampleConfig)
      manager.registerFactory("dingtalk", vi.fn(() => mockAdapter))

      await manager.addChannel(sampleConfig)
      await manager.disconnectChannel(sampleConfig.id)

      expect(mockAdapter.disconnect).toHaveBeenCalled()
    })

    it("throws for unknown id", async () => {
      const manager = new ChannelManager()
      await expect(manager.disconnectChannel("unknown")).rejects.toThrow("not found")
    })
  })

  describe("getChannelStatus", () => {
    it("returns adapter status", async () => {
      const manager = new ChannelManager()
      manager.registerFactory("dingtalk", createMockAdapter)

      await manager.addChannel(sampleConfig)
      const status = manager.getChannelStatus(sampleConfig.id)

      expect(status).toMatchObject({
        id: sampleConfig.id,
        type: "dingtalk",
        name: "Test",
        state: "disconnected",
      })
    })

    it("returns undefined for unknown id", () => {
      const manager = new ChannelManager()
      expect(manager.getChannelStatus("unknown")).toBeUndefined()
    })
  })

  describe("listStatus", () => {
    it("returns status for all channels", async () => {
      const manager = new ChannelManager()
      manager.registerFactory("dingtalk", createMockAdapter)

      await manager.addChannel(sampleConfig)
      const statuses = manager.listStatus()

      expect(statuses).toHaveLength(1)
      expect(statuses[0].id).toBe(sampleConfig.id)
    })

    it("returns disconnected status for config without adapter", async () => {
      const manager = new ChannelManager()
      // No factory → no adapter, but config exists
      mockLoadConfigs.mockResolvedValue([sampleConfig])
      await manager.init()

      const statuses = manager.listStatus()
      expect(statuses).toHaveLength(1)
      expect(statuses[0].state).toBe("disconnected")
    })
  })

  describe("listConfigs", () => {
    it("returns all configs", async () => {
      const manager = new ChannelManager()
      manager.registerFactory("dingtalk", createMockAdapter)

      await manager.addChannel(sampleConfig)
      const configs = manager.listConfigs()

      expect(configs).toEqual([sampleConfig])
    })
  })

  describe("setMessageHandler", () => {
    it("routes messages through the handler", async () => {
      const handler = vi.fn()
      const manager = new ChannelManager()
      manager.setMessageHandler(handler)

      // Create factory that invokes onMessage callback
      const factory: AdapterFactory = (config, onMessage) => {
        const adapter = createMockAdapter(config)
        // Simulate receiving a message
        setTimeout(() => {
          onMessage({
            chatId: "c1",
            senderId: "s1",
            senderName: "Sender",
            channelType: "dingtalk",
            text: "hello",
            workspaceDir: config.workspaceDir,
            raw: {},
            reply: vi.fn(),
          })
        }, 0)
        return adapter
      }
      manager.registerFactory("dingtalk", factory)
      await manager.addChannel(sampleConfig)

      await vi.waitFor(() => {
        expect(handler).toHaveBeenCalledWith(
          expect.objectContaining({ text: "hello" }),
        )
      })
    })
  })

  describe("shutdown", () => {
    it("disconnects all adapters", async () => {
      const manager = new ChannelManager()
      const mockAdapter = createMockAdapter(sampleConfig)
      manager.registerFactory("dingtalk", vi.fn(() => mockAdapter))

      await manager.addChannel(sampleConfig)
      await manager.shutdown()

      expect(mockAdapter.disconnect).toHaveBeenCalled()
    })

    it("handles disconnect errors gracefully", async () => {
      const manager = new ChannelManager()
      const mockAdapter = createMockAdapter(sampleConfig)
      ;(mockAdapter.disconnect as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("fail"))
      manager.registerFactory("dingtalk", vi.fn(() => mockAdapter))

      await manager.addChannel(sampleConfig)
      // Should not throw
      await manager.shutdown()
    })
  })
})
