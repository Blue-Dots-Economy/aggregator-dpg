import { describe, it, expect } from 'vitest';
import { coordinatorLocations, renderOrgDetails } from '../org-details.js';

const loc = (street: string) => [
  { geo: { type: 'Point' as const, coordinates: [1, 2] }, address: { streetAddress: street } },
];
const org = {
  url: 'https://org.example',
  legalName: 'Org Ltd',
  gstNumber: 'G-ORG',
};

describe('renderOrgDetails', () => {
  it("renders the org's values over the coordinator's own", () => {
    expect(
      renderOrgDetails(org, {
        url: 'https://own.example',
        locations: loc('Own st'),
        company: 'Own',
      }),
    ).toEqual({ url: org.url, company: 'Org Ltd', gstNumber: 'G-ORG' });
  });

  it('falls back per field when the org has none', () => {
    expect(
      renderOrgDetails(
        { url: null, legalName: null, gstNumber: 'G-ORG' },
        {
          url: 'https://own.example',
          company: 'Own',
          gstNumber: 'G-OWN',
        },
      ),
    ).toEqual({
      url: 'https://own.example',
      company: 'Own',
      gstNumber: 'G-ORG',
    });
  });

  it('treats blank strings and recorded empties as absent', () => {
    expect(
      renderOrgDetails({ url: '  ', legalName: '', gstNumber: null }, { url: null, company: null }),
    ).toEqual({ url: null, company: undefined, gstNumber: undefined });
  });

  it('handles an unknown org and no legacy values', () => {
    expect(renderOrgDetails(null, null)).toEqual({
      url: null,
      company: undefined,
      gstNumber: undefined,
    });
  });
});

describe('coordinatorLocations', () => {
  it("returns the coordinator's own users.locations", () => {
    expect(coordinatorLocations(loc('Own st'), { locations: loc('Legacy st') })).toEqual(
      loc('Own st'),
    );
  });

  it('falls back to the legacy address when users.locations is empty', () => {
    expect(coordinatorLocations([], { locations: loc('Legacy st') })).toEqual(loc('Legacy st'));
  });

  it('is empty when the coordinator gave no address', () => {
    expect(coordinatorLocations([], null)).toEqual([]);
    expect(coordinatorLocations(undefined, { url: 'https://own.example' })).toEqual([]);
  });
});
