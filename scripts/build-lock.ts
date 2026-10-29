/** Repository-scoped build lease. SQLite uses OS locks and releases on crashes. */
import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

export function acquireBuildLock(root: string, env: NodeJS.ProcessEnv = process.env): { token: string; release(): void } {
  const directory = path.join(root, ".brand-build")
  mkdirSync(directory, { recursive: true })
  const ownerFile = path.join(directory, "build-owner.json")
  const inherited = env.ULTRAWORK_BUILD_LOCK_TOKEN
  if (inherited) {
    try {
      const owner = JSON.parse(readFileSync(ownerFile, "utf8")) as { token: string; pid: number }
      if (owner.token === inherited) {
        process.kill(owner.pid, 0)
        return { token: inherited, release() {} }
      }
    } catch { /* a stale environment cannot grant a lease */ }
    throw new Error("Invalid inherited build lease; start a new build from the public entry point")
  }
  const db = new Database(path.join(directory, "build-lock.sqlite"))
  const token = randomUUID()
  try {
    db.exec("PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS build_lock (id INTEGER PRIMARY KEY); BEGIN IMMEDIATE;")
  } catch {
    db.close()
    throw new Error("Another build/dev session owns this checkout. Stop it or use a separate checkout.")
  }
  writeFileSync(ownerFile, JSON.stringify({ token, pid: process.pid }) + "\n", { mode: 0o600 })
  let released = false
  return { token, release() {
    if (released) return
    released = true
    // Delete diagnostics before unlocking so a successor's owner cannot be removed.
    rmSync(ownerFile, { force: true })
    db.exec("ROLLBACK")
    db.close()
  } }
}
