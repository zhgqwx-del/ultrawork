import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname } from "path";
import { join } from "path";
import { homedir } from "os";
import type { ChannelConfig, ChannelsStore } from "./types.js";

const CONFIG_DIR = join(homedir(), ".ultrawork");
const CONFIG_PATH = join(CONFIG_DIR, "channels.json");

/** Simple mutex to prevent read-modify-write races */
let lock: Promise<void> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = lock.then(fn, fn);
  lock = next.then(() => {}, () => {});
  return next;
}

export async function loadConfigs(): Promise<ChannelConfig[]> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    const store = JSON.parse(raw) as ChannelsStore;
    return store.channels ?? [];
  } catch {
    return [];
  }
}

async function saveStore(store: ChannelsStore): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(store, null, 2), "utf-8");
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
    channels[idx] = { ...channels[idx], ...patch };
    await saveStore({ channels });
  });
}
