/**
 * OTel preload — installs the import-in-the-middle ESM hook and boots
 * the SDK BEFORE Node loads the api server. Wired into the Dockerfile
 * CMD via `node --import ./otel-register.mjs ./server.js`.
 *
 * Without this preload, ESM static `import { default as fastify } from
 * 'fastify'` enters the module cache before bootApiTelemetry() runs, and
 * the OTel Fastify auto-instrumentation can't patch the loaded module —
 * inbound HTTP server spans never get produced.
 *
 * Using `node --import` ensures this module executes before the entry
 * script's import graph is resolved, so the hook is in place when every
 * subsequent module imports its dependencies.
 */

import { register } from 'node:module';

// Install the ESM hook that lets OTel's `instrumentation` package patch
// imported modules. `@opentelemetry/instrumentation` ships `hook.mjs` for
// exactly this purpose.
register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

// Now boot the SDK. The dist/telemetry.js calls `bootTelemetry()` which
// installs the global TracerProvider/MeterProvider and registers the
// FastifyInstrumentation. Because the IITM hook is already in place,
// every Fastify/Undici/etc. import that happens AFTER this point is
// patched.
const { bootApiTelemetry } = await import('./telemetry.js');
await bootApiTelemetry();
