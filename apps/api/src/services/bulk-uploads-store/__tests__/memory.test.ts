/**
 * The in-memory bulk uploads store matches the Postgres adapter's outcomes.
 */
import { describe, expect, it } from 'vitest';
import { BulkUploadsStoreFake, buildBulkUpload } from '../testing.js';

const AGG = '00000000-0000-4000-8000-0000000000aa';
const input = {
  aggregatorId: AGG,
  participantType: 'seeker',
  storageKey: 'pending',
  schemaId: 'participant-seeker',
  schemaVersion: 'v1',
  uploadedBy: 'kc-1',
};

describe('InMemoryBulkUploadsStore', () => {
  it('creates a pending row, sets its key and marks it uploaded', async () => {
    const store = new BulkUploadsStoreFake();
    const created = await store.create(input);
    if (!created.ok) throw new Error('create failed');
    expect(created.value.status).toBe('pending');
    expect(await store.setStorageKey(created.value.id, 'k/raw.csv')).toEqual({
      ok: true,
      value: undefined,
    });
    const marked = await store.markUploaded(created.value.id, AGG, 'fp');
    expect(marked.ok && marked.value).toMatchObject({
      status: 'uploaded',
      storageKey: 'k/raw.csv',
      contentFingerprint: 'fp',
    });
  });

  it('hides a row from another coordinator', async () => {
    const store = new BulkUploadsStoreFake();
    store.seed([buildBulkUpload()]);
    expect(await store.findById(buildBulkUpload().id, 'someone-else')).toEqual({
      ok: true,
      value: null,
    });
  });

  it('refuses markUploaded past uploaded and on an unknown row', async () => {
    const store = new BulkUploadsStoreFake();
    store.seed([buildBulkUpload({ status: 'completed' })]);
    const past = await store.markUploaded(
      buildBulkUpload().id,
      buildBulkUpload().aggregatorId,
      'x',
    );
    expect(!past.ok && past.error.code).toBe('INVALID_TRANSITION');
    const missing = await store.markUploaded('nope', AGG, 'x');
    expect(!missing.ok && missing.error.code).toBe('NOT_FOUND');
  });

  it('lists started uploads only, newest first, and deletes only pending rows', async () => {
    const store = new BulkUploadsStoreFake();
    const base = buildBulkUpload();
    store.seed([
      { ...base, id: 'a', status: 'pending' },
      { ...base, id: 'b', status: 'completed', createdAt: new Date('2026-01-02T00:00:00Z') },
      { ...base, id: 'c', status: 'failed', statusReason: 'upload_abandoned' },
      { ...base, id: 'd', status: 'completed', createdAt: new Date('2026-01-03T00:00:00Z') },
    ]);
    const listed = await store.list(base.aggregatorId, { limit: 10, offset: 0 });
    expect(listed.ok && listed.value.rows.map((r) => r.id)).toEqual(['d', 'b']);
    expect(listed.ok && listed.value.total).toBe(2);

    await store.deletePending('a', base.aggregatorId);
    await store.deletePending('b', base.aggregatorId);
    expect(store.get('a')).toBeUndefined();
    expect(store.get('b')).toBeDefined();
  });
});
