/**
 * Points the API logger at stderr for an operator command, so stdout carries
 * only the command's own output. Must be imported before `config.ts`.
 * Belongs to `@aggregator-dpg/api`.
 */

process.env['LOG_DESTINATION'] = 'stderr';

export {};
