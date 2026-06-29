# Proposal: Streaming CSV parse for the Bulk File Processor

**Status:** Implemented (`feat/bulk-streaming-parse`).
**Scope:** `apps/worker` only. No API, schema, or DB-contract changes.
**Goal:** Remove the only synchronous, whole-file-in-memory step in the bulk
upload pipeline so a parse can never stall the worker event loop and peak heap
stops scaling with file size.

## Implementation notes (as landed — deviations from the original sketch)

The sketch below was the starting point; the shipped code differs in three ways
that matter:

1. **Atomicity over incremental enqueue.** The sketch enqueued rows as they
   streamed. That breaks the invariant that a _rejected_ file onboards **zero**
   rows: a late `row_cap`/`row_size` failure would orphan already-enqueued row
   jobs and partially onboard a bad file. The implementation instead
   _stream-parses + validates_ incrementally (removing the synchronous
   `Papa.parse` + `split('\n')` — the event-loop block and the whole-file string
   copies) and returns the validated rows; the caller enqueues only on full
   success. Memory is bounded by `BULK_MAX_ROWS`.
2. **`:lines` is a Redis HASH keyed by rowIndex, not an `rpush` list.** The
   Finaliser `hmget`s lines by failed-row index and re-parses them positionally.
   Each line is reconstructed with `Papa.unparse(cells)` (header order), which
   round-trips through the Finaliser's `parseRawRow`. The sketch's `rpush` was
   wrong.
3. **Headers via `transformHeader` assigned by index.** `NODE_STREAM_INPUT`
   invokes `transformHeader` more than once per column, so headers are written
   to `headers[index]` (idempotent) rather than pushed. This also lets a
   header-only file still report `header_mismatch` over `empty_csv`.

