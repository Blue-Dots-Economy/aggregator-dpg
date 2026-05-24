import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { RJSFSchema } from '@rjsf/utils';
import { PublicRegistrationView } from './PublicRegistrationView';

export const metadata: Metadata = {
  title: 'Register',
};

export const dynamic = 'force-dynamic';

interface ResolveResponse {
  slug: string;
  domain: 'seeker' | 'provider';
  context: Record<string, unknown>;
  schema_id: string;
  schema_version: string;
  expires_at: string | null;
}

interface PageProps {
  params: Promise<{ org: string; slug: string }>;
}

/**
 * Public anonymous registration page. The `(org, slug)` pair is the access
 * token — `org` is the aggregator's `org_slug`, `slug` is the per-link slug.
 * Resolves the link metadata against the public API, loads the matching
 * participant JSON Schema from disk, and hands both to the client renderer.
 */
export default async function PublicRegistrationPage({ params }: PageProps) {
  const { org, slug } = await params;

  // 1. Resolve link metadata via the public API.
  const apiBase = process.env.API_BASE_URL ?? 'http://localhost:4000';
  let resolved: ResolveResponse;
  try {
    const res = await fetch(
      `${apiBase}/public/v1/aggregators/${encodeURIComponent(org)}/links/${encodeURIComponent(slug)}`,
      { cache: 'no-store' },
    );
    if (res.status === 404) notFound();
    if (!res.ok) {
      return (
        <ErrorShell
          title="Link unavailable"
          message={`The registration link is not currently active (HTTP ${res.status}).`}
        />
      );
    }
    resolved = (await res.json()) as ResolveResponse;
  } catch (err) {
    return (
      <ErrorShell
        title="Cannot reach registration service"
        message={err instanceof Error ? err.message : 'Network error.'}
      />
    );
  }

  // 2. Load participant schema + ui schema from disk (config-driven).
  // Defence in depth: validate the `domain` value before composing the
  // file path. The API is trusted but typing alone does not enforce a
  // runtime allowlist, and any future API contract drift could otherwise
  // turn this into a path-traversal vector.
  if (resolved.domain !== 'seeker' && resolved.domain !== 'provider') {
    notFound();
  }
  const schemaFile = `${resolved.domain}.v1.json`;
  const uiFile = `${resolved.domain}.v1.ui.json`;
  let schema: RJSFSchema;
  let uiSchema: Record<string, unknown> = {};
  try {
    schema = JSON.parse(
      await readFile(resolveParticipantSchemaPath(schemaFile), 'utf8'),
    ) as RJSFSchema;
  } catch (err) {
    return (
      <ErrorShell
        title="Form unavailable"
        message={`Participant schema for "${resolved.domain}" is missing. ${
          err instanceof Error ? err.message : ''
        }`}
      />
    );
  }
  try {
    uiSchema = JSON.parse(await readFile(resolveParticipantSchemaPath(uiFile), 'utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    // UI schema is optional — RJSF renders defaults without it.
  }

  return (
    <PublicRegistrationView
      org={org}
      slug={slug}
      domain={resolved.domain}
      context={resolved.context}
      schema={schema}
      uiSchema={uiSchema}
    />
  );
}

function resolveParticipantSchemaPath(file: string): string {
  // Walk a small set of plausible roots so the same code works in dev
  // (`pnpm --filter web dev`, cwd = apps/web) and in the docker standalone
  // build (cwd = /app, config copied via Dockerfile). Honour
  // `SCHEMA_ROOT_DIR` first so a per-network deployment (e.g.
  // `/app/config/blue_dot/schemas`) drives the path without web rebuilds.
  const root = process.env.SCHEMA_ROOT_DIR;
  const candidates = [
    ...(root ? [path.resolve(root, 'participant', file)] : []),
    path.resolve(process.cwd(), 'config/schemas/participant', file),
    path.resolve(process.cwd(), '../../config/schemas/participant', file),
    path.resolve(process.cwd(), '../config/schemas/participant', file),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0]!;
}

function ErrorShell({ title, message }: { title: string; message: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-6 bg-[#FBFCFE]">
      <div className="max-w-md text-center">
        <h1 className="font-display font-bold text-[22px] text-ink-900">{title}</h1>
        <p className="mt-3 text-[14px] text-ink-500 leading-relaxed">{message}</p>
      </div>
    </div>
  );
}
