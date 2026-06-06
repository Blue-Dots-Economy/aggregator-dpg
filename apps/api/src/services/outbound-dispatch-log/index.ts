/**
 * Public surface and factory for the outbound dispatch log service.
 *
 * Returns a process-wide singleton. Tests override via
 * `_setOutboundDispatchLog`. Mirrors the same DI pattern used by the
 * SignalStack writer (`apps/api/src/services/signalstack.ts`).
 */

import { getDb } from '../../db/client.js';
import type { OutboundDispatchLogBase } from './interface.js';
import { PostgresOutboundDispatchLog } from './postgres.js';

let _outboundDispatchLog: OutboundDispatchLogBase | null = null;

/**
 * Returns the singleton OutboundDispatchLog service. Lazy-instantiates the
 * Postgres impl on first call (production) or returns the test-injected
 * fake.
 */
export function getOutboundDispatchLog(): OutboundDispatchLogBase {
  if (_outboundDispatchLog) return _outboundDispatchLog;
  _outboundDispatchLog = new PostgresOutboundDispatchLog(getDb());
  return _outboundDispatchLog;
}

/**
 * Test-only override. Pass `null` to clear and force re-init on the
 * next `getOutboundDispatchLog()` call.
 */
export function _setOutboundDispatchLog(impl: OutboundDispatchLogBase | null): void {
  _outboundDispatchLog = impl;
}

export { OutboundDispatchLogBase } from './interface.js';
export type { Channel, EnqueueInput, OutboundDispatchRow, Status } from './interface.js';
export { ChannelSchema, EnqueueInputSchema, StatusSchema } from './interface.js';
export { InMemoryOutboundDispatchLog, OutboundDispatchLogFake } from './memory.js';
export { PostgresOutboundDispatchLog } from './postgres.js';
