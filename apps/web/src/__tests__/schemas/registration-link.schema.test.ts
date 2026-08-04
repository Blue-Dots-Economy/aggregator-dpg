import { describe, it, expect } from 'vitest';
import {
  registrationLinkSchema,
  registrationLinkUiSchema,
  registrationLinkDefaults,
} from '@/schemas/registration-link.schema';

describe('registrationLinkSchema', () => {
  it('is an object schema requiring org/state/district/domain', () => {
    expect(registrationLinkSchema.type).toBe('object');
    expect(registrationLinkSchema.required).toEqual(['org', 'state', 'district', 'domain']);
  });

  it('declares the expected enum fields', () => {
    const props = registrationLinkSchema.properties as Record<
      string,
      { enum?: string[]; type?: string }
    >;
    expect(props.domain!.enum).toEqual(['Seeker', 'Provider', 'Both']);
    expect(props.signal!.enum).toEqual(['Event', 'Outreach', 'Partner', 'Walk-in']);
    expect(props.sub!.enum).toEqual(['On-ground', 'Online', 'Referral']);
    expect(props.type!.enum).toEqual(['Walk-in', 'Campaign', 'Referral', 'Direct']);
    expect(props.org!.type).toBe('string');
  });
});

describe('registrationLinkUiSchema', () => {
  it('lays out the grid with a wide org field and date/placeholder widgets', () => {
    expect(registrationLinkUiSchema['ui:layout']).toBe('grid');
    expect((registrationLinkUiSchema.org as { 'ui:colSpan': number })['ui:colSpan']).toBe(2);
    expect((registrationLinkUiSchema.date as { 'ui:widget': string })['ui:widget']).toBe('date');
  });
});

describe('registrationLinkDefaults', () => {
  it('provides valid defaults matching the schema enums', () => {
    const props = registrationLinkSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.domain!.enum).toContain(registrationLinkDefaults.domain);
    expect(props.signal!.enum).toContain(registrationLinkDefaults.signal);
    expect(props.sub!.enum).toContain(registrationLinkDefaults.sub);
    expect(props.type!.enum).toContain(registrationLinkDefaults.type);
    for (const required of registrationLinkSchema.required as string[]) {
      expect(
        registrationLinkDefaults[required as keyof typeof registrationLinkDefaults],
      ).toBeTruthy();
    }
  });
});
