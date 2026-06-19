import { describe, expect, it } from 'vitest';
import { buildParticipantCsv } from '../../services/participant-csv';
import type { ParticipantBase } from '../../types';

function buildRow(overrides: Partial<ParticipantBase> = {}): ParticipantBase {
  return {
    id: 'item-1',
    name: 'Asha Rao',
    city: 'Bengaluru',
    joined: '01 Jan 2026',
    avatar: 'AR',
    profile: { title: '—', exp: '—', verified: false, complete: 80 },
    applied: { total: 3, accepted: 1, rejected: 1, pending: 1, cancelled: 0 },
    initiated: { create: 1, accept: 1, reject: 1, cancel: 0 },
    received: { create: 0, accept: 0, reject: 0, cancel: 0 },
    status: 'active',
    last: '2d ago',
    lifecycle_status: 'live',
    ...overrides,
  };
}

const HEADER =
  'id,name,joined,profile_completion_pct,lifecycle_status,status,' +
  'initiated_create,initiated_accept,initiated_reject,initiated_cancel,' +
  'received_create,received_accept,received_reject,received_cancel';

describe('buildParticipantCsv', () => {
  it('renders a header plus one line per row', () => {
    const csv = buildParticipantCsv([buildRow(), buildRow({ id: 'item-2', name: 'Vikram' })]);
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(HEADER);
    expect(lines[1]).toBe('item-1,Asha Rao,01 Jan 2026,80,live,active,1,1,1,0,0,0,0,0');
    expect(lines[2]).toContain('item-2,Vikram');
  });

  it('returns just the header for an empty selection', () => {
    expect(buildParticipantCsv([])).toBe(HEADER);
  });

  it('quotes fields containing commas, quotes, and newlines per RFC 4180', () => {
    const csv = buildParticipantCsv([
      buildRow({ name: 'Rao, Asha "AR"' }),
      buildRow({ id: 'item-3', name: 'Line\nBreak' }),
    ]);
    const lines = csv.split('\r\n');
    expect(lines[1]).toContain('"Rao, Asha ""AR"""');
    // The embedded \n stays inside the quoted field — CRLF splitting keeps
    // the quoted segment on what parses back as a single logical record.
    expect(csv).toContain('"Line\nBreak"');
  });

  it('renders a missing lifecycle as an empty field', () => {
    const row = buildRow();
    delete (row as Partial<ParticipantBase>).lifecycle_status;
    const csv = buildParticipantCsv([row]);
    expect(csv.split('\r\n')[1]).toBe('item-1,Asha Rao,01 Jan 2026,80,,active,1,1,1,0,0,0,0,0');
  });
});
