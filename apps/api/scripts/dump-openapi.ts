/**
 * Dumps the code-generated OpenAPI spec to the repo root ./openapi.json
 * (committed; CI drift-checks it). Sets the docs-enabling env BEFORE the
 * config module loads — swagger only registers when apiReferenceEnabled.
 */
import { writeFile } from 'node:fs/promises';

process.env.API_REFERENCE_ENABLED = 'true';
process.env.API_REFERENCE_FORCE = 'true';
// `DATABASE_URL` has no source default — it carries credentials, so the config
// schema requires it rather than falling back to a literal (secrets:S6698).
// This script only builds the Fastify app to serialise its route metadata and
// never opens a connection (`pg.Pool` is lazy), so a credential-free
// placeholder satisfies startup validation. `??=` so an already-exported value
// wins: the spec output does not depend on this URL either way.
process.env.DATABASE_URL ??= 'postgres://localhost:5432/aggregator_spec_dump';
// Reuses the repo's existing public-origin env (decision during Task 4 review:
// no separate PUBLIC_API_BASE_URL — one source of truth).
// Generic host by design: deployments are per instance, so the published
// spec advertises a substitute-your-host URL, not one pilot's domain.
// Hard-set (not `??=`): the committed spec must be deterministic regardless
// of whatever PUBLIC_API_URL happens to be exported in the invoking shell/CI
// environment. To change the published URL, edit this line and regenerate
// (`pnpm --filter @aggregator-dpg/api spec:dump`), then commit openapi.json.
process.env.PUBLIC_API_URL = 'https://aggregator.example.com';

const { buildApp } = await import('../src/app.js');
const app = await buildApp();
await app.ready();
const spec = app.swagger();
await writeFile(
  new URL('../../../openapi.json', import.meta.url),
  JSON.stringify(spec, null, 2) + '\n',
);
await app.close();
console.log(
  `openapi.json written (${Object.keys((spec as { paths: object }).paths).length} paths)`,
);
process.exit(0);
