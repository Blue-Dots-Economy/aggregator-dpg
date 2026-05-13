import { describe, it, expect } from 'vitest';
import { slugify, randomSuffix, slugFromName, slugWithSuffix } from './slug.js';

describe('slug', () => {
  it('lowercases and replaces non-alphanumerics with hyphens', () => {
    expect(slugify('Hello World!')).toBe('hello-world');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugify('--Foo--')).toBe('foo');
  });

  it('caps slug length at 60 chars', () => {
    const long = 'a'.repeat(120);
    expect(slugify(long).length).toBe(60);
  });

  it('falls back to "org" for empty or fully non-slug input', () => {
    expect(slugify('')).toBe('org');
    expect(slugify('!!!')).toBe('org');
  });

  it('randomSuffix returns a hex string', () => {
    const s = randomSuffix();
    expect(s).toMatch(/^[0-9a-f]+$/);
    expect(s.length).toBe(4);
  });

  it('slugWithSuffix combines stem + hex (legacy alias)', () => {
    const s = slugWithSuffix('TRRAIN');
    expect(s).toMatch(/^trrain-[0-9a-f]{4}$/);
  });

  it('slugFromName produces slug(name)-<hex>', () => {
    const s = slugFromName('SkillBridge Network');
    expect(s).toMatch(/^skillbridge-network-[0-9a-f]{4}$/);
  });

  it('slugFromName falls back to "org" when name slugifies to empty', () => {
    const s = slugFromName('!!!');
    expect(s).toMatch(/^org-[0-9a-f]{4}$/);
  });

  it('slugFromName is non-deterministic across calls (suffix entropy)', () => {
    const a = slugFromName('SkillBridge Network');
    const b = slugFromName('SkillBridge Network');
    expect(a).not.toBe(b);
  });
});
