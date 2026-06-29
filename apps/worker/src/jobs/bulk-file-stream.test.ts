/**
 * Unit tests for the streaming CSV parse core.
 *
 * `streamCsvParse` is the pure, I/O-free heart of the File Processor: it
 * consumes a byte/string stream, validates the header against the active
 * schema, enforces the row-count and per-row-byte caps, and returns the
 * validated rows for the caller to enqueue. It never touches S3, Redis, or the
 * DB — those are wired around it in `bulk-file-process.ts` — so it can be
 * exercised end-to-end here with in-memory streams.
 *
 * @module @aggregator-dpg/worker
 */

import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import Papa from 'papaparse';
import { streamCsvParse, reconstructCsvLine, createUtf8DecodeStream } from './bulk-file-stream.js';

const HEADER = 'name,email,city';
const REQUIRED = ['name', 'email'];
const ALLOWED = new Set(['name', 'email', 'city']);

function opts(overrides: Partial<Parameters<typeof streamCsvParse>[1]> = {}) {
  return {
    required: REQUIRED,
    allowed: ALLOWED,
    maxRows: 10_000,
    maxRowBytes: 64 * 1024,
    ...overrides,
  };
}

describe('streamCsvParse — happy path', () => {
  it('parses a well-formed CSV into rows with correct index, payload, and headers', async () => {
    const csv = [HEADER, 'Asha,asha@x.io,Pune', 'Ravi,ravi@x.io,Delhi'].join('\n');
    const res = await streamCsvParse(csv, opts());

    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.headers).toEqual(['name', 'email', 'city']);
    expect(res.rows).toHaveLength(2);
    expect(res.rows[0]).toMatchObject({
      rowIndex: 0,
      payload: { name: 'Asha', email: 'asha@x.io', city: 'Pune' },
    });
    expect(res.rows[1]!.rowIndex).toBe(1);
  });

  it('trims header whitespace and skips greedy-empty lines', async () => {
    const csv = ['  name , email , city ', 'Asha,asha@x.io,Pune', '', '   '].join('\n');
    const res = await streamCsvParse(csv, opts());
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.headers).toEqual(['name', 'email', 'city']);
    expect(res.rows).toHaveLength(1);
  });

  it('accepts a Node byte stream (S3-style) as input', async () => {
    const csv = [HEADER, 'Asha,asha@x.io,Pune'].join('\n');
    const stream = Readable.from([Buffer.from(csv, 'utf8')]);
    const res = await streamCsvParse(stream, opts());
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.rows).toHaveLength(1);
  });
});

describe('streamCsvParse — header validation', () => {
  it('fails with header_mismatch when a required column is missing', async () => {
    const csv = ['name,city', 'Asha,Pune'].join('\n');
    const res = await streamCsvParse(csv, opts());
    expect(res.status).toBe('failed');
    if (res.status !== 'failed') return;
    expect(res.reason).toBe('header_mismatch');
    expect(res.detail).toContain('email');
  });

  it('fails with header_mismatch when an unknown column is present', async () => {
    const csv = ['name,email,city,ssn', 'Asha,asha@x.io,Pune,123'].join('\n');
    const res = await streamCsvParse(csv, opts());
    expect(res.status).toBe('failed');
    if (res.status !== 'failed') return;
    expect(res.reason).toBe('header_mismatch');
    expect(res.detail).toContain('ssn');
  });

  it('validates headers even for a header-only file (no data rows) — mismatch wins over empty', async () => {
    const res = await streamCsvParse('name,city', opts());
    expect(res.status).toBe('failed');
    if (res.status !== 'failed') return;
    expect(res.reason).toBe('header_mismatch');
  });
});

describe('streamCsvParse — empty input', () => {
  it('fails with empty_csv on a totally empty stream', async () => {
    const res = await streamCsvParse('', opts());
    expect(res.status).toBe('failed');
    if (res.status !== 'failed') return;
    expect(res.reason).toBe('empty_csv');
  });

  it('fails with empty_csv on a valid-header-only file with zero data rows', async () => {
    const res = await streamCsvParse(HEADER, opts());
    expect(res.status).toBe('failed');
    if (res.status !== 'failed') return;
    expect(res.reason).toBe('empty_csv');
  });
});

describe('streamCsvParse — caps', () => {
  it('fails with row_cap_exceeded when rows exceed maxRows', async () => {
    const csv = [HEADER, 'a,a@x.io,P', 'b,b@x.io,Q', 'c,c@x.io,R'].join('\n');
    const res = await streamCsvParse(csv, opts({ maxRows: 2 }));
    expect(res.status).toBe('failed');
    if (res.status !== 'failed') return;
    expect(res.reason).toBe('row_cap_exceeded');
  });

  it('accepts exactly maxRows rows', async () => {
    const csv = [HEADER, 'a,a@x.io,P', 'b,b@x.io,Q'].join('\n');
    const res = await streamCsvParse(csv, opts({ maxRows: 2 }));
    expect(res.status).toBe('ok');
  });

  it('fails with row_size_exceeded when a reconstructed row exceeds maxRowBytes', async () => {
    const big = 'x'.repeat(200);
    const csv = [HEADER, `Asha,asha@x.io,${big}`].join('\n');
    const res = await streamCsvParse(csv, opts({ maxRowBytes: 64 }));
    expect(res.status).toBe('failed');
    if (res.status !== 'failed') return;
    expect(res.reason).toBe('row_size_exceeded');
  });
});

