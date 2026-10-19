import type { CallDocument } from "./call.js";

/**
 * A signature request that is waiting for the person. It holds the poll secret, so keep it on the server:
 * never in a response, a log, a tool result or a model's context.
 */
export type PendingSignature = {
  v: 1;
  /** The call key (`prepareCall`). */
  key: string;
  requestId: string;
  pollSecret: string;
  /** Where the person signs. */
  url: string;
  document: CallDocument;
  messageDigest: string;
  /** Until when the person can start signing (Unix seconds). A signature already started can finish after it. */
  expiresAt: number;
};

/**
 * Where the gate keeps requests between calls. Every value is plain JSON.
 *
 * A server that runs on more than one process needs a shared store, and `use` must be atomic across all of
 * them (for example `SET key 1 NX EX ttl` in Redis, an insert into a column with a unique constraint, or a
 * Durable Object). Without that, two processes can run the same signed call twice.
 */
export interface SignatureStore {
  get(key: string): Promise<PendingSignature | undefined>;
  /** Replaces whatever was kept under `key`. The value may be dropped after `ttlSeconds`. */
  set(key: string, value: PendingSignature, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  /**
   * Marks a signature as used, atomically. Resolves true for the first call with a given `requestId` and
   * false for every later one within `ttlSeconds`.
   */
  use(requestId: string, ttlSeconds: number): Promise<boolean>;
}

/**
 * A store in this process's memory. Right for a server that runs as one process, such as an MCP server
 * over stdio; requests are lost when the process exits.
 */
export function memoryStore(): SignatureStore {
  const pending = new Map<string, { value: PendingSignature; until: number }>();
  const used = new Map<string, number>();

  function sweep(now: number): void {
    for (const [key, entry] of pending) if (entry.until <= now) pending.delete(key);
    for (const [id, until] of used) if (until <= now) used.delete(id);
  }

  return {
    async get(key) {
      const now = Date.now();
      sweep(now);
      const entry = pending.get(key);
      return entry ? structuredClone(entry.value) : undefined;
    },
    async set(key, value, ttlSeconds) {
      pending.set(key, { value: structuredClone(value), until: Date.now() + ttlSeconds * 1000 });
    },
    async delete(key) {
      pending.delete(key);
    },
    async use(requestId, ttlSeconds) {
      const now = Date.now();
      sweep(now);
      if (used.has(requestId)) return false;
      used.set(requestId, now + ttlSeconds * 1000);
      return true;
    },
  };
}
