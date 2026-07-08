import { ChannelManager } from "./channel-manager.js";
import { Bridge } from "./bridge.js";
import { createApp } from "./gateway-server.js";
import { QRRegistry } from "./qr-registry.js";
import { createDingTalkAdapter } from "./adapters/dingtalk/index.js";
import { createDingTalkQRProvider } from "./adapters/dingtalk/qr-provider.js";
import { createWeChatAdapter, qrApi } from "./adapters/wechat/index.js";
import { createWeChatQRProvider } from "./adapters/wechat/qr-provider.js";
import { createWeComAdapter, createWeComQRProvider } from "./adapters/wecom/index.js";
import { createFeishuAdapter, createFeishuQRProvider } from "./adapters/feishu/index.js";

const GATEWAY_PORT = 4097;

async function main() {
  console.log("Channel Gateway starting...");

  const manager = new ChannelManager();
  const bridge = new Bridge();
  await bridge.init();

  // Register adapter factories
  manager.registerFactory("dingtalk", createDingTalkAdapter);
  manager.registerFactory("wechat", createWeChatAdapter);
  manager.registerFactory("wecom", createWeComAdapter);
  manager.registerFactory("feishu", createFeishuAdapter);

  // Wire bridge as message handler (catch to prevent unhandled rejection)
  manager.setMessageHandler((msg) => {
    bridge.handleMessage(msg).catch((err) => {
      console.error("[Gateway] Bridge error:", err);
    });
  });

  // Load configs + auto-connect
  await manager.init();

  // QR login providers (shared background-poll skeleton, discussion 028 §4.1)
  const qrRegistry = new QRRegistry(manager);
  qrRegistry.registerProvider(createWeChatQRProvider(qrApi));
  qrRegistry.registerProvider(createDingTalkQRProvider());
  qrRegistry.registerProvider(createWeComQRProvider());
  qrRegistry.registerProvider(createFeishuQRProvider());

  const app = createApp(manager, qrRegistry);

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: GATEWAY_PORT,
    fetch: (req) => app.fetch(req),
  });

  console.log(`Channel Gateway listening on 127.0.0.1:${server.port}`);

  // Graceful shutdown (guard against double signal)
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("Shutting down...");
    qrRegistry.stopAll();
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
