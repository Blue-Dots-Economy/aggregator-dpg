/**
 * Lua script loader + EVALSHA executor.
 *
 * Reads a `.lua` file once at module init and exposes a bound execute
 * function that uses EVALSHA for the fast path, falling back to EVAL on
 * NOSCRIPT (Redis flushed its script cache).
 *
 * The digest EVALSHA keys on is SHA1 — that is fixed by the Redis protocol
 * and cannot be swapped for a stronger hash. So this module never computes
 * it locally: it asks Redis for the digest with `SCRIPT LOAD` (once per
 * client, cached) and treats the reply as an opaque handle.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Redis } from 'ioredis';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface LuaScript {
  source: string;
}

function loadScript(relPath: string): LuaScript {
  const filePath = path.resolve(__dirname, relPath);
  return { source: readFileSync(filePath, 'utf8') };
}

const bulkRowCommitScript = loadScript('./lua/bulk_row_commit.lua');

/**
 * Per-client cache of the digest Redis returned for the script. Keyed by the
 * client because a digest is only valid against the server that cached it;
 * weak so a discarded client does not pin the entry.
 */
const digestByClient = new WeakMap<Redis, Promise<string>>();

/**
 * Registers the script with Redis and returns the digest EVALSHA needs.
 *
 * @param redis - ioredis client.
 * @param script - The loaded Lua source.
 * @returns The server-assigned script digest.
 * @throws {Error} If Redis replies with something other than a digest string.
 */
async function scriptDigest(redis: Redis, script: LuaScript): Promise<string> {
  const cached = digestByClient.get(redis);
  if (cached) return cached;

  const pending = Promise.resolve(redis.script('LOAD', script.source))
    .then((reply) => {
      if (typeof reply !== 'string' || reply.length === 0) {
        throw new Error(`SCRIPT LOAD returned an unexpected reply: ${JSON.stringify(reply)}`);
      }
      return reply;
    })
    .catch((err: unknown) => {
      // Do not cache a failed load — the next call should retry.
      digestByClient.delete(redis);
      throw err;
    });

  digestByClient.set(redis, pending);
  return pending;
}

export type BulkRowOutcome = 'passed' | 'failed' | 'skipped';

export interface BulkRowCommitResult {
  /** Total rows committed so far (SCARD). */
  processed: number;
  /** total_rows from meta, or -1 if not yet set by the File Processor. */
  total: number;
  /** 1 if the File Processor has marked reader_done; else 0. */
  readerDone: 0 | 1;
  /** 1 if this call was a fresh commit; 0 if it was a replay (no-op). */
  wasNew: 0 | 1;
}

/**
 * Runs the `bulk_row_commit.lua` script against Redis. Single round-trip
 * once the script digest has been cached for this client.
 *
 * @param redis - ioredis client.
 * @param uploadId - bulk_uploads.id; used as the key namespace `bu:{id}:`.
 * @param rowIndex - row position in the original CSV (0-indexed after header).
 * @param outcome - 'passed' | 'failed' | 'skipped'.
 * @param errorPayloadJson - JSON-serialised error details when outcome != passed; empty string otherwise.
 * @param ttlSeconds - TTL (re)applied to every bu:{id} key so participant PII self-expires if the upload is abandoned/stuck; pass 0 to skip.
 */
export async function runBulkRowCommit(
  redis: Redis,
  uploadId: string,
  rowIndex: number,
  outcome: BulkRowOutcome,
  errorPayloadJson: string,
  ttlSeconds: number,
): Promise<BulkRowCommitResult> {
  const ns = `bu:${uploadId}`;
  const keys = [
    `${ns}:processed`,
    `${ns}:counters`,
    `${ns}:errors`,
    `${ns}:error_rows`,
    `${ns}:meta`,
  ];
  const args = [String(rowIndex), outcome, errorPayloadJson, String(ttlSeconds)];

  const digest = await scriptDigest(redis, bulkRowCommitScript);

  let raw: unknown;
  try {
    raw = await redis.evalsha(digest, keys.length, ...keys, ...args);
  } catch (err) {
    // NOSCRIPT — script not in Redis cache (e.g. server restart). Reload + retry.
    const message = (err as Error).message ?? '';
    if (message.includes('NOSCRIPT')) {
      digestByClient.delete(redis);
      raw = await redis.eval(bulkRowCommitScript.source, keys.length, ...keys, ...args);
    } else {
      throw err;
    }
  }

  if (!Array.isArray(raw) || raw.length !== 4) {
    throw new Error(`bulk_row_commit.lua returned unexpected shape: ${JSON.stringify(raw)}`);
  }
  const [processed, total, readerDone, wasNew] = raw as [number, number, number, number];
  return {
    processed,
    total,
    readerDone: (readerDone === 1 ? 1 : 0) as 0 | 1,
    wasNew: (wasNew === 1 ? 1 : 0) as 0 | 1,
  };
}

export { bulkRowCommitScript };
