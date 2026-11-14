import type { BotTransport } from './engineShared.js';

export interface RuntimeAdapter {
  exportState: () => unknown;
  importState: (raw: unknown) => void;
}

const adapters = new Map<string, RuntimeAdapter>();
let runtimeDirty = false;
let transportResolver: ((source: 'telegram' | 'simulator', chatId?: string) => BotTransport | null) | null = null;

export function isServerlessRuntime(): boolean {
  return Boolean(
    process.env.VERCEL ||
      process.env.VERCEL_ENV ||
      process.env.AWS_LAMBDA_FUNCTION_NAME
  );
}

export function registerRuntimeAdapter(key: string, adapter: RuntimeAdapter): void {
  adapters.set(key, adapter);
}

export function markRuntimeDirty(): void {
  runtimeDirty = true;
}

export function isRuntimeDirty(): boolean {
  return runtimeDirty;
}

export function clearRuntimeDirty(): void {
  runtimeDirty = false;
}

export function collectRuntimeSnapshot(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, adapter] of adapters.entries()) {
    out[key] = adapter.exportState();
  }
  return out;
}

export function applyRuntimeSnapshot(snapshot: Record<string, unknown> | null | undefined): void {
  const safe = snapshot || {};
  for (const [key, adapter] of adapters.entries()) {
    adapter.importState(safe[key]);
  }
}

export function registerTransportResolver(
  resolver: (source: 'telegram' | 'simulator', chatId?: string) => BotTransport | null
): void {
  transportResolver = resolver;
}

export function resolveRuntimeTransport(
  source?: 'telegram' | 'simulator',
  chatId?: string,
  existing?: BotTransport | null
): BotTransport | null {
  if (existing) return existing;
  const resolvedSource: 'telegram' | 'simulator' =
    source || (chatId && chatId.startsWith('sim-') ? 'simulator' : 'telegram');
  return transportResolver ? transportResolver(resolvedSource, chatId) : null;
}
