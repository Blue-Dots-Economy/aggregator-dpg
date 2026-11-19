/**
 * `/accept-terms`: where a coordinator or org owner with outstanding terms
 * reads and accepts the current Terms of Service and Privacy Policy.
 *
 * Lives outside the `(protected)` and `(console)` groups so their terms guard
 * cannot send it back to itself.
 *
 * @module apps/web/src/app/accept-terms/page
 */

import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import type { JSX } from 'react';
import { loadConsentContent } from '@/app/(public)/register/register-server';
import { toConsentDocs, type ConsentDoc } from '@/components/consent/consent-docs';
import type { ConsentDocContent } from '@/components/consent/consent-types';
import { LanguageSwitcher } from '@/components/shell/LanguageSwitcher';
import { ThemeToggle } from '@/components/shell/ThemeToggle';
import { tokenAggregatorId } from '@/lib/jwt';
import { logger } from '@/lib/logger';
import { safeReturnPath } from '@/lib/return-to';
import { getSession } from '@/lib/server-session';
import { storeTermsStatus } from '@/lib/terms-guard.server';
import { ACCEPT_TERMS_PATH, fetchTermsStatus, type TermsCheck } from '@/lib/terms-status.server';
import { getFreshAccessToken } from '@/lib/upstream-client';
import { AcceptTermsView } from './AcceptTermsView';

export const metadata: Metadata = { title: 'Accept terms' };

export const dynamic = 'force-dynamic';

const LOGIN_PATH = `/api/auth/login?returnTo=${ACCEPT_TERMS_PATH}`;

interface AcceptTermsPageProps {
  searchParams: Promise<{ returnTo?: string | string[] }>;
}

/**
 * Checks the terms status afresh and shows the gate only while it is outstanding.
 *
 * - No session, or a token that cannot be refreshed: log in.
 * - `ok` or `unknown`: store the status and go to `returnTo`. Storing
 *   `unknown` lets the layout guard check again and fail open, so a failed
 *   check cannot bounce between this page and the portal.
 * - `outstanding`: the audience's documents in a gate that cannot be closed.
 *
 * `returnTo` must be a same-origin path other than this page; otherwise
 * coordinators go to `/dashboard` and org owners to `/console`.
 */
export default async function AcceptTermsPage({
  searchParams,
}: Readonly<AcceptTermsPageProps>): Promise<JSX.Element> {
  const session = await getSession();
  if (!session) redirect(LOGIN_PATH);

  const { returnTo: requested } = await searchParams;
  const fallback = tokenAggregatorId(session.accessToken) ? '/dashboard' : '/console';
  const returnTo = safeReturnPath(typeof requested === 'string' ? requested : null, fallback, [
    ACCEPT_TERMS_PATH,
  ]);

  const accessToken = await getFreshAccessToken();
  if (!accessToken) redirect(LOGIN_PATH);

  const check = await fetchTermsStatus(accessToken);
  await storeTermsStatus(check.status);
  if (check.status !== 'outstanding') redirect(returnTo);

  return (
    <div className="relative min-h-dvh bg-(--bd-bg)">
      <div className="absolute right-4 top-4 z-10 flex items-center gap-2">
        <LanguageSwitcher />
        <ThemeToggle />
      </div>
      <AcceptTermsView
        docs={await docsToAccept(check)}
        termsVersion={check.termsVersion ?? 0}
        privacyVersion={check.privacyVersion ?? 0}
        returnTo={returnTo}
      />
    </div>
  );
}

/**
 * The documents for the caller's audience, when they are the versions the API
 * expects. Anything else returns `null` and the page shows the load error, so
 * the user never accepts text other than the one recorded.
 *
 * @param check - The outstanding status, with audience and versions.
 * @returns The documents in reading order, or `null`.
 */
async function docsToAccept(check: TermsCheck): Promise<ConsentDoc[] | null> {
  const content = await loadConsentContent();
  if (!content || !check.audience) return null;
  const docs: ConsentDocContent = content[check.audience];
  if (docs.terms.version !== check.termsVersion || docs.privacy.version !== check.privacyVersion) {
    logger.warn({
      operation: 'terms.page.docs',
      status: 'failure',
      code: 'CONSENT_VERSION_MISMATCH',
      audience: check.audience,
    });
    return null;
  }
  return toConsentDocs(docs);
}
