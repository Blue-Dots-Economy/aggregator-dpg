import { describe, it, expect } from 'vitest';
import { servedDomains, servesForCreate, servesOf } from '../serves.js';

const NETWORK = ['seeker', 'provider'];

describe('servesOf', () => {
  it('stores one domain as a one-element list', () => {
    expect(servesOf('seeker')).toEqual(['seeker']);
  });

  it('stores null (every domain) as an empty list', () => {
    expect(servesOf(null)).toEqual([]);
  });
});

describe('servedDomains', () => {
  it('returns every network domain for an empty list', () => {
    expect(servedDomains([], NETWORK)).toEqual(['seeker', 'provider']);
  });

  it('returns the one domain served', () => {
    expect(servedDomains(['provider'], NETWORK)).toEqual(['provider']);
  });

  it('returns several domains in network order', () => {
    expect(servedDomains(['provider', 'seeker'], NETWORK)).toEqual(['seeker', 'provider']);
  });

  it('drops ids the network does not declare', () => {
    expect(servedDomains(['seeker', 'retired'], NETWORK)).toEqual(['seeker']);
  });

  it('returns nothing when no stored id is in the network', () => {
    expect(servedDomains(['retired'], NETWORK)).toEqual([]);
  });

  it('returns nothing for a network with no domains', () => {
    expect(servedDomains([], [])).toEqual([]);
  });
});

describe('servesForCreate', () => {
  it('uses the list when given', () => {
    expect(servesForCreate({ type: 'seeker', serves: ['seeker', 'provider'] })).toEqual([
      'seeker',
      'provider',
    ]);
  });

  it('drops repeats from the list', () => {
    expect(servesForCreate({ type: null, serves: ['seeker', 'seeker'] })).toEqual(['seeker']);
  });

  it('keeps an empty list as every domain', () => {
    expect(servesForCreate({ type: 'seeker', serves: [] })).toEqual([]);
  });

  it('falls back to type when no list is given', () => {
    expect(servesForCreate({ type: 'provider' })).toEqual(['provider']);
    expect(servesForCreate({ type: null })).toEqual([]);
  });
});
