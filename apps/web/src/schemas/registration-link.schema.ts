import type { RJSFSchema, UiSchema } from '@rjsf/utils';

export interface RegistrationLinkFormData {
  org: string;
  state: string;
  lever: string;
  date?: string;
  location?: string;
  district: string;
  domain: 'Seeker' | 'Provider' | 'Both';
  signal: 'Event' | 'Outreach' | 'Partner' | 'Walk-in';
  sub: 'On-ground' | 'Online' | 'Referral';
  full: string;
  type: 'Walk-in' | 'Campaign' | 'Referral' | 'Direct';
}

export const registrationLinkSchema: RJSFSchema = {
  type: 'object',
  // `lever` is enforced client-side via the form's submit guard
  // (see RegistrationLinksSection.tsx). Keeping it out of the schema
  // `required` array preserves backward compat with pre-existing
  // registration links that may have been created without a lever.
  required: ['org', 'state', 'district', 'domain'],
  properties: {
    org: { type: 'string', title: 'Organisation Name' },
    state: { type: 'string', title: 'Instance (State Name)' },
    lever: { type: 'string', title: 'Event' },
    date: { type: 'string', title: 'Event Date', format: 'date' },
    location: { type: 'string', title: 'Event Location' },
    district: { type: 'string', title: 'District' },
    domain: {
      type: 'string',
      title: 'Domain',
      enum: ['Seeker', 'Provider', 'Both'],
    },
    signal: {
      type: 'string',
      title: 'Signal Source',
      enum: ['Event', 'Outreach', 'Partner', 'Walk-in'],
    },
    sub: {
      type: 'string',
      title: 'Signal Sub-Source',
      enum: ['On-ground', 'Online', 'Referral'],
    },
    full: { type: 'string', title: 'Source Full Name' },
    type: {
      type: 'string',
      title: 'Source Type',
      enum: ['Walk-in', 'Campaign', 'Referral', 'Direct'],
    },
  },
};

export const registrationLinkUiSchema: UiSchema = {
  'ui:layout': 'grid',
  org: { 'ui:colSpan': 2 },
  date: { 'ui:widget': 'date' },
  location: { 'ui:options': { placeholder: 'e.g. Hubli' } },
};

export const registrationLinkDefaults: RegistrationLinkFormData = {
  org: 'TRRAIN',
  state: 'Karnataka',
  lever: 'Bluedotathon',
  date: '',
  location: '',
  district: 'Dharwad',
  domain: 'Seeker',
  signal: 'Event',
  sub: 'On-ground',
  full: 'TRRAIN-Hubli-2026',
  type: 'Walk-in',
};
