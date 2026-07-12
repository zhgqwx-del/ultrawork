import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { SessionStore, type ChannelSessionEntry } from "../session-store.js";

// Every store here is constructed with an explicit temp path. The default
// (~/.ultrawork/session-map.json) is a live file — an earlier version of this
// suite reached it and destroyed a real session map, which is why the path is
// injectable at all. Never construct a bare `new SessionStore()` in a test.
let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ultrawork-store-"));
  path = join(dir, "session-map.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const writeRaw = (contents: unknown) =>
  writeFile(path, JSON.stringify(contents), "utf-8");

function entry(
  over: Partial<ChannelSessionEntry> & { sessionId: string; chatId: string; channelType: string },
): ChannelSessionEntry {
  return {
    senderId: "s1",
    senderName: "Sender",
    workspaceDir: "/w",
    createdAt: 1,
    lastActiveAt: 1,
    ...over,
  };
}

describe("SessionStore", () => {
  it("round-trips entries through disk", async () => {
    const a = new SessionStore(path);
    a.set(entry({ sessionId: "ses_1", chatId: "user-1", channelType: "wecom" }));
    await a.save();

    const b = new SessionStore(path);
    await b.load();
    expect(b.get("wecom", "user-1")?.sessionId).toBe("ses_1");
  });

  it("namespaces by channel: the same chatId on two channels stays separate", async () => {
    // v1 keyed on chatId alone, so colliding user-id spaces shared one session.
    const s = new SessionStore(path);
    s.set(entry({ sessionId: "ses_dt", chatId: "u1", channelType: "dingtalk" }));
    s.set(entry({ sessionId: "ses_wx", chatId: "u1", channelType: "wechat" }));

    expect(s.get("dingtalk", "u1")?.sessionId).toBe("ses_dt");
    expect(s.get("wechat", "u1")?.sessionId).toBe("ses_wx");
    expect(s.size).toBe(2);
  });

  it("migrates a v1 flat map without losing any binding", async () => {
    // Dropping these would silently sever the context of every live IM chat.
    await writeRaw({ "user-1": "ses_old", "group:g1": "ses_grp" });
    const s = new SessionStore(path);
    await s.load();

    // Channel type is unknowable from v1, so entries stay reachable by bare chatId.
    expect(s.get("dingtalk", "user-1")?.sessionId).toBe("ses_old");
    expect(s.get("wechat", "user-1")?.sessionId).toBe("ses_old");
    expect(s.get("feishu", "group:g1")?.sessionId).toBe("ses_grp");
  });

  it("stamps migrated v1 entries as active now, not as ancient", async () => {
    // lastActiveAt: 0 would read as "idle forever" and let P1 rotate away a
    // conversation the user may be in the middle of.
    await writeRaw({ "user-1": "ses_old" });
    const s = new SessionStore(path);
    await s.load();

    expect(s.get("dingtalk", "user-1")!.lastActiveAt).toBeGreaterThan(Date.now() - 10_000);
  });

  it("retires the v1 key once the chat is seen again", async () => {
    await writeRaw({ "user-1": "ses_old" });
    const s = new SessionStore(path);
    await s.load();
    expect(s.size).toBe(1);

    // The next inbound message re-writes it under the namespaced key, carrying the
    // session id across — one entry, not two, and no new opencode session.
    s.set(entry({ sessionId: "ses_old", chatId: "user-1", channelType: "dingtalk" }));

    expect(s.size).toBe(1);
    expect(s.get("dingtalk", "user-1")?.sessionId).toBe("ses_old");
    expect(s.list()[0].channelType).toBe("dingtalk");
  });

  it("delete removes both the namespaced and any legacy key", async () => {
    await writeRaw({ "user-1": "ses_old" });
    const s = new SessionStore(path);
    await s.load();

    s.delete("dingtalk", "user-1");
    expect(s.get("dingtalk", "user-1")).toBeUndefined();
    expect(s.size).toBe(0);
  });

  it("survives a corrupt store rather than crashing the gateway", async () => {
    await writeFile(path, "{not json", "utf-8");
    const s = new SessionStore(path);
    await s.load();
    expect(s.size).toBe(0);
  });

  it("survives concurrent saves without publishing a torn file", async () => {
    // Every inbound message now re-stamps lastActiveAt, so saves fire per-message
    // and overlap constantly. With a shared `${path}.tmp` two writers interleave
    // write/rename and can publish half a JSON document — which load() then reads
    // as corrupt and resets to empty, losing every chat's binding at once.
    const s = new SessionStore(path);
    const saves: Promise<void>[] = [];
    for (let i = 0; i < 25; i++) {
      s.set(entry({ sessionId: `ses_${i}`, chatId: `u${i}`, channelType: "wecom" }));
      saves.push(s.save()); // fire-and-forget, exactly as persistSessionMap does
    }
    await Promise.all(saves);

    // The published file must be complete, parseable, and hold the final state.
    const reloaded = new SessionStore(path);
    await reloaded.load();
    expect(reloaded.size).toBe(25);
    expect(reloaded.get("wecom", "u24")?.sessionId).toBe("ses_24");
  });

  it("writes atomically and leaves no temp file behind", async () => {
    const s = new SessionStore(path);
    s.set(entry({ sessionId: "ses_1", chatId: "u1", channelType: "wecom" }));
    await s.save();

    const parsed = JSON.parse(await readFile(path, "utf-8"));
    expect(parsed.version).toBe(2);
    expect(parsed.entries["wecom:u1"].sessionId).toBe("ses_1");
    await expect(readFile(`${path}.tmp`, "utf-8")).rejects.toThrow();
  });
});
