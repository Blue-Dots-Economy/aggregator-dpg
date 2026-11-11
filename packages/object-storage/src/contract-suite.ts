import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UpstreamError, type BaseError } from '@aggregator-dpg/shared-primitives/errors';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { ObjectRef, ObjectStorageBase } from './interface.js';

interface ContractHarness {
  storage: ObjectStorageBase;
  seed(ref: ObjectRef, bytes: Buffer): Promise<void>;
}

function unwrap<T>(result: Result<T, BaseError>): T {
  if (!result.success) throw result.error;
  return result.value;
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Registers the provider contract cases; `make` must return a fresh, empty storage each call. */
export function runObjectStorageContract(name: string, make: () => Promise<ContractHarness>): void {
  describe(`ObjectStorage contract: ${name}`, () => {
    let storage: ObjectStorageBase;
    let seed: ContractHarness['seed'];
    let ref: ObjectRef;
    let created: ObjectRef[];

    function track(area: ObjectRef['area'], key: string): ObjectRef {
      const tracked: ObjectRef = { area, key };
      created.push(tracked);
      return tracked;
    }

    beforeEach(async () => {
      ({ storage, seed } = await make());
      created = [];
      ref = track('bulk-uploads', `contract/${randomUUID()}/raw.csv`);
    });

    afterEach(async () => {
      await Promise.all(created.map((tracked) => storage.delete(tracked)));
    });

    it('returns null when stat targets a missing object', async () => {
      expect(unwrap(await storage.stat(ref))).toBeNull();
    });

    it('returns null when openReadStream targets a missing object', async () => {
      expect(unwrap(await storage.openReadStream(ref))).toBeNull();
    });

    it('reports size and a fingerprint after a buffer put', async () => {
      const bytes = Buffer.from('a,b\n1,2\n');
      unwrap(await storage.put({ ref, body: bytes, contentType: 'text/csv' }));
      const stat = unwrap(await storage.stat(ref));
      expect(stat?.size).toBe(bytes.length);
      expect(stat?.fingerprint).toBeTruthy();
    });

    it('round-trips a streamed put through openReadStream', async () => {
      const chunks = [Buffer.from('one,'), Buffer.from('two,'), Buffer.from('three\n')];
      unwrap(await storage.put({ ref, body: Readable.from(chunks), contentType: 'text/csv' }));
      const stream = unwrap(await storage.openReadStream(ref));
      if (stream === null) throw new Error('expected a stream');
      expect((await readAll(stream)).toString()).toBe('one,two,three\n');
    });

    it('reads back an object written outside put', async () => {
      const bytes = Buffer.from('seeded\n');
      await seed(ref, bytes);
      expect(unwrap(await storage.stat(ref))?.size).toBe(bytes.length);
    });

    it('gives equal fingerprints for equal bytes and different ones otherwise', async () => {
      const other = track('bulk-uploads', `contract/${randomUUID()}/other.csv`);
      unwrap(await storage.put({ ref, body: Buffer.from('same'), contentType: 'text/csv' }));
      const first = unwrap(await storage.stat(ref));
      unwrap(await storage.put({ ref, body: Buffer.from('same'), contentType: 'text/csv' }));
      const second = unwrap(await storage.stat(ref));
      unwrap(
        await storage.put({ ref: other, body: Buffer.from('different'), contentType: 'text/csv' }),
      );
      const third = unwrap(await storage.stat(other));
      expect(second?.fingerprint).toBe(first?.fingerprint);
      expect(third?.fingerprint).not.toBe(first?.fingerprint);
    });

    it('returns an upstream error and stores nothing when a streamed put fails midway', async () => {
      const failing = Readable.from(
        (async function* () {
          yield Buffer.from('partial');
          throw new Error('source broke');
        })(),
      );
      const result = await storage.put({ ref, body: failing, contentType: 'text/csv' });
      expect(!result.success && result.error).toBeInstanceOf(UpstreamError);
      expect(unwrap(await storage.stat(ref))).toBeNull();
    });

    it('removes the object on delete', async () => {
      unwrap(await storage.put({ ref, body: Buffer.from('x'), contentType: 'text/csv' }));
      unwrap(await storage.delete(ref));
      expect(unwrap(await storage.stat(ref))).toBeNull();
    });

    it('succeeds when deleting a missing object', async () => {
      expect(unwrap(await storage.delete(ref))).toBeUndefined();
    });

    it('issues a download URL that expires within the requested window', async () => {
      const before = Date.now();
      const download = unwrap(
        await storage.createDownloadUrl({
          ref,
          expiresInSeconds: 300,
          filename: 'errors.csv',
          contentType: 'text/csv',
        }),
      );
      const expiresAt = new Date(download.expiresAt).getTime();
      expect(download.url).toBeTruthy();
      expect(expiresAt).toBeGreaterThan(before);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + 300 * 1000 + 1000);
    });

    it('issues upload instructions that carry the content type', async () => {
      const upload = unwrap(
        await storage.createUpload({
          ref,
          contentType: 'text/csv',
          maxBytes: 1024,
          expiresInSeconds: 300,
        }),
      );
      expect(['PUT', 'POST']).toContain(upload.method);
      expect(upload.headers['Content-Type'] ?? upload.formFields['Content-Type']).toBe('text/csv');
    });

    it('keeps areas isolated for the same relative key', async () => {
      const exportsRef = track('exports', ref.key);
      unwrap(
        await storage.put({ ref: exportsRef, body: Buffer.from('x'), contentType: 'text/csv' }),
      );
      expect(unwrap(await storage.stat(ref))).toBeNull();
      expect(unwrap(await storage.stat(exportsRef))).not.toBeNull();
    });

    it('reports healthy', async () => {
      expect(unwrap(await storage.checkHealth())).toBeUndefined();
    });
  });
}
