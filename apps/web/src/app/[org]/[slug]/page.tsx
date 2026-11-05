import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { RJSFSchema } from '@rjsf/utils';
import { resolveSchemaRoot } from '@/lib/config-paths';
import { parseJsonObject, readJsonSchema } from '@/lib/json-object';
import { logger } from '@/lib/logger';
import { loadParticipantConsent } from '@/lib/participant-consent.server';
import { ResponseShapeError } from '@/lib/response-shape-error';
import { ResolveResponseSchema } from '@/lib/registration-link';
import { PublicRegistrationView } from './PublicRegistrationView';

export const metadata: Metadata = {
  title: 'Register',
};

export const dynamic = 'force-dynamic';

/** The schema an `account_only` link passes to the view, which does not read it. */
const EMPTY_SCHEMA: RJSFSchema = {};

interface PageProps {
  params: Promise<{ org: string; slug: string }>;
}

/**
 * Public anonymous registration page for a registration link.
 *
 * `org` is the aggregator's `org_slug` and `slug` is the link slug. Resolves the
 * link through the public API, loads the optional UI schema, and renders the
 * client view.
 */
export default async function PublicRegistrationPage({ params }: PageProps) {
  const { org, slug } = await params;

  // 1. Resolve link metadata via the public API.
  const apiBase = process.env.API_BASE_URL ?? 'http://localhost:4000';
  // Only the fetch is inside the try. `notFound()` throws, so it must be
  // called outside the try or the catch would swallow it.
  let res: Response;
  try {
    res = await fetch(
      `${apiBase}/public/v1/aggregators/${encodeURIComponent(org)}/links/${encodeURIComponent(slug)}`,
      { cache: 'no-store' },
    );
  } catch (err) {
    return (
      <ErrorShell
        title="Cannot reach registration service"
        message={err instanceof Error ? err.message : 'Network error.'}
      />
    );
  }
  if (res.status === 404) notFound();
  if (!res.ok) {
    return (
      <ErrorShell
        title="Link unavailable"
        message={`The registration link is not currently active (HTTP ${res.status}).`}
      />
    );
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    return (
      <ErrorShell
        title="Cannot reach registration service"
        message={err instanceof Error ? err.message : 'Malformed response.'}
      />
    );
  }
  const parsedLink = ResolveResponseSchema.safeParse(body);
  if (!parsedLink.success) {
    logger.error({
      operation: 'publicRegistrationPage.resolve',
      status: 'failure',
      error: 'unexpected response shape',
      issues: new ResponseShapeError('link resolve', parsedLink.error.issues).issueSummary(),
    });
    return <ErrorShell title="Link unavailable" message="Malformed response." />;
  }
  const resolved = parsedLink.data;

  // 2. The schema comes in the resolve response. It must be an object unless
  // the link is `account_only`, where `null` is valid.
  const submissionShape = resolved.submission_shape ?? 'account_and_profile';
  const hintKey = resolved.public_hint_i18n_key ?? null;
  const linkSchema = readJsonSchema(resolved.schema);
  if (submissionShape !== 'account_only') {
    if (!linkSchema) {
      return (
        <ErrorShell
          title="Form unavailable"
          message={`Registration schema for "${resolved.domain}" is missing.`}
        />
      );
    }
  }
  if (!/^[a-z0-9_-]+$/i.test(resolved.domain)) {
    notFound();
  }
  // The view ignores `schema` for account_only links.
  const schema = linkSchema ?? EMPTY_SCHEMA;
  // Optional UI schema from config/<network>/schemas/participant/. Not read
  // for account_only links.
  let uiSchema: Record<string, unknown> = {};
  if (submissionShape !== 'account_only') {
    const uiFile = `${resolved.domain}.v1.ui.json`;
    try {
      uiSchema = parseJsonObject(await readFile(resolveParticipantSchemaPath(uiFile), 'utf8'));
    } catch {
      // UI schema is optional.
    }
  }

  // Participant Terms/Privacy content for the consent modal, read from config.
  const participantConsent = await loadParticipantConsent();

  return (
    <PublicRegistrationView
      org={org}
      slug={slug}
      network={resolved.network ?? ''}
      domain={resolved.domain}
      context={resolved.context}
      schema={schema}
      uiSchema={uiSchema}
      identity={resolved.identity}
      submissionShape={submissionShape}
      publicHintI18nKey={hintKey}
      registrationMode={resolved.registration_mode ?? null}
      consentContent={participantConsent}
    />
  );
}

function resolveParticipantSchemaPath(file: string): string {
  // Try several roots so this works in dev (cwd = apps/web) and in Docker
  // (cwd = /app). The first root comes from resolveSchemaRoot().
  const root = resolveSchemaRoot();
  const candidates = [
    path.resolve(root, 'participant', file),
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
