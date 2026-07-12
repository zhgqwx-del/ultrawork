import { Hono } from "hono";
import { cors } from "hono/cors";
import { basicAuth } from "hono/basic-auth";
import { HTTPException } from "hono/http-exception";
import type { MiddlewareHandler } from "hono";
import { randomBytes } from "crypto";
import type { ChannelManager } from "./channel-manager.js";
import type { ChannelConfig, DingTalkChannelConfig, WeChatChannelConfig, WeComChannelConfig, FeishuChannelConfig } from "./types.js";
import type { QRRegistry } from "./qr-registry.js";
import type { ChannelSessionEntry } from "./session-store.js";
import { getIdleRotateMs } from "./bridge.js";

function generateId(): string {
  return `ch_${randomBytes(6).toString("hex")}`;
}

/** Secret fields per channel type, stripped from API responses (D2: the
 * frontend only needs name/type/workspaceDir — credentials stay server-side). */
const SECRET_FIELDS = ["clientSecret", "botToken", "secret", "appSecret"] as const;

function maskConfig(config: ChannelConfig): ChannelConfig {
  const masked = { ...config } as Record<string, unknown>;
  for (const field of SECRET_FIELDS) {
    if (field in masked) masked[field] = "";
  }
  return masked as unknown as ChannelConfig;
}

/** Per-install credentials the Tauri host generates and hands to every sidecar. */
export interface SidecarAuth {
  username: string;
  password: string;
}

/**
 * Basic auth WITHOUT a `WWW-Authenticate` challenge header.
 *
 * hono's `basicAuth` answers 401 with `WWW-Authenticate: Basic`, which tells a
 * browser to run its own credential flow: Chrome holds the fetch open waiting for a
 * native password dialog rather than resolving it (observed in a real browser), and
 * the Tauri WebView would pop a system prompt for a port the user never typed. Every
 * client here is programmatic and attaches the header itself, so a plain 401 is what
 * we want. hono's timing-safe comparison is still doing the work.
 */
function sidecarBasicAuth(auth: SidecarAuth): MiddlewareHandler {
  const check = basicAuth({ username: auth.username, password: auth.password })
  return async (c, next) => {
    try {
      return await check(c, next)
    } catch (err) {
      if (err instanceof HTTPException && err.status === 401) {
        return c.json({ error: "unauthorized" }, 401);
      }
      throw err;
    }
  }
}

/**
 * `auth` is required rather than optional so a caller must state its intent.
 * `null` means "no authentication" and is only for unit tests — a loopback port
 * is not a security boundary, any local process can reach it (ADR-028 / 029 §9).
 */
/**
 * The Bridge, narrowed to what the sidebar needs. Keeps this module off the
 * Bridge type (and its opencode/SSE baggage) for a single read-only listing.
 */
export interface ChannelSessionSource {
  listChannelSessions(): ChannelSessionEntry[];
}

