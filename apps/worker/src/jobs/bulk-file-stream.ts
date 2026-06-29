/**
 * Streaming CSV parse core for the Bulk File Processor.
 *
 * This module is the pure, I/O-free heart of file processing. It consumes a
 * byte or string stream, decodes it as strict UTF-8, validates the header
 * against the active schema, enforces the row-count and per-row-byte caps, and
 * returns the validated rows for the caller to enqueue.
 *
 * Why streaming: the previous implementation buffered the whole object into a
 * single string and ran a synchronous `Papa.parse` over it (plus a
 * `body.split('\n')` copy), blocking the worker event loop for the parse
 * duration and spiking heap to a multiple of the file size. Parsing the S3
 * body stream incrementally removes both: the parser yields to the event loop
 * between network chunks and only a bounded window of rows is resident.
 *
 * Atomicity: validation can fail late (e.g. a row past `maxRows`). To preserve
 * the invariant that a rejected file onboards **zero** rows, this function does
 * not enqueue as it parses — it accumulates validated rows and returns them so
 * the caller enqueues only after a fully successful parse. Memory stays bounded
 * by `maxRows`, well under the old whole-file blow-up.
 *
 * @module @aggregator-dpg/worker
 */

import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import Papa from 'papaparse';

/** Reasons the File Processor can reject a file before per-row work begins. */
export type FileFailureReason =
  | 'encoding_unsupported'
  | 'header_mismatch'
  | 'empty_csv'
  | 'row_cap_exceeded'
  | 'row_size_exceeded'
  | 'schema_unavailable'
  | 'system_error';

/** A single validated data row produced by {@link streamCsvParse}. */
export interface StreamedRow {
  /** Zero-based index among non-empty data rows (excludes the header). */
  rowIndex: number;
  /** Parsed cell values keyed by trimmed header name. */
  payload: Record<string, string>;
  /**
   * The row re-serialised as one CSV line in header-column order. The Finaliser
   * stores this under `bu:{id}:lines` and re-parses it positionally to rebuild
   * errors.csv, so it must round-trip through `Papa.parse(header:false)`.
   */
  rawLine: string;
}

/** Validation inputs and caps for {@link streamCsvParse}. */
export interface StreamCsvOptions {
  /** Required header columns (from the schema `required` array). */
  required: string[];
  /** Permitted header columns (the schema `properties` keys). */
  allowed: ReadonlySet<string>;
  /** Maximum number of data rows; exceeding it fails `row_cap_exceeded`. */
  maxRows: number;
  /** Maximum bytes for a single reconstructed row line. */
  maxRowBytes: number;
}

/** Outcome of a streaming parse: validated rows, or a typed failure. */
export type StreamCsvResult =
  | { status: 'ok'; headers: string[]; rows: StreamedRow[] }
  | { status: 'failed'; reason: FileFailureReason; detail?: string };

/** Marker error so the pipeline can distinguish a decode failure from any other. */
class EncodingError extends Error {
  constructor() {
    super('encoding_unsupported: stream is not valid UTF-8');
    this.name = 'EncodingError';
  }
}

/** Carries a typed file-level failure out of the streaming pipeline. */
class ParseFailure extends Error {
  constructor(
    public readonly reason: FileFailureReason,
    public readonly detail?: string,
  ) {
    super(reason);
    this.name = 'ParseFailure';
  }
}

/**
 * Returns a Transform that decodes a byte stream to UTF-8 strings, rejecting
 * any non-UTF-8 input instead of emitting U+FFFD replacement characters. A
 * leading BOM is stripped (the default `TextDecoder` behaviour).
 *
 * @returns A Transform suitable for piping an S3 object body through.
 */
export function createUtf8DecodeStream(): Transform {
  // fatal:true → decode() throws on malformed sequences. The decoder keeps
  // state across chunks (stream:true) so a multi-byte char split across two
  // network chunks is not mistaken for invalid input.
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return new Transform({
    decodeStrings: true,
    transform(chunk: Buffer, _enc, cb) {
      try {
        cb(null, decoder.decode(chunk, { stream: true }));
      } catch {
        cb(new EncodingError());
      }
    },
    flush(cb) {
      try {
        // Final decode with stream:false surfaces a dangling partial sequence.
        cb(null, decoder.decode());
      } catch {
        cb(new EncodingError());
      }
    },
  });
}

