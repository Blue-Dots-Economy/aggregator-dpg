import type { Metadata } from 'next';
import Link from 'next/link';
import { BlueDotsLogo } from '../../../../components/ui/BlueDotsLogo';
import { BrandPanel } from '../../../../components/login/BrandPanel';

export const metadata: Metadata = {
  title: 'Verify your email',
};

export const dynamic = 'force-dynamic';

interface VerifyResult {
  status: 'success' | 'expired' | 'invalid' | 'not_found' | 'error';
  detail?: string;
}

async function callVerify(id: string, token: string): Promise<VerifyResult> {
  const base = process.env.API_BASE_URL ?? 'http://localhost:4000';
  let res: Response;
  try {
    res = await fetch(
      `${base}/v1/aggregator-registrations/${encodeURIComponent(id)}/verify?token=${encodeURIComponent(token)}`,
      { method: 'POST', cache: 'no-store' },
    );
  } catch {
    return { status: 'error', detail: 'Cannot reach registration service' };
  }

  if (res.ok) return { status: 'success' };

  let body: { error?: { code?: string; detail?: string } } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* ignore */
  }
  const code = body?.error?.code ?? '';
  const detail = body?.error?.detail;

  if (code === 'VERIFICATION_TOKEN_EXPIRED')
    return { status: 'expired', ...(detail !== undefined ? { detail } : {}) };
  if (code === 'VERIFICATION_TOKEN_INVALID')
    return { status: 'invalid', ...(detail !== undefined ? { detail } : {}) };
  if (code === 'NOT_FOUND') return { status: 'not_found' };
  return { status: 'error', detail: detail ?? `Unexpected response (HTTP ${res.status})` };
}

interface Props {
  searchParams: Promise<{ id?: string; token?: string }>;
}

export default async function VerifyPage({ searchParams }: Props) {
  const { id, token } = await searchParams;

  let result: VerifyResult;
  if (!id || !token) {
    result = {
      status: 'invalid' as const,
      detail: 'Verification link is missing required parameters.',
    };
  } else {
    result = await callVerify(id, token);
  }

  return (
    <div className="h-screen w-full flex overflow-hidden">
      <BrandPanel />

      <main className="flex-1 min-w-0 h-screen relative overflow-y-auto bg-white">
        <div className="relative z-10 w-full max-w-[540px] mx-auto px-6 lg:px-10 py-14 flex flex-col items-center justify-center min-h-full">
          <header className="flex items-center gap-3.5 mb-10 self-start">
            <BlueDotsLogo size={40} />
            <div>
              <div className="font-display font-bold text-[17px] text-ink-900 leading-none tracking-tight">
                Blue Dots
              </div>
              <div className="text-[12px] text-ink-400 leading-none mt-1.5">Aggregator Portal</div>
            </div>
          </header>

          {result.status === 'success' && <SuccessCard />}
          {result.status === 'expired' && <ExpiredCard />}
          {result.status === 'invalid' && (
            <InvalidCard {...(result.detail !== undefined ? { detail: result.detail } : {})} />
          )}
          {result.status === 'not_found' && <NotFoundCard />}
          {result.status === 'error' && (
            <ErrorCard {...(result.detail !== undefined ? { detail: result.detail } : {})} />
          )}
        </div>
      </main>
    </div>
  );
}

function SuccessCard() {
  return (
    <div className="w-full rounded-[16px] border border-emerald-200 bg-emerald-50 p-8">
      <div className="flex items-center gap-3 mb-4">
        <span className="text-3xl">✓</span>
        <h1 className="font-display font-bold text-[22px] text-emerald-900 tracking-tight">
          Email verified
        </h1>
      </div>
      <p className="text-[14px] text-emerald-800 leading-relaxed">
        Your email address has been confirmed. The Blue Dots team will review your application and
        you&apos;ll receive an email once it&apos;s approved.
      </p>
      <p className="text-[13px] text-emerald-700 mt-3">
        Once approved, sign in via Blue Dots SSO using the email or mobile you registered.
      </p>
      <Link
        href="/login"
        className="mt-6 inline-flex items-center gap-2 rounded-[10px] bg-emerald-700 px-5 py-2.5 text-[13.5px] font-semibold text-white hover:bg-emerald-800 transition-colors"
      >
        Go to sign in
      </Link>
    </div>
  );
}

function ExpiredCard() {
  return (
    <div className="w-full rounded-[16px] border border-amber-200 bg-amber-50 p-8">
      <h1 className="font-display font-bold text-[22px] text-amber-900 tracking-tight mb-3">
        Link expired
      </h1>
      <p className="text-[14px] text-amber-800 leading-relaxed">
        This verification link has expired (links are valid for 1 hour). Please re-submit your
        registration and a fresh verification email will be sent.
      </p>
      <Link
        href="/register"
        className="mt-6 inline-flex items-center gap-2 rounded-[10px] bg-amber-700 px-5 py-2.5 text-[13.5px] font-semibold text-white hover:bg-amber-800 transition-colors"
      >
        Register again
      </Link>
    </div>
  );
}

function InvalidCard({ detail }: { detail?: string }) {
  return (
    <div className="w-full rounded-[16px] border border-red-200 bg-red-50 p-8">
      <h1 className="font-display font-bold text-[22px] text-red-900 tracking-tight mb-3">
        Invalid link
      </h1>
      <p className="text-[14px] text-red-800 leading-relaxed">
        {detail ??
          'This verification link is not valid. It may have been used already or the URL may be incomplete.'}
      </p>
      <Link
        href="/register"
        className="mt-6 inline-flex items-center gap-2 rounded-[10px] bg-red-700 px-5 py-2.5 text-[13.5px] font-semibold text-white hover:bg-red-800 transition-colors"
      >
        Register again
      </Link>
    </div>
  );
}

function NotFoundCard() {
  return (
    <div className="w-full rounded-[16px] border border-red-200 bg-red-50 p-8">
      <h1 className="font-display font-bold text-[22px] text-red-900 tracking-tight mb-3">
        Registration not found
      </h1>
      <p className="text-[14px] text-red-800 leading-relaxed">
        We could not find a registration matching this link. It may have been withdrawn or the link
        may be incorrect.
      </p>
      <Link
        href="/register"
        className="mt-6 inline-flex items-center gap-2 rounded-[10px] bg-red-700 px-5 py-2.5 text-[13.5px] font-semibold text-white hover:bg-red-800 transition-colors"
      >
        Start a new registration
      </Link>
    </div>
  );
}

function ErrorCard({ detail }: { detail?: string }) {
  return (
    <div className="w-full rounded-[16px] border border-red-200 bg-red-50 p-8">
      <h1 className="font-display font-bold text-[22px] text-red-900 tracking-tight mb-3">
        Something went wrong
      </h1>
      <p className="text-[14px] text-red-800 leading-relaxed">
        {detail ??
          'The verification service is temporarily unavailable. Please try again in a few minutes.'}
      </p>
      <p className="text-[13px] text-red-600 mt-3">
        If this keeps happening, contact{' '}
        <a href="mailto:support@bluedots.in" className="underline hover:no-underline">
          support@bluedots.in
        </a>
        .
      </p>
    </div>
  );
}
