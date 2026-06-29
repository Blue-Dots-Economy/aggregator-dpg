/**
 * Unit tests for worker-role selection. Roles let a deployment run the
 * CPU-sensitive File Processor in its own process, isolated from the row /
 * finalise / cron workers (see ADR in the PR / docs/proposals).
 *
 * @module @aggregator-dpg/worker
 */

import { describe, it, expect } from 'vitest';
import { parseWorkerRoles, WORKER_ROLES } from './worker-roles.js';

describe('parseWorkerRoles', () => {
  it('defaults to ALL roles when unset', () => {
    expect(parseWorkerRoles(undefined)).toEqual(new Set(WORKER_ROLES));
  });

  it('defaults to ALL roles on empty / whitespace', () => {
    expect(parseWorkerRoles('   ')).toEqual(new Set(WORKER_ROLES));
  });

  it('treats the literal "all" as every role', () => {
    expect(parseWorkerRoles('all')).toEqual(new Set(WORKER_ROLES));
  });

  it('selects a single role', () => {
    expect(parseWorkerRoles('file')).toEqual(new Set(['file']));
  });

  it('selects multiple roles', () => {
    expect(parseWorkerRoles('file,row')).toEqual(new Set(['file', 'row']));
  });

  it('is case- and whitespace-insensitive and ignores empty tokens', () => {
    expect(parseWorkerRoles(' File , ROW , ')).toEqual(new Set(['file', 'row']));
  });

  it('throws on an unknown role (fail fast at boot)', () => {
    expect(() => parseWorkerRoles('file,bogus')).toThrowError(/unknown worker role/i);
  });
});
