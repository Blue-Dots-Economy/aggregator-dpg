# Parked code review — feat/api-docs-scalar (vs develop)

Status: 4/7 angles done (reuse, simplification, efficiency, altitude). Correctness angles (line-by-line, removed-behavior, cross-file) NOT run. No correctness bugs found so far; merge-safe. Date: 2026-06-12.

## High

1. Dead double-validation (~12 handlers, e.g. dashboard.ts:137) — fastify validates via schema AND handler re-runs safeParse; handler 400 branch unreachable; 2x parse per request. Fix: delete handler safeParse blocks.
2. registration-links.ts:145-158 — forked CreateLinkOpenApiBodySchema kept in sync by comment only. Fix: declare real schema as body:, delete fork.
3. app.ts — no securitySchemes; Scalar "Try it" has no auth field. Add bearerAuth + per-route security.
4. dashboard.ts:114 — response 200 passthrough schema forces zod deep-clone of largest payloads. Omit response key.

## Medium

5. app.ts:143 — Scalar 3.5MB bundle in heap, uncompressed, no cache headers; registered unconditionally (prod+tests). Use cdn option or ENABLE_API_DOCS gate.
6. app.ts:100 — withTypeProvider return discarded; no inferred handler types; hand generics can drift.
7. errorResponses() inconsistent — dashboard + aggregator-config document only 200.
8. aggregator-approvals.ts:166 — body schema makes malformed admin form return JSON instead of HTML error page.

## Low

- Schema mirrors lack type anchors (ErrorEnvelopeSchema, BulkUploadResponseSchema, AggregatorConfigResponseSchema) — use z.ZodType<T>/z.infer
- Lifecycle enum re-declared in 3 route files — export from lifecycle.ts
- PassthroughResponse copy-pasted 8+ times — move to errors/openapi.ts
- version '1.0.0' hardcoded (package.json = 0.0.0)
- Tags = free strings x28 + central array, no mapping mechanism
- bulk-uploads.ts:440 — limit bounds in handler not schema; docs claim 1-100 unenforced
