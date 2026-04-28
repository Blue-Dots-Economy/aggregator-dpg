export type ParticipantStatus = 'active' | 'satisfied' | 'at-risk' | 'inactive';

export type ProfileStatus = 'complete' | 'incomplete';

export interface ParticipantStats {
  total: number;
  shortlisted?: number;
  accepted?: number;
  rejected: number;
  pending: number;
}

export interface ParticipantProfile {
  title: string;
  exp: string;
  verified: boolean;
  complete: number;
}

export interface ParticipantBase {
  id: string;
  name: string;
  city: string;
  joined: string;
  avatar: string;
  profile: ParticipantProfile;
  applied: ParticipantStats;
  pre: ParticipantStats;
  status: ParticipantStatus;
  last: string;
}

export type Seeker = ParticipantBase;

export interface Provider extends ParticipantBase {
  role: string;
}

export type OpportunityProvider = Provider;

export type ParticipantKind = 'seeker' | 'provider' | 'opp';

export interface ParticipantFilter {
  kind?: ParticipantKind;
  status?: ParticipantStatus;
  city?: string;
  search?: string;
}

export interface User {
  id: string;
  name: string;
  org: string;
}

export interface RegistrationLink {
  id: string;
  title: string;
  desc: string;
  slug: string;
  kind: 'Seeker' | 'Provider';
  regs: number;
  verified: number;
  last: string;
  active: boolean;
}

export interface RegistrationFormState {
  org: string;
  state: string;
  lever: string;
  date: string;
  location: string;
  district: string;
  domain: 'Seeker' | 'Provider' | 'Both';
  signal: 'Event' | 'Outreach' | 'Partner' | 'Walk-in';
  sub: 'On-ground' | 'Online' | 'Referral';
  full: string;
  type: 'Walk-in' | 'Campaign' | 'Referral' | 'Direct';
}

export interface AggregatorProfile {
  id: string;
  org: string;
  registered: string;
  coordinator: string;
  contact: {
    name: string;
    mobile: string;
    email: string;
  };
  beneficiaries: string;
  address: string;
  geographies: string;
  sectors: string;
  network: {
    activeSeekers: number;
    openRoles: number;
    hires3mo: number;
    matchRate: string;
  };
  consent: {
    profileCreation: boolean;
    sharing: boolean;
    notifications: boolean;
    analytics: boolean;
    marketing: boolean;
    retention: boolean;
    lastReviewed: string;
  };
}