describe('streamCsvParse — encoding', () => {
  it('strips a UTF-8 BOM from the header', async () => {
    const csv = `﻿${HEADER}\nAsha,asha@x.io,Pune`;
    const res = await streamCsvParse(csv, opts());
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    // BOM must not leak into the first header name.
    expect(res.headers[0]).toBe('name');
  });

  it('fails with encoding_unsupported on invalid UTF-8 bytes', async () => {
    // 0xFF 0xFE is not valid UTF-8.
    const bad = Buffer.concat([Buffer.from(`${HEADER}\n`), Buffer.from([0xff, 0xfe, 0x41])]);
    const res = await streamCsvParse(Readable.from([bad]), opts());
    expect(res.status).toBe('failed');
    if (res.status !== 'failed') return;
    expect(res.reason).toBe('encoding_unsupported');
  });
});

describe('reconstructCsvLine — Finaliser :lines contract', () => {
  it('round-trips through positional re-parse to the original cell values', () => {
    const headers = ['name', 'email', 'note'];
    const payload = { name: 'Asha', email: 'asha@x.io', note: 'has, comma "and" quote' };
    const line = reconstructCsvLine(headers, payload);
    // The Finaliser re-parses each stored line positionally (header:false).
    const cells = (Papa.parse<string[]>(line, { header: false }).data[0] ?? []) as string[];
    expect(cells).toEqual(['Asha', 'asha@x.io', 'has, comma "and" quote']);
  });

  it('emits cells in header order, filling missing keys with empty strings', () => {
    const headers = ['a', 'b', 'c'];
    const line = reconstructCsvLine(headers, { b: 'two' });
    const cells = (Papa.parse<string[]>(line, { header: false }).data[0] ?? []) as string[];
    expect(cells).toEqual(['', 'two', '']);
  });

  it('appends surplus cells from a ragged row (PapaParse __parsed_extra)', () => {
    const headers = ['a', 'b'];
    const line = reconstructCsvLine(headers, { a: 'x', b: 'y', __parsed_extra: ['z1', 'z2'] });
    const cells = (Papa.parse<string[]>(line, { header: false }).data[0] ?? []) as string[];
    expect(cells).toEqual(['x', 'y', 'z1', 'z2']);
  });
});

describe('streamCsvParse — ragged rows', () => {
  it('keeps surplus columns in rawLine but excludes PapaParse internals from payload', async () => {
    // Header has 2 cols; the data row has 3 → the 3rd lands in __parsed_extra.
    const res = await streamCsvParse('name,email\nAsha,a@x.io,SURPLUS', {
      required: ['name', 'email'],
      allowed: new Set(['name', 'email']),
      maxRows: 10,
      maxRowBytes: 64 * 1024,
    });
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    // payload is schema-keyed strings only — no __parsed_extra leak.
    expect(res.rows[0]!.payload).toEqual({ name: 'Asha', email: 'a@x.io' });
    // rawLine preserves the surplus column for the errors.csv report.
    const cells = (Papa.parse<string[]>(res.rows[0]!.rawLine, { header: false }).data[0] ??
      []) as string[];
    expect(cells).toEqual(['Asha', 'a@x.io', 'SURPLUS']);
  });
});

describe('streamCsvParse — rawLine on returned rows', () => {
  it('attaches a reconstructed rawLine that re-parses to the row cells', async () => {
    const csv = [HEADER, 'Asha,"a@x.io",Pune'].join('\n');
    const res = await streamCsvParse(csv, opts());
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    const cells = (Papa.parse<string[]>(res.rows[0]!.rawLine, { header: false }).data[0] ??
      []) as string[];
    expect(cells).toEqual(['Asha', 'a@x.io', 'Pune']);
  });
});

describe('createUtf8DecodeStream', () => {
  it('passes through valid UTF-8 and concatenates to the original text', async () => {
    const src = Readable.from([Buffer.from('héllo, '), Buffer.from('wörld')]);
    let out = '';
    for await (const chunk of src.pipe(createUtf8DecodeStream())) out += chunk;
    expect(out).toBe('héllo, wörld');
  });

  it('emits an error tagged as an encoding failure on invalid UTF-8', async () => {
    const src = Readable.from([Buffer.from([0xff, 0xfe])]);
    await expect(
      (async () => {
        for await (const _ of src.pipe(createUtf8DecodeStream())) void _;
      })(),
    ).rejects.toThrowError(/encoding/i);
  });
});
