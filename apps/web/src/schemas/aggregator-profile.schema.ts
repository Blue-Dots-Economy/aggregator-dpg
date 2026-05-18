import type { RJSFSchema, UiSchema } from '@rjsf/utils';

export interface AggregatorProfileFormData {
  org: string;
  type: 'Seeker' | 'Provider';
  registration: string;
  established?: string;
  coordinator: string;
  coordinatorMobile: string;
  about?: string;
  beneficiaries: string;
  sectors: 'Retail' | 'F&B' | 'Logistics' | 'Customer Service';
  targetHires?: string;
  preferredRoles?: string;
  geographies: string;
  networkSize?: string;
  trainingPrograms?: string;
  address?: string;
  consentProfile: boolean;
  consentSharing: boolean;
  consentNotifications: boolean;
  consentAnalytics: boolean;
  consentMarketing: boolean;
  consentRetention: boolean;
}

export const aggregatorProfileSchema: RJSFSchema = {
  type: 'object',
  required: [
    'org',
    'type',
    'coordinator',
    'coordinatorMobile',
    'beneficiaries',
    'sectors',
    'geographies',
    'consentProfile',
    'consentSharing',
    'consentRetention',
  ],
  properties: {
    org: { type: 'string', title: 'Organisation Name' },
    type: {
      type: 'string',
      title: 'Aggregator Type',
      enum: ['Seeker', 'Provider'],
    },
    registration: { type: 'string', title: 'Registration Number' },
    established: { type: 'string', title: 'Established', format: 'date' },
    coordinator: { type: 'string', title: 'Coordinator Name' },
    coordinatorMobile: { type: 'string', title: 'Coordinator Mobile' },
    about: {
      type: 'string',
      title: 'About',
      description: '2–3 sentences. Will appear on public profiles.',
    },
    beneficiaries: { type: 'string', title: 'Beneficiary Groups' },
    sectors: {
      type: 'string',
      title: 'Sectors',
      enum: ['Retail', 'F&B', 'Logistics', 'Customer Service'],
    },
    targetHires: { type: 'string', title: 'Target Hires per Quarter' },
    preferredRoles: { type: 'string', title: 'Preferred Roles' },
    geographies: { type: 'string', title: 'Geographies Served' },
    networkSize: { type: 'string', title: 'Active Network Size' },
    trainingPrograms: { type: 'string', title: 'Training Programs' },
    address: { type: 'string', title: 'Office Address' },
    consentProfile: {
      type: 'boolean',
      title: 'I consent to profile creation & representation in the Blue Dots ecosystem.',
      default: true,
    },
    consentSharing: {
      type: 'boolean',
      title:
        'I consent to sharing information with verified relevant parties (seekers, providers, partners).',
      default: true,
    },
    consentNotifications: {
      type: 'boolean',
      title:
        'I consent to receive opportunity notifications & nudges via SMS, WhatsApp, and email.',
      default: true,
    },
    consentAnalytics: {
      type: 'boolean',
      title: 'I consent to anonymous analytics for ecosystem improvement.',
      default: true,
    },
    consentMarketing: {
      type: 'boolean',
      title: 'I would like to receive marketing from partner organisations.',
      default: false,
    },
    consentRetention: {
      type: 'boolean',
      title: 'I confirm data will be retained per Blue Dots policy v2.3.',
      default: true,
    },
  },
};

export const aggregatorProfileUiSchema: UiSchema = {
  'ui:layout': 'grid',
  about: {
    'ui:widget': 'textarea',
    'ui:colSpan': 2,
  },
  beneficiaries: { 'ui:colSpan': 2 },
  preferredRoles: { 'ui:colSpan': 2 },
  trainingPrograms: { 'ui:widget': 'textarea', 'ui:colSpan': 2 },
  address: { 'ui:colSpan': 2 },
  consentProfile: { 'ui:colSpan': 2 },
  consentSharing: { 'ui:colSpan': 2 },
  consentNotifications: { 'ui:colSpan': 2 },
  consentAnalytics: { 'ui:colSpan': 2 },
  consentMarketing: { 'ui:colSpan': 2 },
  consentRetention: { 'ui:colSpan': 2 },
};

export const aggregatorProfileDefaults: AggregatorProfileFormData = {
  org: 'TRRAIN',
  type: 'Seeker',
  registration: 'AGG-IND-0142',
  established: '2011-04-08',
  coordinator: 'R. Krishnan',
  coordinatorMobile: '+91 98450 22119',
  about:
    'TRRAIN works to elevate retail careers in India by training first-time job seekers and connecting them with verified retail employers across South India.',
  beneficiaries: 'Women in retail, First-time job seekers, Persons with disabilities',
  sectors: 'Retail',
  targetHires: '120',
  preferredRoles: 'Sales Associate, Cashier, Customer Care Exec, Delivery Partner, Stockroom Asst.',
  geographies: 'Karnataka, Maharashtra, Tamil Nadu, Telangana',
  networkSize: '2,400 seekers · 86 partner orgs',
  trainingPrograms:
    'Pankh (60-hr foundation) · Stride (advanced sales) · Saksham (workplace soft-skills)',
  address: '2nd Floor, Trade Centre, Bandra-Kurla Complex, Mumbai 400051',
  consentProfile: true,
  consentSharing: true,
  consentNotifications: true,
  consentAnalytics: true,
  consentMarketing: false,
  consentRetention: true,
};