export function createApp(
  manager: ChannelManager,
  qrRegistry: QRRegistry | undefined,
  auth: SidecarAuth | null,
  sessions?: ChannelSessionSource,
): Hono {
  const app = new Hono();

  // Allow cross-origin requests from Tauri webview and dev server only
  app.use(
    "/*",
    cors({
      origin: [
        "tauri://localhost",        // Tauri production (macOS/Linux)
        "https://tauri.localhost",  // Tauri production (Windows)
        "http://tauri.localhost",   // Tauri production fallback
        "http://localhost:1420",    // Vite dev server
      ],
    }),
  );

  // After cors(): hono's cors middleware answers the preflight OPTIONS itself and
  // never calls next(), so the browser's unauthenticated preflight is not rejected.
  // Health is behind auth too — `prepare_port` treats a healthy responder as its own
  // sidecar and reuses it, so answering /channel/health must prove the credential.
  if (auth) {
    app.use("/*", sidecarBasicAuth(auth));
  }

  // Health check. Reports the idle-rotation threshold in force because nothing else
  // can: Tauri does not forward a sidecar's stdout, so the startup log is invisible,
  // and the threshold arrives by env inheritance — "rotation never fired" and "the
  // env never reached the process" are otherwise indistinguishable.
  app.get("/channel/health", (c) =>
    c.json({ status: "ok", idleRotateMs: getIdleRotateMs() }),
  );

  // Channel-owned sessions, for the desktop sidebar's badge + unread dot. Must be
  // declared before /channel/:type/* — "sessions" would otherwise be read as a
  // channel type. Degrades to an empty list when no source is wired, and the
  // sidebar must keep working badge-less in that case.
  app.get("/channel/sessions", (c) =>
    c.json({ sessions: sessions?.listChannelSessions() ?? [] }),
  );

  // List all channels with status (configs are secret-masked)
  app.get("/channel", (c) => {
    const statuses = manager.listStatus();
    const configs = manager.listConfigs().map(maskConfig);
    return c.json({ channels: statuses, configs });
  });

  // Add a new channel
  app.post("/channel", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { name, type, workspaceDir } = body as Record<string, string>;
    if (!name || typeof name !== "string" || !name.trim()) {
      return c.json({ error: "Missing required field: name" }, 400);
    }
    if (!type || typeof type !== "string") {
      return c.json({ error: "Missing required field: type" }, 400);
    }
    if (!workspaceDir || typeof workspaceDir !== "string" || !workspaceDir.trim()) {
      return c.json({ error: "Missing required field: workspaceDir" }, 400);
    }

    const id = generateId();
    let config: ChannelConfig;

    if (type === "dingtalk") {
      const { clientId, clientSecret } = body as Record<string, string>;
      if (!clientId || typeof clientId !== "string" || !clientId.trim()) {
        return c.json({ error: "Missing required field: clientId" }, 400);
      }
      if (!clientSecret || typeof clientSecret !== "string" || !clientSecret.trim()) {
        return c.json({ error: "Missing required field: clientSecret" }, 400);
      }
      config = {
        id,
        type: "dingtalk",
        name: name.trim(),
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        workspaceDir: workspaceDir.trim(),
        autoConnect: body.autoConnect !== false,
      } satisfies DingTalkChannelConfig;
    } else if (type === "wecom") {
      const { botId, secret } = body as Record<string, string>;
      if (!botId || typeof botId !== "string" || !botId.trim()) {
        return c.json({ error: "Missing required field: botId" }, 400);
      }
      if (!secret || typeof secret !== "string" || !secret.trim()) {
        return c.json({ error: "Missing required field: secret" }, 400);
      }
      config = {
        id,
        type: "wecom",
        name: name.trim(),
        botId: botId.trim(),
        secret: secret.trim(),
        workspaceDir: workspaceDir.trim(),
        autoConnect: body.autoConnect !== false,
      } satisfies WeComChannelConfig;
    } else if (type === "feishu") {
      const { appId, appSecret, domain } = body as Record<string, string>;
      if (!appId || typeof appId !== "string" || !appId.trim()) {
        return c.json({ error: "Missing required field: appId" }, 400);
      }
      if (!appSecret || typeof appSecret !== "string" || !appSecret.trim()) {
        return c.json({ error: "Missing required field: appSecret" }, 400);
      }
      config = {
        id,
        type: "feishu",
        name: name.trim(),
        appId: appId.trim(),
        appSecret: appSecret.trim(),
        domain: domain === "lark" ? "lark" : "feishu",
        workspaceDir: workspaceDir.trim(),
        autoConnect: body.autoConnect !== false,
      } satisfies FeishuChannelConfig;
    } else if (type === "wechat") {
      const { botToken, ilinkBotId, ilinkUserId, baseUrl } = body as Record<string, string>;
      if (!botToken || !ilinkBotId || !baseUrl) {
        return c.json({ error: "Missing required WeChat fields: botToken, ilinkBotId, baseUrl" }, 400);
      }
      config = {
        id,
        type: "wechat",
        name: name.trim(),
        botToken,
        ilinkBotId,
        ilinkUserId: ilinkUserId || "",
        baseUrl,
        workspaceDir: workspaceDir.trim(),
        autoConnect: body.autoConnect !== false,
      } satisfies WeChatChannelConfig;
    } else {
      return c.json({ error: `Unknown channel type: ${type}` }, 400);
    }

    try {
      await manager.addChannel(config);
      return c.json(maskConfig(config), 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to add channel";
      return c.json({ error: msg }, 400);
    }
  });

  // Remove a channel
  app.delete("/channel/:id", async (c) => {
    const id = c.req.param("id");
    try {
      await manager.removeChannel(id);
      return c.json({ ok: true });
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed to remove channel";
      return c.json({ error: msg }, 404);
    }
  });

  // Connect a channel
  app.post("/channel/:id/connect", async (c) => {
    const id = c.req.param("id");
    try {
      await manager.connectChannel(id);
      const status = manager.getChannelStatus(id);
      return c.json(status ?? { id, state: "connected" });
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed to connect channel";
      return c.json({ error: msg }, 500);
    }
  });

  // Disconnect a channel
  app.post("/channel/:id/disconnect", async (c) => {
    const id = c.req.param("id");
    try {
      await manager.disconnectChannel(id);
      const status = manager.getChannelStatus(id);
      return c.json(status ?? { id, state: "disconnected" });
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed to disconnect channel";
      return c.json({ error: msg }, 500);
    }
  });

  // ---- QR Code Login Flow (any registered provider; see qr-registry.ts) ----
  // The registry polls upstream in the background and persists credentials
  // the moment they arrive; these routes only start sessions and read the
  // cached snapshot — safe for one-shot device-flow secrets.

  /** Start a QR session for a channel type */
  app.post("/channel/:type/qrcode", async (c) => {
    const type = c.req.param("type");
    if (!qrRegistry?.hasProvider(type)) {
      return c.json({ error: `No QR login flow for channel type: ${type}` }, 404);
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { name, workspaceDir } = body as Record<string, string>;
    if (!name || typeof name !== "string" || !name.trim()) {
      return c.json({ error: "Missing required field: name" }, 400);
    }
    if (!workspaceDir || typeof workspaceDir !== "string" || !workspaceDir.trim()) {
      return c.json({ error: "Missing required field: workspaceDir" }, 400);
    }

    try {
      const session = await qrRegistry.start(type, {
        name: name.trim(),
        workspaceDir: workspaceDir.trim(),
        autoConnect: body.autoConnect !== false,
      });
      return c.json({ token: session.token, qrContent: session.qrContent, browserUrl: session.browserUrl });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to start QR session";
      console.error(`[QR:${type}]`, msg);
      return c.json({ error: msg }, 500);
    }
  });

  /** Read the cached QR session state */
  app.get("/channel/:type/qrcode-status", (c) => {
    const token = c.req.query("token");
    if (!token) {
      return c.json({ error: "Missing query param: token" }, 400);
    }
    const snapshot = qrRegistry?.getSnapshot(token);
    if (!snapshot || snapshot.type !== c.req.param("type")) {
      return c.json({ error: "QR session not found or expired" }, 404);
    }
    return c.json({
      status: snapshot.state,
      channelId: snapshot.channelId,
      error: snapshot.error,
    });
  });

  /** Cancel a QR session (stops the background poll loop) */
  app.delete("/channel/:type/qrcode/:token", (c) => {
    const token = c.req.param("token");
    const snapshot = qrRegistry?.getSnapshot(token);
    if (!snapshot || snapshot.type !== c.req.param("type")) {
      return c.json({ error: "QR session not found or expired" }, 404);
    }
    qrRegistry!.cancel(token);
    return c.json({ ok: true });
  });

  return app;
}
