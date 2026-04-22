/**
 * Zod schema and TypeScript types for config/entities.yaml.
 *
 * Defines which entity types exist in the system and which profile sections
 * each type uses during onboarding. Adding a new entity type requires only
 * a YAML edit — no code change needed.
 *
 * @module @aggregator-dpg/schema-service/entities
 */

import { z } from 'zod';
import { ProfileGroupSchema } from './config.schema.js';

/**
 * A single entity type definition.
 *
 * `type` is a plain string (not an enum) so new entity types can be introduced
 * via entities.yaml without touching source code.
 */
export const EntityConfigSchema = z.object({
  /** Identifier used in API payloads, e.g. "seeker" or "provider". */
  type: z.string().min(1),
  /** Human-readable display name shown in the UI. */
  label: z.string().min(1),
  /**
   * Profile sections (from profiles.yaml) that apply to this entity type.
   * At least one section is required.
   */
  sections: z.array(ProfileGroupSchema).min(1),
});

export type EntityConfig = z.infer<typeof EntityConfigSchema>;

/**
 * Top-level shape of config/entities.yaml.
 */
export const EntitiesConfigSchema = z.object({
  entities: z.array(EntityConfigSchema).min(1),
});

export type EntitiesConfig = z.infer<typeof EntitiesConfigSchema>;
