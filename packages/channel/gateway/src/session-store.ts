import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

const STORE_PATH = join(homedir(), ".ultrawork", "session-map.json");

/** Persist chatId → sessionId mapping so sessions survive gateway restarts */
export async function loadSessionMap(): Promise<Map<string, string>> {
  try {
    const raw = await readFile(STORE_PATH, "utf-8");
    const obj = JSON.parse(raw) as Record<string, string>;
    return new Map(Object.entries(obj));
  } catch {
    return new Map();
  }
}

export async function saveSessionMap(map: Map<string, string>): Promise<void> {
  await mkdir(join(homedir(), ".ultrawork"), { recursive: true });
  const obj = Object.fromEntries(map);
  await writeFile(STORE_PATH, JSON.stringify(obj, null, 2), "utf-8");
}
