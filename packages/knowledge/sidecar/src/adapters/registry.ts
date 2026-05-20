import type { KnowledgeAdapter } from "./types"

const adapters = new Map<string, KnowledgeAdapter>()

export function registerAdapter(adapter: KnowledgeAdapter): void {
  adapters.set(adapter.type, adapter)
}

export function getAdapter(type: string): KnowledgeAdapter | undefined {
  return adapters.get(type)
}

export function listAdapterTypes(): string[] {
  return [...adapters.keys()]
}
