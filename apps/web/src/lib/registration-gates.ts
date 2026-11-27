/**
 * Registration-form gate predicates.
 *
 * Decides from the per-domain config (`GET /v1/aggregator-config`) whether the
 * registration form shows the consent step and the birth-year field.
 * Mirrors the predicates in `@aggregator-dpg/network-config/interface`, which
 * the web app cannot bundle. Keep the two in sync.
 *
 * @module @aggregator-dpg/web/lib/registration-gates
 */

import type { AggregatorConfigDomain } from '../hooks/useAggregatorConfig';

/**
 * Go-live gate token meaning consent must be accepted before the profile can
 * go live.
 */
export const CONSENT_REQUIRED_GATE = 'consent_required';

/**
 * Whether the domain's `go_live_required` includes {@link CONSENT_REQUIRED_GATE}.
 *
 * @param domain - The resolved domain config, or undefined when not yet loaded.
 * @returns True when the consent step must be shown.
 */
export function domainRequiresConsent(domain: AggregatorConfigDomain | undefined): boolean {
  return (domain?.go_live_required ?? []).includes(CONSENT_REQUIRED_GATE);
}

/**
 * Whether the registration form collects a birth year for a domain.
 *
 * True when the domain requires guardian consent (under-18 gating).
 *
 * @param domain - The resolved domain config, or undefined when not yet loaded.
 * @returns True when a birth year must be collected.
 */
export function domainRequiresBirthYear(domain: AggregatorConfigDomain | undefined): boolean {
  return domain?.guardian_consent_required === true;
}

/**
 * Whether the registration form should show the consent step for a domain.
 *
 * True when the domain gates go-live on consent or collects a birth year.
 * Signalstack always requires consent for guardian-gated domains, so a
 * birth-year domain shows the consent step even if `go_live_required` omits it.
 *
 * @param domain - The resolved domain config, or undefined when not yet loaded.
 * @returns True when the consent step must be shown.
 */
export function registrationShowsConsent(domain: AggregatorConfigDomain | undefined): boolean {
  return domainRequiresConsent(domain) || domainRequiresBirthYear(domain);
}

/** Oldest age, in years, treated as a minor; a minor submits without consent and accepts terms later in the Signalstack app. */
export const MINOR_MAX_AGE = 18;

/** Oldest age, in years, a birth year may give; the forms offer no earlier year. */
export const MAX_AGE_YEARS = 120;

/**
 * Whether a year of birth is a four-digit year between {@link MAX_AGE_YEARS} ago and now.
 *
 * @param yearOfBirth - The value from the form; any non-string is invalid.
 * @param currentYear - The year to measure from; defaults to this year.
 * @returns True for a usable birth year.
 */
export function isValidBirthYear(
  yearOfBirth: unknown,
  currentYear: number = new Date().getFullYear(),
): boolean {
  if (typeof yearOfBirth !== 'string' || !/^\d{4}$/.test(yearOfBirth.trim())) return false;
  const year = Number(yearOfBirth.trim());
  return year >= currentYear - MAX_AGE_YEARS && year <= currentYear;
}

/**
 * Whether a year of birth makes the registrant a minor (age at most {@link MINOR_MAX_AGE}).
 *
 * Age is derived from the birth year alone; no birthdate is stored.
 *
 * @param yearOfBirth - The value from the form; an invalid year is not a minor.
 * @param currentYear - The year to measure from; defaults to this year.
 * @returns True when the registrant is a minor.
 */
export function isMinorBirthYear(
  yearOfBirth: unknown,
  currentYear: number = new Date().getFullYear(),
): boolean {
  if (!isValidBirthYear(yearOfBirth, currentYear)) return false;
  return currentYear - Number(String(yearOfBirth).trim()) <= MINOR_MAX_AGE;
}
