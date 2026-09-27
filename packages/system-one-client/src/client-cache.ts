// Per-org SDK client cache.
// The cache key never holds the
// key itself, only a fingerprint.

import { type SystemOneProvider, sha256Hex } from "@bandwise/core";

/** A short, stable, non-reversible fingerprint of a key: the first 16 hex chars of its SHA-256. */
export function keyFingerprint(apiKey: string): string {
  return sha256Hex(apiKey).slice(0, 16);
}

/** A small LRU of clients keyed by provider and key fingerprint. */
export class ClientCache<T> {
  private readonly entries = new Map<string, T>();

  constructor(private readonly maxEntries = 500) {}

  get size(): number {
    return this.entries.size;
  }

  /** The cached client for this provider and key, or a new one from `create`. */
  getOrCreate(provider: SystemOneProvider, apiKey: string, create: () => T): T {
    const k = `${provider}:${keyFingerprint(apiKey)}`;
    const hit = this.entries.get(k);
    if (hit !== undefined) {
      this.entries.delete(k);
      this.entries.set(k, hit);
      return hit;
    }
    const client = create();
    this.entries.set(k, client);
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
    return client;
  }

  /** Drop every client for a key, for example after a rotation or a 401. */
  evict(provider: SystemOneProvider, apiKey: string): void {
    this.entries.delete(`${provider}:${keyFingerprint(apiKey)}`);
  }
}
