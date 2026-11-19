'use client';
/**
 * Client side of `/accept-terms`: the consent gate in page layout, the
 * acceptance call, and a way out.
 *
 * @module apps/web/src/app/accept-terms/AcceptTermsView
 */
import { useRef, useState, type JSX } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ConsentGate } from '@/components/consent/ConsentGate';
import type { ConsentDoc } from '@/components/consent/consent-docs';

/** Props for {@link AcceptTermsView}. */
export interface AcceptTermsViewProps {
  /** Documents to accept, or `null` when they could not be loaded. */
  docs: ConsentDoc[] | null;
  /** Terms version the documents carry, sent back on accept. */
  termsVersion: number;
  /** Privacy version the documents carry, sent back on accept. */
  privacyVersion: number;
  /** Same-origin path to open once the terms are recorded. */
  returnTo: string;
}

/** `changed`: a newer version was published. `failed`: anything else went wrong. */
type Outcome = 'idle' | 'sending' | 'changed' | 'failed';

const LOGOUT_PATH = '/api/auth/logout';

/**
 * Renders the terms page body.
 *
 * On accept it posts the versions to `/api/consent`. 200 opens `returnTo`;
 * 409 says the terms changed and reloads the server page for the new text;
 * any other answer shows a failure with a reload button and the log-out link.
 *
 * @param props - Documents, their versions, and where to go next.
 * @returns The page body.
 */
export function AcceptTermsView({
  docs,
  termsVersion,
  privacyVersion,
  returnTo,
}: Readonly<AcceptTermsViewProps>): JSX.Element {
  const t = useTranslations('accept_terms');
  const tRegister = useTranslations('register');
  const router = useRouter();
  const [outcome, setOutcome] = useState<Outcome>('idle');
  const sending = useRef(false);

  const accept = async (): Promise<void> => {
    if (sending.current) return;
    sending.current = true;
    setOutcome('sending');
    try {
      const res = await fetch('/api/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ terms_version: termsVersion, privacy_version: privacyVersion }),
      });
      if (res.status === 200) {
        window.location.assign(returnTo);
        return;
      }
      if (res.status === 409) {
        setOutcome('changed');
        router.refresh();
      } else {
        setOutcome('failed');
      }
    } catch {
      setOutcome('failed');
    }
    sending.current = false;
  };

  const logOut = (
    <a
      href={LOGOUT_PATH}
      className="text-sm font-semibold text-(--bd-primary-600) underline-offset-2 hover:underline"
    >
      {t('log_out')}
    </a>
  );

  let body: JSX.Element;
  if (!docs || docs.length === 0) {
    body = (
      <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4">
        <p className="font-semibold text-red-800">{tRegister('consent.load_failed_title')}</p>
        <p className="mt-1 text-sm text-red-700">{tRegister('consent.load_failed_detail')}</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-3 rounded-lg bg-(--bd-primary-600) px-4 py-2 text-sm font-semibold text-white"
        >
          {t('reload')}
        </button>
      </div>
    );
  } else if (outcome === 'failed') {
    body = (
      <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4">
        <p className="text-sm text-red-700">{t('failed')}</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-3 rounded-lg bg-(--bd-primary-600) px-4 py-2 text-sm font-semibold text-white"
        >
          {t('reload')}
        </button>
      </div>
    );
  } else {
    body = (
      <>
        {outcome === 'changed' && (
          <p
            role="status"
            className="mb-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"
          >
            {t('changed')}
          </p>
        )}
        {/* A new version remounts the gate, so reading starts again. */}
        <ConsentGate
          key={`${termsVersion}:${privacyVersion}`}
          open
          layout="page"
          docs={docs}
          agreeLabel={t('agree_label')}
          onAccept={() => void accept()}
        />
      </>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col px-4 pb-10 pt-16 sm:px-6">
      <h1 className="font-display text-2xl font-bold text-ink-900">{t('title')}</h1>
      <p className="mt-1 mb-5 text-sm text-ink-500">{t('intro')}</p>
      {body}
      <div className="mt-5 text-center">{logOut}</div>
    </main>
  );
}
