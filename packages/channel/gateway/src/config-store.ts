import { readFile, writeFile, mkdir, chmod } from "fs/promises";
import { dirname } from "path";
import { join } from "path";
import { brandPaths } from "@agent/brand/node";
import type { ChannelConfig, ChannelsStore } from "./types.js";

const configPath = () => join(brandPaths().appRoot, "channels.json");

/** Simple mutex to prevent read-modify-write races */
let lock: Promise<void> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = lock.then(fn, fn);
  lock = next.then(() => {}, () => {});
  return next;
}

export async function loadConfigs(): Promise<ChannelConfig[]> {
  try {
    const raw = await readFile(configPath(), "utf-8");
    const store = JSON.parse(raw) as ChannelsStore;
    return store.channels ?? [];
  } catch {
    return [];
  }
}

async function saveStore(store: ChannelsStore): Promise<void> {
  await mkdir(dirname(configPath()), { recursive: true });
  // Owner-only (D2): the store holds channel secrets. `mode` only applies on
  // create, so chmod tightens files written before this policy existed.
  await writeFile(configPath(), JSON.stringify(store, null, 2), { encoding: "utf-8", mode: 0o600 });
  await chmod(configPath(), 0o600).catch(() => {});
}

export async function addConfig(config: ChannelConfig): Promise<void> {
  return withLock(async () => {
    const channels = await loadConfigs();
    if (channels.some((c) => c.id === config.id)) {
      throw new Error(`Channel "${config.id}" already exists`);
    }
    channels.push(config);
    await saveStore({ channels });
  });
}

export async function removeConfig(id: string): Promise<void> {
  return withLock(async () => {
    const channels = await loadConfigs();
    const filtered = channels.filter((c) => c.id !== id);
    if (filtered.length === channels.length) {
      throw new Error(`Channel "${id}" not found`);
    }
    await saveStore({ channels: filtered });
  });
}

export async function updateConfig(
  id: string,
  patch: Partial<ChannelConfig>,
): Promise<void> {
  return withLock(async () => {
    const channels = await loadConfigs();
    const idx = channels.findIndex((c) => c.id === id);
    if (idx === -1) {
      throw new Error(`Channel "${id}" not found`);
    }
    channels[idx] = { ...channels[idx], ...patch } as ChannelConfig;
    await saveStore({ channels });
  });
}
