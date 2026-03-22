import { ChannelManager } from "./channel-manager.js";
import { Bridge } from "./bridge.js";
import { createApp } from "./gateway-server.js";
import { createDingTalkAdapter } from "./adapters/dingtalk/index.js";

const GATEWAY_PORT = 4097;

async function main() {
  console.log("Channel Gateway starting...");

  const manager = new ChannelManager();
  const bridge = new Bridge();
  await bridge.init();

  // Register adapter factories
  manager.registerFactory("dingtalk", createDingTalkAdapter);

  // Wire bridge as message handler (catch to prevent unhandled rejection)
  manager.setMessageHandler((msg) => {
    bridge.handleMessage(msg).catch((err) => {
      console.error("[Gateway] Bridge error:", err);
    });
  });

  // Load configs + auto-connect
  await manager.init();

  const app = createApp(manager);

  const server = Bun.serve({
    port: GATEWAY_PORT,
    fetch: (req) => app.fetch(req),
  });

  console.log(`Channel Gateway listening on port ${server.port}`);

  // Graceful shutdown (guard against double signal)
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("Shutting down...");
    await manager.shutdown();
    await bridge.shutdown();
    server.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Channel Gateway failed to start:", err);
  process.exit(1);
});

export type { ChannelAdapter, ChannelConfig, ChannelStatus, IncomingMessage } from "./types.js";
export { ChannelManager } from "./channel-manager.js";
export { Bridge } from "./bridge.js";
