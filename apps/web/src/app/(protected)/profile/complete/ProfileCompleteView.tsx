'use client';

import { useEffect, useMemo, useState, type FormEvent, type JSX } from 'react';
import type { RJSFSchema } from '@rjsf/utils';
import type { IChangeEvent } from '@rjsf/core';
import { RjsfThemedForm } from '../../../../components/forms/RjsfThemed';
import { Button } from '../../../../components/ui/Button';
import { Topbar } from '../../../../components/shell/Topbar';
import { I } from '../../../../icons';

interface ProfileCompleteViewProps {
  schema: RJSFSchema;
  uiSchema: Record<string, unknown>;
}

interface ProfileBody {
  data: Record<string, unknown>;
  consent: Record<string, unknown>;
  is_complete: boolean;
}

type SubmitState =
  | { status: 'loading' }
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'saved' }
  | { status: 'error'; message: string };

export function ProfileCompleteView({ schema, uiSchema }: ProfileCompleteViewProps): JSX.Element {
  const [formData, setFormData] = useState<Record<string, unknown>>({});
  const [consent, setConsent] = useState<Record<string, unknown>>({});
  const [state, setState] = useState<SubmitState>({ status: 'loading' });

  const formSchema = useMemo<RJSFSchema>(() => {
    const clone: RJSFSchema = { ...schema };
    delete (clone as { title?: string }).title;
    delete (clone as { description?: string }).description;
    return clone;
  }, [schema]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/aggregator/profile/me', { credentials: 'include' });
        if (!res.ok) {
          if (!cancelled) setState({ status: 'idle' });
          return;
        }
        const body = (await res.json()) as ProfileBody;
        if (cancelled) return;
        setFormData(body.data ?? {});
        setConsent(body.consent ?? {});
        setState({ status: 'idle' });
      } catch (err) {
        if (!cancelled) {
          setState({
            status: 'error',
            message: err instanceof Error ? err.message : 'load failed',
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = async (
    e: IChangeEvent<Record<string, unknown>>,
    _event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    setState({ status: 'submitting' });
    try {
      const res = await fetch('/api/aggregator/profile/me', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: e.formData ?? {}, consent }),
        credentials: 'include',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        setState({
          status: 'error',
          message: body.message ?? `Save failed (HTTP ${res.status})`,
        });
        return;
      }
      setState({ status: 'saved' });
    } catch (err) {
      setState({
        status: 'error',
        message: err instanceof Error ? err.message : 'Network error',
      });
    }
  };

  return (
    <div className="fade-up">
      <Topbar
        title="Complete your profile"
        subtitle="A few details about your organisation so we can match you with the right opportunities."
      />

      <div className="bd-card bd-shadow overflow-hidden">
        <div className="px-7 py-7">
          {state.status === 'loading' && (
            <div className="text-[13px] text-ink-400">Loading profile…</div>
          )}
          {state.status !== 'loading' && (
            <RjsfThemedForm<Record<string, unknown>>
              schema={formSchema}
              uiSchema={uiSchema}
              formData={formData}
              onChange={(e) => setFormData((e.formData ?? {}) as Record<string, unknown>)}
              onSubmit={handleSubmit}
            >
              <div className="flex items-center justify-between border-t border-[var(--bd-border)] mt-6 pt-5">
                {state.status === 'saved' && (
                  <span className="inline-flex items-center gap-1.5 text-emerald-700 text-[12.5px] font-semibold">
                    <I.check size={14} /> Saved
                  </span>
                )}
                {state.status === 'error' && (
                  <span className="inline-flex items-center gap-1.5 text-rose-600 text-[12.5px] font-semibold">
                    <I.alert size={14} /> {state.message}
                  </span>
                )}
                <div className="ml-auto">
                  <Button
                    type="submit"
                    icon={<I.check size={14} />}
                    disabled={state.status === 'submitting'}
                  >
                    {state.status === 'submitting' ? 'Saving…' : 'Save profile'}
                  </Button>
                </div>
              </div>
            </RjsfThemedForm>
          )}
        </div>
      </div>
    </div>
  );
}
