import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { qrFileName, renderQrImages } from '../qr-images-lib.js';

const HEADER = 'line,coordinator_email,profile_type,voice_bot,slug,url,outcome,error_code';

describe('qrFileName', () => {
  it('uses the email local part, profile type and slug, lowercase', () => {
    expect(
      qrFileName({
        coordinatorEmail: 'Asha.Rao@Example.org',
        profileType: 'seeker',
        slug: 'Camp-1',
      }),
    ).toBe('asha-rao-seeker-camp-1.png');
  });

  it('replaces every character outside a-z, 0-9 and dash', () => {
    expect(qrFileName({ coordinatorEmail: 'a_b+c@x.org', profileType: 'p/q', slug: 'x y.z' })).toBe(
      'a-b-c-p-q-x-y-z.png',
    );
  });
});

describe('renderQrImages', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'qr-images-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const csv = [
    HEADER,
    '2,a@x.org,seeker,bot1,camp-a,https://h/r/o/camp-a,created,',
    '3,b@x.org,seeker,bot1,camp-b,https://h/r/o/camp-b,already_loaded,',
    '4,c@x.org,seeker,,,,failed,LINK_NAME_TAKEN',
    '5,d@x.org,seeker,,,,not_run,',
  ].join('\n');

  it('writes only created and already_loaded rows, as PNG files', async () => {
    const result = await renderQrImages(csv, dir);
    expect(result).toEqual({ written: 2, skipped: 2 });
    expect((await readdir(dir)).sort((a, b) => a.localeCompare(b))).toEqual([
      'a-seeker-camp-a.png',
      'b-seeker-camp-b.png',
    ]);
    const bytes = await readFile(join(dir, 'a-seeker-camp-a.png'));
    expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('keeps both images when two rows sanitise to the same name', async () => {
    const clash = [
      HEADER,
      '2,a.b@x.org,seeker,,camp,https://h/r/o/camp,created,',
      '3,a-b@x.org,seeker,,camp,https://h/r/o/camp2,created,',
    ].join('\n');
    expect(await renderQrImages(clash, dir)).toEqual({ written: 2, skipped: 0 });
    expect((await readdir(dir)).sort((a, b) => a.localeCompare(b))).toEqual([
      'a-b-seeker-camp-3.png',
      'a-b-seeker-camp.png',
    ]);
  });

  it('suffixes with the report line column and loops until the name is free', async () => {
    const clash = [
      HEADER,
      '4,a-b@x.org,seeker,,camp-9,https://h/r/o/camp-9,created,',
      '7,a.b@x.org,seeker,,camp,https://h/r/o/camp,created,',
      '9,a-b@x.org,seeker,,camp,https://h/r/o/camp2,created,',
    ].join('\n');
    expect(await renderQrImages(clash, dir)).toEqual({ written: 3, skipped: 0 });
    expect((await readdir(dir)).sort((a, b) => a.localeCompare(b))).toEqual([
      'a-b-seeker-camp-9-2.png',
      'a-b-seeker-camp-9.png',
      'a-b-seeker-camp.png',
    ]);
  });

  it('never starts a file name with a dash', () => {
    expect(qrFileName({ coordinatorEmail: '+x@x.org', profileType: 'seeker', slug: '-c' })).toBe(
      'x-seeker--c.png',
    );
  });

  it('reads the real slug and email behind a formula-neutralising quote', async () => {
    const neutralised = [HEADER, "2,'+91x@x.org,seeker,,'-camp,https://h/r/o/-camp,created,"].join(
      '\n',
    );
    const result = await renderQrImages(neutralised, dir);
    expect(result.written).toBe(1);
    expect(await readdir(dir)).toEqual(['91x-seeker--camp.png']);
  });
});
