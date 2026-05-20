/**
 * Lazy SignalStack writer factory for the api process.
 *
 * Returns a singleton HttpSignalStackWriter when SIGNALSTACK_BASE_URL and
 * SIGNALSTACK_ADMIN_KEY are both set, or `null` when signalstack push is
 * disabled. Callers should treat a null return as "skip the push, log
 * nothing" — the env vars are the operator's opt-in switch.
 *
 * Tests inject a fake via `_setSignalStackWriter`.
 */

import type { SignalStackWriterBase } from '@aggregator-dpg/signalstack-writer/interface';
import { HttpSignalStackWriter } from '@aggregator-dpg/signalstack-writer/http';
import { config } from '../config.js';
import { logger } from '../logger.js';

let writer: SignalStackWriterBase | null | undefined;

export function getSignalStackWriter(): SignalStackWriterBase | null {
  if (writer !== undefined) return writer;
  const baseUrl = config.SIGNALSTACK_BASE_URL;
  const apiKey = config.SIGNALSTACK_ADMIN_KEY;
  if (!baseUrl || !apiKey) {
    if (baseUrl && !apiKey) {
      logger.warn({
        status: 'warn',
        sub: 'signalstack.init',
        message: 'SIGNALSTACK_BASE_URL set but SIGNALSTACK_ADMIN_KEY missing — push disabled',
      });
    }
    writer = null;
    return null;
  }
  writer = new HttpSignalStackWriter({
    baseUrl,
    apiKey,
    timeoutMs: config.SIGNALSTACK_TIMEOUT_MS,
  });
  return writer;
}

/** Test helper — inject a fake or null to disable. */
export function _setSignalStackWriter(w: SignalStackWriterBase | null): void {
  writer = w;
}
