/**
 * Runtime configuration schema for the schema-service package.
 *
 * Defines and validates the structure of config/profiles.yaml — the
 * single source of truth for aggregator profile fields shown during onboarding.
 *
 * Discovered and validated by @aggregator-dpg/config-loader at boot via the
 * ./config subpath export convention.
 *
 * @module @aggregator-dpg/schema-service/config
 */

import { z } from 'zod';

/**
 * Allowed input types for a profile field.
 * Drives frontend rendering and API coercion.
 */
export const ProfileFieldTypeSchema = z.enum([
  'text',
  'email',
  'phone',
  'select',
  'multiselect',
  'textarea',
  'number',
  'boolean',
]);

/**
 * Profile sections — each field belongs to exactly one.
 */
export const ProfileGroupSchema = z.enum(['whoIAm', 'whatIWant', 'whatIHave']);

/**
 * A single field definition in the aggregator profile schema.
 */
export const ProfileFieldSchema = z.object({
  /** camelCase identifier used in API payloads. */
  name: z.string().min(1),
  /** Human-readable display label. */
  label: z.string().min(1),
  /** Input type for rendering and validation. */
  type: ProfileFieldTypeSchema,
  /** Whether filling this field contributes to the completeness percentage. */
  required: z.boolean(),
  /** Section this field belongs to. */
  group: ProfileGroupSchema,
  /** Allowed values for select / multiselect fields. */
  options: z.array(z.string().min(1)).optional(),
});

export type ProfileField = z.infer<typeof ProfileFieldSchema>;

/**
 * Top-level shape of config/profiles.yaml.
 */
export const ProfilesConfigSchema = z.object({
  completeness: z.object({
    /** Fraction (0–1) of required fields that must be filled for a profile to be complete. */
    threshold: z.number().min(0).max(1),
  }),
  fields: z.array(ProfileFieldSchema).min(1),
});

export type ProfilesConfig = z.infer<typeof ProfilesConfigSchema>;

/**
 * Top-level key under which this package's config lives in the merged config tree.
 */
export const configKey = 'profiles';

/**
 * Zod schema that validates config/profiles.yaml.
 * Discovered and applied by config-loader at boot.
 */
export const configSchema = ProfilesConfigSchema;

/**
 * Baseline profile config — reflects the content of config/profiles.yaml.
 * Merged into the config tree before env overrides.
 */
export const configDefaults: ProfilesConfig = {
  completeness: {
    threshold: 0.75,
  },
  fields: [
    // WHO I AM
    {
      name: 'representativeName',
      label: 'Name of accountable representative',
      type: 'text',
      required: true,
      group: 'whoIAm',
    },
    {
      name: 'mobileNumber',
      label: 'Mobile number for follow-up',
      type: 'phone',
      required: true,
      group: 'whoIAm',
    },
    {
      name: 'email',
      label: 'Email for follow-up',
      type: 'email',
      required: true,
      group: 'whoIAm',
    },
    {
      name: 'trustAnchorType',
      label: 'Trust anchor / identity of the aggregator',
      type: 'select',
      required: true,
      group: 'whoIAm',
      options: ['ngo', 'government', 'private', 'individual'],
    },
    {
      name: 'organisationName',
      label: 'Organisation name (for institutional aggregators)',
      type: 'text',
      required: false,
      group: 'whoIAm',
    },
    // WHAT I WANT
    {
      name: 'contactPreference',
      label: 'How should the ecosystem contact your participants?',
      type: 'select',
      required: true,
      group: 'whatIWant',
      options: ['direct', 'viaAggregator', 'either'],
    },
    // WHAT I HAVE
    {
      name: 'beneficiaryGroups',
      label: 'Beneficiary groups this aggregator currently serves',
      type: 'multiselect',
      required: true,
      group: 'whatIHave',
      options: [
        'students',
        'personsWithDisabilities',
        'women',
        'workers',
        'seniorCitizens',
        'jobProviders',
        'serviceProviders',
        'other',
      ],
    },
  ],
};

export type Config = ProfilesConfig;
