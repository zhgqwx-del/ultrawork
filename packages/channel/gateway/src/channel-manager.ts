import type {
  AdapterFactory,
  ChannelAdapter,
  ChannelConfig,
  ChannelStatus,
  IncomingMessage,
} from "./types.js";
import {
  loadConfigs,
  addConfig,
  removeConfig,
} from "./config-store.js";

export class ChannelManager {
  private adapters = new Map<string, ChannelAdapter>();
  private factories = new Map<string, AdapterFactory>();
  private configs = new Map<string, ChannelConfig>();
  private onMessage: (msg: IncomingMessage) => void = () => {};

  /** Register an adapter factory for a channel type */
  registerFactory(type: string, factory: AdapterFactory): void {
    this.factories.set(type, factory);
  }

  /** Set the message handler (called by Bridge) */
  setMessageHandler(handler: (msg: IncomingMessage) => void): void {
    this.onMessage = handler;
  }

  /** Load configs from disk and auto-connect channels marked autoConnect */
  async init(): Promise<void> {
    const configs = await loadConfigs();
    for (const config of configs) {
      this.configs.set(config.id, config);
      const adapter = this.createAdapter(config);
      if (adapter) {
        this.adapters.set(config.id, adapter);
        if (config.autoConnect) {
          this.connectChannel(config.id).catch((err) => {
            console.error(`Auto-connect failed for "${config.name}":`, err);
          });
        }
      }
    }
  }

  /** Add a new channel — persists config, creates adapter, and auto-connects if configured */
  async addChannel(config: ChannelConfig): Promise<void> {
    if (this.configs.has(config.id)) {
      throw new Error(`Channel "${config.id}" already exists`);
    }
    await addConfig(config);
    this.configs.set(config.id, config);
    const adapter = this.createAdapter(config);
    if (adapter) {
      this.adapters.set(config.id, adapter);
      if (config.autoConnect) {
        await this.connectChannel(config.id);
      }
    }
  }

  /** Remove a channel — disconnects, removes adapter and config */
  async removeChannel(id: string): Promise<void> {
    const adapter = this.adapters.get(id);
    if (adapter) {
      await adapter.disconnect().catch(() => {});
      this.adapters.delete(id);
    }
    this.configs.delete(id);
    await removeConfig(id);
  }

  /** Connect a channel by id */
  async connectChannel(id: string): Promise<void> {
    const adapter = this.adapters.get(id);
    if (!adapter) {
      throw new Error(`Channel "${id}" not found`);
    }
    await adapter.connect();
  }

  /** Disconnect a channel by id */
  async disconnectChannel(id: string): Promise<void> {
    const adapter = this.adapters.get(id);
    if (!adapter) {
      throw new Error(`Channel "${id}" not found`);
    }
    await adapter.disconnect();
  }

  /** Get status of a single channel */
  getChannelStatus(id: string): ChannelStatus | undefined {
    return this.adapters.get(id)?.getStatus();
  }

  /** List status of all channels (including disconnected ones from config) */
  listStatus(): ChannelStatus[] {
    const statuses: ChannelStatus[] = [];
    for (const [id, config] of this.configs) {
      const adapter = this.adapters.get(id);
      if (adapter) {
        statuses.push(adapter.getStatus());
      } else {
        statuses.push({
          id: config.id,
          type: config.type,
          name: config.name,
          state: "disconnected",
        });
      }
    }
    return statuses;
  }

  /** Get config for a channel */
  getConfig(id: string): ChannelConfig | undefined {
    return this.configs.get(id);
  }

  /** List all configs */
  listConfigs(): ChannelConfig[] {
    return Array.from(this.configs.values());
  }

  /** Shutdown all adapters */
  async shutdown(): Promise<void> {
    const disconnects = Array.from(this.adapters.values()).map((a) =>
      a.disconnect().catch(() => {}),
    );
    await Promise.all(disconnects);
    this.adapters.clear();
  }

  private createAdapter(config: ChannelConfig): ChannelAdapter | null {
    const factory = this.factories.get(config.type);
    if (!factory) {
      console.warn(
        `No adapter factory registered for type "${config.type}", skipping "${config.name}"`,
      );
      return null;
    }
    return factory(config, (msg) => this.onMessage(msg));
  }
}
