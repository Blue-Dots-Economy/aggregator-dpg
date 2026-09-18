/**
 * Filesystem entry point for the config-loader package.
 *
 * The `./fs` subpath: exposes the loaders that read configuration off disk
 * (environment resolution, consent config, Signals realm roles).
 *
 * Import via the ./fs subpath — never import from src/fs directly.
 *
 * @module @aggregator-dpg/config-loader/fs
 */

export { resolveEnv } from '../env.js';
export { loadConsentConfig } from './consent-loader.js';
export { loadSignalsRealmRoles } from './signals-roles-loader.js';