Also landed: direct replacement (`downloadCsvAsString` removed; no feature flag,
per decision) and the worker-role split (`WORKER_ROLES`, see §"Rollout" #5) so
the parser can run in its own deployment. The core lives in
`apps/worker/src/jobs/bulk-file-stream.ts` (`streamCsvParse`,
`createUtf8DecodeStream`, `reconstructCsvLine`), unit-tested in
`bulk-file-stream.test.ts`; orchestration is covered in
`bulk-file-process.test.ts`; role parsing in `worker-roles.test.ts`.

---

## 1. Why

Today the File Processor downloads the entire object into one string and parses it
**synchronously**:

- `downloadCsvAsString` buffers the whole object (`apps/worker/src/object-storage.ts:35-49`).
- `Papa.parse(body, …)` runs with no `step`/`chunk` callback → synchronous
  (`apps/worker/src/jobs/bulk-file-process.ts:122`).
- `body.split('\n')` + per-line byte scan, also synchronous (`…:159-166`).

All five BullMQ workers share one process with in-process processors
(`apps/worker/src/main.ts:34-75`), so during a parse the row/finalise workers are
blocked on the same event loop. A 10 MB file also produces a ~100–200 MB heap
spike (string + parsed object array), which is what really bounds concurrency.

Streaming fixes both: parsing yields to the event loop between chunks, and only a
bounded window of rows is resident at a time.

> Pair this with splitting the file-processor into its own worker process/
> deployment (cheap, independent change) for full isolation. Streaming alone
> already removes the blocking + memory spike.

---

## 2. Design

Keep **all existing validations and side effects** — only the mechanism changes:

| Concern                  | Today (whole-file)                       | Streaming                                                               |
| ------------------------ | ---------------------------------------- | ----------------------------------------------------------------------- |
| Download                 | buffer to string                         | return the S3 `GetObject` Node `Readable`                               |
| Encoding                 | scan full string for U+FFFD              | decode with a `TextDecoder('utf-8', {fatal:true})` transform; fail fast |
| Header validation        | after full parse, `parsed.meta.fields`   | on the **first** row (`step`), then abort stream on mismatch            |
| Row cap                  | `rows.length > BULK_MAX_ROWS`            | running counter; abort stream the moment it exceeds                     |
| Row-byte cap             | `Buffer.byteLength(line)` per split line | per-row byte counter in a passthrough (see §4 caveat)                   |
| Enqueue                  | slice into 1000-row chunks after parse   | flush a 1000-row buffer **as it fills**, during the stream              |
| Redis `:lines` / `:meta` | written after parse                      | `:lines` appended per chunk; `total` + `reader_done` set at `complete`  |

Ordering invariant preserved: enqueue all row jobs **before** setting `total` +
`reader_done` in Redis, so the Row Processor can't see `processed == total` early
and trigger the Finaliser prematurely (same rule as the current code,
`bulk-file-process.ts:180-183`).

---

## 3. Code sketch

### 3.1 `object-storage.ts` — add a streaming reader (keep the old one until cutover)

```ts
import { GetObjectCommand } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';

/**
 * Returns the S3 object body as a Node Readable WITHOUT buffering it.
 * Caller is responsible for consuming/destroying the stream.
 */
export async function getCsvStream(s3Key: string): Promise<Readable> {
  const result = await getClient().send(
    new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: s3Key }),
  );
  const body = result.Body;
  if (!body) throw new Error(`empty body for s3 key: ${s3Key}`);
  // In the Node runtime the SDK returns a Readable.
  return body as Readable;
}
```

### 3.2 `bulk-file-process.ts` — stream-parse with PapaParse `NODE_STREAM_INPUT`

```ts
import Papa from 'papaparse';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { getCsvStream } from '../object-storage.js';

const ENQUEUE_CHUNK = 1000;

// Replaces steps 1–6 (download → parse → header/row/size checks → enqueue).
async function streamParseAndEnqueue(job: BulkFileProcessJob, schemaValue, log) {
  const required = extractRequiredFields(schemaValue);
  const allowed = new Set(extractAllProperties(schemaValue));
  const redis = getRedis();
  const ns = `bu:${job.uploadId}`;

  let headersValidated = false;
  let headers: string[] = [];
  let total = 0;
  let rowBuf: Array<Record<string, string>> = [];
  let rawBuf: string[] = [];
  let failure: { reason: FileFailureReason; detail?: string } | null = null;

  const src = await getCsvStream(job.s3Key);

  // fatal:true makes non-UTF-8 throw instead of emitting U+FFFD.
  const decode = new TextDecoder('utf-8', { fatal: true });
  const toUtf8 = new Transform({
    transform(chunk, _enc, cb) {
      try {
        cb(null, decode.decode(chunk, { stream: true }));
      } catch {
        cb(new FileError('encoding_unsupported'));
      }
    },
  });

  const csvStream = Papa.parse(Papa.NODE_STREAM_INPUT, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
  });

  const flush = async () => {
    if (rowBuf.length === 0) return;
    const baseIndex = total - rowBuf.length;
    await enqueueRowProcessBulk(
      rowBuf.map((row, j) => ({
        uploadId: job.uploadId,
        aggregatorId: job.aggregatorId,
        rowIndex: baseIndex + j,
        schemaId: job.schemaId,
        schemaVersion: job.schemaVersion,
        participantType: job.participantType,
        payload: row,
      })),
    );
    // Preserve the Finaliser's raw-line reconstruction (bu:{id}:lines).
    await redis.rpush(`${ns}:lines`, ...rawBuf);
    rowBuf = [];
    rawBuf = [];
  };

  const sink = new Transform({
    objectMode: true,
    transform(result: Papa.ParseStepResult<Record<string, string>>, _enc, cb) {
      void (async () => {
        try {
          if (!headersValidated) {
            headers = (result.meta.fields ?? []).map((h) => h.trim());
            const missing = required.filter((f) => !headers.includes(f));
            const unknown = headers.filter((h) => !allowed.has(h));
            if (missing.length)
              return cb(new FileError('header_mismatch', `missing: ${missing.join(',')}`));
            if (unknown.length)
              return cb(new FileError('header_mismatch', `unknown: ${unknown.join(',')}`));
            await redis.hset(
              `${ns}:meta`,
              'started_at',
              String(jobStartedAt),
              'headers',
              JSON.stringify(headers),
            );
            headersValidated = true;
          }
          const row = result.data;
          // Row-byte cap — see §4 caveat for the exact measurement.
          const raw = headers.map((h) => row[h] ?? '').join(',');
          if (Buffer.byteLength(raw, 'utf8') > config.BULK_MAX_ROW_BYTES) {
            return cb(new FileError('row_size_exceeded'));
          }
          total += 1;
          if (total > config.BULK_MAX_ROWS) return cb(new FileError('row_cap_exceeded'));
          rowBuf.push(row);
          rawBuf.push(raw);
          if (rowBuf.length >= ENQUEUE_CHUNK) await flush();
          cb();
        } catch (err) {
          cb(err as Error);
        }
      })();
    },
  });

  try {
    await pipeline(src, toUtf8, csvStream, sink);
    await flush(); // final partial chunk
  } catch (err) {
    failure =
      err instanceof FileError
        ? { reason: err.reason, detail: err.detail }
        : { reason: 'system_error' };
  }

  if (failure) {
    await markStatus(job.uploadId, 'file_failed', failure.detail ?? failure.reason);
    return { status: 'failed' as const, ...failure };
  }
  if (total === 0) {
    await markStatus(job.uploadId, 'file_failed', 'empty_csv');
    return { status: 'failed' as const, reason: 'empty_csv' as const };
  }

  // Enqueue done → NOW publish total + reader_done (ordering invariant).
  await getDb()
    .update(schema.bulkUploads)
    .set({ status: 'row_processing', lastProgressAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.bulkUploads.id, job.uploadId));
  await redis.hset(`${ns}:meta`, 'total_rows', String(total), 'reader_done', '1');

  return { status: 'enqueued' as const, totalRows: total };
}

class FileError extends Error {
  constructor(
    public reason: FileFailureReason,
    public detail?: string,
  ) {
    super(reason);
  }
}
```

The outer `processBulkFile` keeps its idempotency guard (`bulk-file-process.ts:57-78`)
and its `file_validating` transition, then calls `streamParseAndEnqueue` instead of
the download → parse → checks → enqueue block.

---

## 4. Caveats / decisions to confirm before implementing

1. **Row-byte measurement.** The current code measures the raw source line
   (`Buffer.byteLength(line)`); streaming `step` gives the _parsed_ object, not the
   raw line. The sketch reconstructs an approximation (`headers.join(',')`). If an
   exact raw-line cap matters, insert a line-counting passthrough that also handles
   RFC-4180 quoted newlines, or switch to `csv-parse` whose `info.bytes` exposes
   per-record source length directly. **Pick one before coding.**
2. **PapaParse Node stream API.** `Papa.parse(Papa.NODE_STREAM_INPUT, opts)` returns
   a Transform you pipe into; rows arrive as `data` events / object-mode reads.
   Confirm against the pinned `papaparse@5.4.1` typings — the `ParseStepResult`
   shape and `NODE_STREAM_INPUT` export are stable in v5 but the TS types are thin.
3. **Backpressure.** `enqueueRowProcessBulk` is awaited inside the sink transform,
   so the stream naturally pauses while a chunk is enqueued — good. Keep the await;
   don't fire-and-forget or memory will grow again.
4. **`:lines` write volume.** Per-chunk `rpush` of 1000 raw lines is fine; if files
   grow, consider a capped list or only persisting lines for failed rows.
5. **Encoding.** `TextDecoder({fatal:true})` replaces the U+FFFD heuristic with a
   hard decode error — stricter and cheaper, but verify the BOM is still stripped
   (decode the first chunk and slice a leading U+FEFF).

---

## 5. Validation plan

- Unit: feed fixtures through `streamParseAndEnqueue` with a fake Redis + queue —
  assert identical enqueue payloads, `total`, and failure reasons vs the current
  implementation for: clean file, header mismatch, oversize row, row-cap exceeded,
  empty file, non-UTF-8.
- Memory: parse a max-size file and assert peak RSS stays bounded (no
  size-proportional spike) via a `--expose-gc` harness.
- Event-loop: assert `perf_hooks` `monitorEventLoopDelay` p99 stays low while a
  large file parses concurrently with row jobs in the same process.
- Parity: byte-for-byte compare the resulting errors.csv for a known fixture
  before/after.

---

## 6. Rollout

1. Land `getCsvStream` alongside the existing `downloadCsvAsString` (no removal).
2. Implement `streamParseAndEnqueue` behind a `BULK_STREAMING_PARSE` flag.
3. Shadow-run on staging; compare enqueue/finalise parity.
4. Flip the flag in prod; remove `downloadCsvAsString` once stable.
5. (Independent) split the file-processor into its own worker deployment.
