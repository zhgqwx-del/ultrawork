import { Hono } from "hono";
import { randomBytes } from "crypto";
import type { ChannelManager } from "./channel-manager.js";
import type { ChannelConfig } from "./types.js";

function generateId(): string {
  return `ch_${randomBytes(6).toString("hex")}`;
}

export function createApp(manager: ChannelManager): Hono {
  const app = new Hono();

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

    // Validate required fields
    const { name, type, clientId, clientSecret, workspaceDir } = body as Record<string, string>;
    if (!name || typeof name !== "string" || !name.trim()) {
      return c.json({ error: "Missing required field: name" }, 400);
    }
    if (!type || typeof type !== "string") {
      return c.json({ error: "Missing required field: type" }, 400);
    }
    if (!clientId || typeof clientId !== "string" || !clientId.trim()) {
      return c.json({ error: "Missing required field: clientId" }, 400);
    }
    if (!clientSecret || typeof clientSecret !== "string" || !clientSecret.trim()) {
      return c.json({ error: "Missing required field: clientSecret" }, 400);
    }
    if (!workspaceDir || typeof workspaceDir !== "string" || !workspaceDir.trim()) {
      return c.json({ error: "Missing required field: workspaceDir" }, 400);
    }

    const id = generateId();
    const config: ChannelConfig = {
      id,
      name: name.trim(),
      type: type as ChannelConfig["type"],
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
      workspaceDir: workspaceDir.trim(),
      autoConnect: body.autoConnect !== false,
    };

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

  return app;
}
