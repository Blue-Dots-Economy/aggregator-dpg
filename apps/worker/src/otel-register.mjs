/**
 * OTel preload — same purpose as apps/api/src/otel-register.mjs. Installs
 * the import-in-the-middle ESM hook and boots the SDK before Node loads
 * the worker entrypoint. Wired into the worker Dockerfile CMD via
 * `node --import ./otel-register.mjs ./main.js`.
 */

import { register } from 'node:module';

register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

const { bootWorkerTelemetry } = await import('./telemetry.js');
await bootWorkerTelemetry();
