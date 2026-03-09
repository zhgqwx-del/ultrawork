import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock fs/promises before importing
vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}))

import { readFile, writeFile, mkdir } from "fs/promises"
import { loadConfigs, addConfig, removeConfig, updateConfig } from "../config-store.js"
import type { ChannelConfig } from "../types.js"

const mockReadFile = vi.mocked(readFile)
const mockWriteFile = vi.mocked(writeFile)
const mockMkdir = vi.mocked(mkdir)

const sampleConfig: ChannelConfig = {
  id: "ch_abc123",
  type: "dingtalk",
  name: "Test Channel",
  clientId: "client-id",
  clientSecret: "client-secret",
  workspaceDir: "/workspace",
  autoConnect: true,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockWriteFile.mockResolvedValue(undefined)
  mockMkdir.mockResolvedValue(undefined as any)
})

describe("loadConfigs", () => {
  it("returns channels from valid JSON file", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ channels: [sampleConfig] }))
    const result = await loadConfigs()
    expect(result).toEqual([sampleConfig])
  })

  it("returns empty array when file does not exist", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"))
    const result = await loadConfigs()
    expect(result).toEqual([])
  })

  it("returns empty array when JSON is invalid", async () => {
    mockReadFile.mockResolvedValue("not json")
    const result = await loadConfigs()
    expect(result).toEqual([])
  })

  it("returns empty array when channels field is missing", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({}))
    const result = await loadConfigs()
    expect(result).toEqual([])
  })

  it("reads from ~/.ultrawork/channels.json", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ channels: [] }))
    await loadConfigs()
    expect(mockReadFile).toHaveBeenCalledWith(
      expect.stringContaining("channels.json"),
      "utf-8",
    )
  })
})

describe("addConfig", () => {
  it("adds config to empty store", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ channels: [] }))
    await addConfig(sampleConfig)
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining("channels.json"),
      expect.stringContaining(sampleConfig.id),
      "utf-8",
    )
  })

  it("appends config to existing store", async () => {
    const existing: ChannelConfig = { ...sampleConfig, id: "ch_existing" }
    mockReadFile.mockResolvedValue(JSON.stringify({ channels: [existing] }))
    await addConfig(sampleConfig)
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string)
    expect(written.channels).toHaveLength(2)
    expect(written.channels[1].id).toBe(sampleConfig.id)
  })

  it("throws on duplicate id", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ channels: [sampleConfig] }))
    await expect(addConfig(sampleConfig)).rejects.toThrow("already exists")
  })

  it("creates directory before writing", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ channels: [] }))
    await addConfig(sampleConfig)
    expect(mockMkdir).toHaveBeenCalledWith(expect.any(String), { recursive: true })
  })
})

describe("removeConfig", () => {
  it("removes config by id", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ channels: [sampleConfig] }))
    await removeConfig(sampleConfig.id)
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string)
    expect(written.channels).toHaveLength(0)
  })

  it("throws when id not found", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ channels: [] }))
    await expect(removeConfig("nonexistent")).rejects.toThrow("not found")
  })

  it("preserves other configs", async () => {
    const other: ChannelConfig = { ...sampleConfig, id: "ch_other" }
    mockReadFile.mockResolvedValue(JSON.stringify({ channels: [sampleConfig, other] }))
    await removeConfig(sampleConfig.id)
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string)
    expect(written.channels).toHaveLength(1)
    expect(written.channels[0].id).toBe("ch_other")
  })
})

describe("updateConfig", () => {
  it("updates config fields", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ channels: [sampleConfig] }))
    await updateConfig(sampleConfig.id, { name: "Updated" })
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string)
    expect(written.channels[0].name).toBe("Updated")
    expect(written.channels[0].clientId).toBe(sampleConfig.clientId)
  })

  it("throws when id not found", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ channels: [] }))
    await expect(updateConfig("nonexistent", { name: "x" })).rejects.toThrow("not found")
  })

  it("preserves fields not in patch", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ channels: [sampleConfig] }))
    await updateConfig(sampleConfig.id, { autoConnect: false })
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string)
    expect(written.channels[0].autoConnect).toBe(false)
    expect(written.channels[0].clientSecret).toBe(sampleConfig.clientSecret)
  })
})
