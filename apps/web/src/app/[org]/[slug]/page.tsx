import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { RJSFSchema } from '@rjsf/utils';
import type { JSX } from 'react';
import type { z } from 'zod';
import { resolveSchemaRoot } from '@/lib/config-paths';
import { parseJsonObject, readJsonSchema } from '@/lib/json-object';
import { logger } from '@/lib/logger';
import { loadParticipantConsent } from '@/lib/participant-consent.server';
import { summariseIssues } from '@/lib/response-shape-error';
import { ResolveResponseSchema } from '@/lib/registration-link';
import { PublicRegistrationView, type PublicRegistrationViewProps } from './PublicRegistrationView';
import { VoiceOrFormView } from './VoiceOrFormView';

export const metadata: Metadata = {
  title: 'Register',
};

export const dynamic = 'force-dynamic';

/** The schema an `account_only` link passes to the view, which does not read it. */
const EMPTY_SCHEMA: RJSFSchema = {};

interface PageProps {
  params: Promise<{ org: string; slug: string }>;
}

/** The resolved link, or the error page to render instead. */
type ResolveOutcome = { ok: true; link: ResolvedLink } | { ok: false; page: JSX.Element };

/** A registration link as the public API resolves it. */
type ResolvedLink = z.infer<typeof ResolveResponseSchema>;

/**
 * Resolves a registration link through the public API.
 *
 * Calls `notFound()` when the API answers 404.
 *
 * @param org - The aggregator's `org_slug`.
 * @param slug - The link slug.
 * @returns The checked link, or an error page for an unreachable API or a bad response.
 */
async function resolveLink(org: string, slug: string): Promise<ResolveOutcome> {
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
    return {
      ok: false,
      page: (
        <ErrorShell
          title="Cannot reach registration service"
          message={err instanceof Error ? err.message : 'Network error.'}
        />
      ),
    };
  }
  if (res.status === 404) notFound();
  if (!res.ok) {
    return {
      ok: false,
      page: (
        <ErrorShell
          title="Link unavailable"
          message={`The registration link is not currently active (HTTP ${res.status}).`}
        />
      ),
    };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    return {
      ok: false,
      page: (
        <ErrorShell
          title="Cannot reach registration service"
          message={err instanceof Error ? err.message : 'Malformed response.'}
        />
      ),
    };
  }
  const parsedLink = ResolveResponseSchema.safeParse(body);
  if (!parsedLink.success) {
    logger.error({
      operation: 'publicRegistrationPage.resolve',
      status: 'failure',
      error: 'unexpected response shape',
      issues: summariseIssues(parsedLink.error.issues),
    });
    return {
      ok: false,
      page: <ErrorShell title="Link unavailable" message="Malformed response." />,
    };
  }
  return { ok: true, link: parsedLink.data };
}

/**
 * Reads the optional UI schema for a domain from config/<network>/schemas/participant/.
 *
 * @param domain - The link's domain, already checked against the safe-name pattern.
 * @returns The UI schema, or `{}` when the file is missing or not a JSON object.
 */
async function loadUiSchema(domain: string): Promise<Record<string, unknown>> {
  try {
    return parseJsonObject(
      await readFile(resolveParticipantSchemaPath(`${domain}.v1.ui.json`), 'utf8'),
    );
  } catch {
    // UI schema is optional.
    return {};
  }
}

/**
 * Public anonymous registration page for a registration link.
 *
 * `org` is the aggregator's `org_slug` and `slug` is the link slug. Resolves the
 * link through the public API, loads the optional UI schema, and renders the
 * client view: the two-option view when the link offers voice and has a bot,
 * else the registration form view.
 */
export default async function PublicRegistrationPage({ params }: Readonly<PageProps>) {
  const { org, slug } = await params;

  // 1. Resolve link metadata via the public API.
  const outcome = await resolveLink(org, slug);
  if (!outcome.ok) return outcome.page;
  const resolved = outcome.link;

  // 2. The schema comes in the resolve response. It must be an object unless
  // the link is `account_only`, where `null` is valid.
  const submissionShape = resolved.submission_shape ?? 'account_and_profile';
  const accountOnly = submissionShape === 'account_only';
  const linkSchema = readJsonSchema(resolved.schema);
  if (!accountOnly && !linkSchema) {
    return (
      <ErrorShell
        title="Form unavailable"
        message={`Registration schema for "${resolved.domain}" is missing.`}
      />
    );
  }
  if (!/^[a-z0-9_-]+$/i.test(resolved.domain)) {
    notFound();
  }
  // The view ignores `schema` and the UI schema for account_only links.
  const schema = linkSchema ?? EMPTY_SCHEMA;
  const uiSchema = accountOnly ? {} : await loadUiSchema(resolved.domain);

  // Participant Terms/Privacy content for the consent modal, read from config.
  const participantConsent = await loadParticipantConsent();

  const viewProps: PublicRegistrationViewProps = {
    org,
    slug,
    network: resolved.network ?? '',
    domain: resolved.domain,
    context: resolved.context,
    schema,
    uiSchema,
    identity: resolved.identity,
    submissionShape,
    publicHintI18nKey: resolved.public_hint_i18n_key ?? null,
    registrationMode: resolved.registration_mode ?? null,
    consentContent: participantConsent,
  };
  if (resolved.offers.includes('voice') && resolved.voice_bot) {
    return <VoiceOrFormView {...viewProps} voiceBot={resolved.voice_bot} />;
  }
  return <PublicRegistrationView {...viewProps} />;
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

function ErrorShell({ title, message }: Readonly<{ title: string; message: string }>) {
  return (
    <div className="min-h-screen flex items-center justify-center px-6 bg-[#FBFCFE]">
      <div className="max-w-md text-center">
        <h1 className="font-display font-bold text-[22px] text-ink-900">{title}</h1>
        <p className="mt-3 text-[14px] text-ink-500 leading-relaxed">{message}</p>
      </div>
    </div>
  );
}