/**
 * Re-serialises a parsed row as a single CSV line in header-column order,
 * filling missing keys with empty strings. Values are quoted/escaped by
 * PapaParse so the line re-parses (positionally) to the same cells.
 *
 * @param headers - Column names in the order they appeared in the header row.
 * @param payload - Parsed row keyed by header name.
 * @returns One CSV-encoded line (no trailing newline).
 */
export function reconstructCsvLine(headers: string[], payload: Record<string, string>): string {
  const cells = headers.map((h) => payload[h] ?? '');
  return Papa.unparse([cells], { header: false });
}

/**
 * Streams and validates a CSV, returning its data rows for enqueueing.
 *
 * Validation precedence matches the previous whole-file implementation:
 * encoding → header (missing/unknown columns) → empty → per-row caps. On any
 * failure no rows are returned, so the caller onboards nothing.
 *
 * @param input - The CSV as a Node byte stream (e.g. an S3 body) or a string.
 * @param options - Required/allowed columns and the row-count / row-byte caps.
 * @returns `ok` with validated rows + headers, or a typed `failed` result.
 */
export async function streamCsvParse(
  input: Readable | string,
  options: StreamCsvOptions,
): Promise<StreamCsvResult> {
  const headers: string[] = [];
  // PapaParse calls transformHeader for each column as the header row is
  // parsed — before any data row — so `headers` is complete by the first row
  // and also for header-only files (lets header_mismatch win over empty_csv).
  // NODE_STREAM_INPUT invokes transformHeader more than once per column, so we
  // assign by index (idempotent) rather than push (which would duplicate).
  const parseStream = Papa.parse(Papa.NODE_STREAM_INPUT, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h: string, index: number) => {
      const trimmed = h.trim();
      headers[index] = trimmed;
      return trimmed;
    },
  });

  const byteSrc = typeof input === 'string' ? Readable.from([Buffer.from(input, 'utf8')]) : input;

  let headerChecked = false;
  const rows: StreamedRow[] = [];

  const validateHeaders = (): { reason: FileFailureReason; detail?: string } | null => {
    const headerSet = new Set(headers);
    const missing = options.required.filter((f) => !headerSet.has(f));
    if (missing.length > 0) {
      return { reason: 'header_mismatch', detail: `missing: ${missing.join(',')}` };
    }
    const unknown = headers.filter((h) => !options.allowed.has(h));
    if (unknown.length > 0) {
      return { reason: 'header_mismatch', detail: `unknown: ${unknown.join(',')}` };
    }
    return null;
  };

  try {
    await pipeline(
      byteSrc,
      createUtf8DecodeStream(),
      parseStream,
      async (parsed: AsyncIterable<Record<string, string>>) => {
        for await (const row of parsed) {
          if (!headerChecked) {
            headerChecked = true;
            const headerFailure = validateHeaders();
            if (headerFailure) throw new ParseFailure(headerFailure.reason, headerFailure.detail);
          }
          const rawLine = reconstructCsvLine(headers, row);
          if (Buffer.byteLength(rawLine, 'utf8') > options.maxRowBytes) {
            throw new ParseFailure('row_size_exceeded');
          }
          if (rows.length + 1 > options.maxRows) {
            throw new ParseFailure('row_cap_exceeded', String(rows.length + 1));
          }
          rows.push({ rowIndex: rows.length, payload: row, rawLine });
        }
      },
    );
  } catch (err) {
    if (err instanceof EncodingError) {
      return { status: 'failed', reason: 'encoding_unsupported' };
    }
    if (err instanceof ParseFailure) {
      return {
        status: 'failed',
        reason: err.reason,
        ...(err.detail !== undefined ? { detail: err.detail } : {}),
      };
    }
    return { status: 'failed', reason: 'system_error', detail: (err as Error).message };
  }

  // Header-only file: transformHeader ran but no data row triggered the check.
  // Validate now so a bad header still reports header_mismatch over empty_csv.
  if (!headerChecked && headers.length > 0) {
    const headerFailure = validateHeaders();
    if (headerFailure) return { status: 'failed', ...headerFailure };
  }
  if (rows.length === 0) {
    return { status: 'failed', reason: 'empty_csv' };
  }

  return { status: 'ok', headers, rows };
}
