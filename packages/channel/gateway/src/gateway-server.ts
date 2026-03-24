import { Hono } from "hono";
import { cors } from "hono/cors";
import { randomBytes } from "crypto";
import type { ChannelManager } from "./channel-manager.js";
import type { ChannelConfig, DingTalkChannelConfig, WeChatChannelConfig } from "./types.js";
import { qrApi } from "./adapters/wechat/index.js";

function generateId(): string {
  return `ch_${randomBytes(6).toString("hex")}`;
}

/** Pending QR login sessions (qrcodeToken → pending config info) */
interface PendingQR {
  token: string;
  name: string;
  workspaceDir: string;
  autoConnect: boolean;
  createdAt: number;
}

const pendingQRSessions = new Map<string, PendingQR>();
const PENDING_QR_TTL_MS = 5 * 60 * 1000; // 5 min

/** Clean up stale pending QR sessions */
function cleanupPendingQR(): void {
  const now = Date.now();
  for (const [token, session] of pendingQRSessions) {
    if (now - session.createdAt > PENDING_QR_TTL_MS) {
      pendingQRSessions.delete(token);
    }
  }
}

export function createApp(manager: ChannelManager): Hono {
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

  // Health check
  app.get("/channel/health", (c) => c.json({ status: "ok" }));

  // List all channels with status
  app.get("/channel", (c) => {
    const statuses = manager.listStatus();
    const configs = manager.listConfigs();
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
      return c.json(config, 201);
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

  // ---- WeChat QR Code Login Flow ----

  /** Request a QR code for WeChat login */
  app.post("/channel/wechat/qrcode", async (c) => {
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
      cleanupPendingQR();
      const qrResp = await qrApi.getQRCode();

      // Store pending session
      pendingQRSessions.set(qrResp.qrcode, {
        token: qrResp.qrcode,
        name: name.trim(),
        workspaceDir: workspaceDir.trim(),
        autoConnect: body.autoConnect !== false,
        createdAt: Date.now(),
      });

      return c.json({
        qrcodeUrl: qrResp.qrcode,
        qrcodeImgContent: qrResp.qrcode_img_content || "",
        token: qrResp.qrcode,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to get QR code";
      console.error("[WeChat QR]", msg);
      return c.json({ error: msg }, 500);
    }
  });

  /** Poll QR code scan status */
  app.get("/channel/wechat/qrcode-status", async (c) => {
    const token = c.req.query("token");
    if (!token) {
      return c.json({ error: "Missing query param: token" }, 400);
    }

    const pending = pendingQRSessions.get(token);
    if (!pending) {
      return c.json({ error: "QR session not found or expired" }, 404);
    }

    try {
      const status = await qrApi.getQRCodeStatus(token);

      if (status.status === "confirmed") {
        // Create channel config from confirmed credentials
        const id = generateId();
        const config: WeChatChannelConfig = {
          id,
          type: "wechat",
          name: pending.name,
          botToken: status.bot_token,
          ilinkBotId: status.ilink_bot_id,
          ilinkUserId: status.ilink_user_id || "",
          baseUrl: status.baseurl || "https://ilinkai.weixin.qq.com",
          workspaceDir: pending.workspaceDir,
          autoConnect: pending.autoConnect,
        };

        await manager.addChannel(config);
        pendingQRSessions.delete(token);

        return c.json({
          status: "confirmed",
          channelId: id,
        });
      }

      if (status.status === "expired") {
        pendingQRSessions.delete(token);
      }

      return c.json({ status: status.status });
    } catch (err) {
      // Timeout from long-poll is normal → return "wait"
      if (err instanceof Error && err.name === "AbortError") {
        return c.json({ status: "wait" });
      }
      const msg = err instanceof Error ? err.message : "Failed to check status";
      console.error("[WeChat QR Status]", msg);
      return c.json({ error: msg }, 500);
    }
  });

  return app;
}
