'use client';

import { useMemo, useState, type JSX, type ReactNode } from 'react';
import { RegisterPageShell } from '../RegisterPageShell';

export interface OwnerInviteViewProps {
  /** The owner grant token from the deep-link query string. */
  grant: string;
}

interface MintSummary {
  /** True when the grant was expired and a fresh link was re-mailed (nothing minted). */
  recovered: boolean;
  sent: number;
  resent: number;
  invalid: Array<{ email: string; reason: string }>;
}

type ViewState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'result'; summary: MintSummary }
  | { status: 'recovery_sent' } // grant was expired → fresh link re-mailed
  | { status: 'invalid_grant' }
  | { status: 'error'; message: string };

interface Recipient {
  email: string;
  name?: string;
}

/**
 * Parses the bulk textarea into recipients — one `email` or `email, name` per
 * line. Blank lines are skipped; the optional name (after the first comma) is
 * used only to greet the recipient in the invite email.
 *
 * @param raw - The textarea contents.
 * @returns The parsed recipient list.
 */
function parseRecipients(raw: string): Recipient[] {
  const out: Recipient[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const comma = trimmed.indexOf(',');
    if (comma === -1) {
      out.push({ email: trimmed });
    } else {
      const email = trimmed.slice(0, comma).trim();
      const name = trimmed.slice(comma + 1).trim();
      out.push(name ? { email, name } : { email });
    }
  }
  return out;
}

/**
 * Owner invite-management surface (#701). A bulk textarea mints N coordinator
 * invites in one submission and reports a per-recipient summary
 * (sent / already-invited / invalid). An expired grant lands on a recovery
 * action that re-mails a fresh link to the registered owner address.
 *
 * @param props - The grant token from the deep link.
 * @returns The invite-management page body.
 */
export function OwnerInviteView({ grant }: Readonly<OwnerInviteViewProps>): JSX.Element {
  const [raw, setRaw] = useState('');
  const [state, setState] = useState<ViewState>({ status: 'idle' });
  const recipients = useMemo(() => parseRecipients(raw), [raw]);
  const canSubmit = recipients.length > 0 && state.status !== 'submitting';
  // Precompute the button label so the JSX has no nested ternary (S3358).
  const plural = recipients.length === 1 ? '' : 's';
  const sendLabel =
    state.status === 'submitting'
      ? 'Sending…'
      : `Send ${recipients.length || ''} invite${plural}`.trim();

  async function submit(): Promise<void> {
    setState({ status: 'submitting' });
    let res: Response;
    try {
      res = await fetch('/api/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant, recipients }),
      });
    } catch {
      setState({ status: 'error', message: 'Network error. Please try again.' });
      return;
    }
    if (res.ok) {
      const summary = (await res.json()) as MintSummary;
      // An expired grant re-mails a fresh link and mints nothing (recovery is
      // folded into the mint endpoint — no separate call).
      setState(summary.recovered ? { status: 'recovery_sent' } : { status: 'result', summary });
      if (!summary.recovered) setRaw('');
      return;
    }
    const code = await readErrorCode(res);
    if (code === 'GRANT_INVALID') {
      setState({ status: 'invalid_grant' });
    } else if (res.status === 429) {
      setState({
        status: 'error',
        message: 'Too many invites just now. Please try again shortly.',
      });
    } else {
      setState({ status: 'error', message: 'Could not send invites. Please try again.' });
    }
  }

  return (
    <RegisterPageShell heading="Invite your coordinators">
      <div className="mt-6">
        {state.status === 'invalid_grant' ? (
          <Banner tone="error">
            This invite-management link is not valid. Please use the link from your approval email.
          </Banner>
        ) : null}

        {state.status === 'recovery_sent' ? (
          <Banner tone="warn">
            This invite-management link had expired, so we&apos;ve emailed a fresh one to your
            registered address. Open that link and try again.
          </Banner>
        ) : null}

        {state.status === 'result' ? (
          <ResultPanel summary={state.summary} onAgain={() => setState({ status: 'idle' })} />
        ) : null}

        {state.status === 'error' ? <Banner tone="error">{state.message}</Banner> : null}

        {state.status === 'idle' || state.status === 'submitting' ? (
          <>
            <p className="text-[14px] text-ink-500 mb-3">
              Enter one email address per line. Optionally add a name after a comma — for example
              &ldquo;asha@org.in, Asha&rdquo;. Each person gets their own one-time invite.
            </p>
            <textarea
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              rows={8}
              spellCheck={false}
              placeholder={'asha@org.in, Asha\nravi@org.in'}
              className="w-full rounded-[12px] border border-ink-200 bg-white px-3.5 py-3 text-[14px] font-mono focus:border-(--bd-primary) focus:outline-none"
            />
            <div className="mt-4 flex items-center gap-3">
              <button
                type="button"
                disabled={!canSubmit}
                onClick={submit}
                className="rounded-[10px] bg-(--bd-primary) px-5 py-2.5 text-[14px] font-semibold text-white disabled:opacity-50"
              >
                {sendLabel}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </RegisterPageShell>
  );
}

function ResultPanel({
  summary,
  onAgain,
}: Readonly<{ summary: MintSummary; onAgain: () => void }>): JSX.Element {
  return (
    <div className="space-y-3">
      <Banner tone="success">
        {summary.sent} sent · {summary.resent} already invited (re-sent) · {summary.invalid.length}{' '}
        invalid
      </Banner>
      {summary.invalid.length > 0 ? (
        <ul className="rounded-[10px] border border-ink-200 bg-white px-4 py-3 text-[13px] text-ink-600">
          {summary.invalid.map((i) => (
            <li key={`${i.email}:${i.reason}`}>
              {i.email} — {i.reason.replaceAll('_', ' ')}
            </li>
          ))}
        </ul>
      ) : null}
      <button
        type="button"
        onClick={onAgain}
        className="text-[14px] font-semibold text-(--bd-primary-600) hover:underline"
      >
        Invite more coordinators
      </button>
    </div>
  );
}

const TONE_CLS: Record<'success' | 'warn' | 'error', string> = {
  success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  warn: 'border-amber-200 bg-amber-50 text-amber-800',
  error: 'border-red-200 bg-red-50 text-red-700',
};

function Banner({
  tone,
  children,
}: Readonly<{ tone: 'success' | 'warn' | 'error'; children: ReactNode }>): JSX.Element {
  return (
    <output
      className={`mb-4 block rounded-[10px] border px-4 py-3 text-[13.5px] ${TONE_CLS[tone]}`}
    >
      {children}
    </output>
  );
}

/** Reads the canonical error envelope's code, tolerating a non-JSON body. */
async function readErrorCode(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: { code?: string } };
    return body.error?.code ?? null;
  } catch {
    return null;
  }
}
