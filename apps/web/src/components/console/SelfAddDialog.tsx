'use client';

/**
 * "Add myself to My Team" on the owner's team list: an org owner creates their
 * own coordinator account in an organisation they own.
 *
 * The dialog asks for the profile types (at least one) and, for an owner of
 * several organisations, the organisation. It then opens the same consent gate
 * as coordinator registration, with the same Terms and Privacy documents and
 * agreement copy, and posts through `POST /api/console/user/self-add`. The
 * API's refusals show in the dialog; on success the page refreshes.
 */

import { useEffect, useMemo, useRef, useState, type SubmitEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { SelfAddRequestSchema } from '@aggregator-dpg/shared-primitives/user-org';
import { Button } from '../ui/Button';
import { Label } from '../ui/Label';
import { SelectField } from '../ui/SelectField';
import { ConsentGate } from '../consent/ConsentGate';
import { toConsentDocs } from '../consent/consent-docs';
import type { ConsentDocContent } from '../consent/consent-types';
import { useFieldErrorCopy } from '../forms/useFieldErrors';
import { FieldMessage, useHandFieldErrors } from '../forms/useHandFieldErrors';
import { addMyself, errorKey, RESPONSE_SHAPE_CODE } from '@/lib/console-client';
import { stampConsent } from '@/app/(public)/register/registration-shared';
import { I } from '@/icons';

/** An organisation the owner may add themselves to. */
export interface SelfAddOrg {
  id: string;
  name: string;
}

/** A network domain offered as a profile type. */
export interface SelfAddDomain {
  id: string;
  label: string;
}

/** Props of {@link AddMyselfButton}. */
export interface AddMyselfButtonProps {
  /** From `selfAddOrgs`; never empty where the button renders. */
  orgs: readonly SelfAddOrg[];
  /** The network's domains, in configuration order. */
  domains: readonly SelfAddDomain[];
  /** Coordinator Terms and Privacy; `null` when they could not be loaded. */
  consent: ConsentDocContent | null;
}

/**
 * Renders the "Add myself to My Team" button and, when open, its dialog.
 *
 * @param props - The organisations, the profile types and the consent documents.
 */
export function AddMyselfButton({ orgs, domains, consent }: Readonly<AddMyselfButtonProps>) {
  const t = useTranslations('console');
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        kind="soft"
        icon={<I.plus size={15} aria-hidden="true" />}
        onClick={() => setOpen(true)}
        className="w-full justify-center sm:w-auto"
      >
        {t('self_add.button')}
      </Button>
      {open ? (
        <SelfAddDialog
          orgs={orgs}
          domains={domains}
          consent={consent}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/** The open dialog: profile types, the organisation when there is a choice, and the submit. */
function SelfAddDialog({
  orgs,
  domains,
  consent,
  onClose,
}: Readonly<AddMyselfButtonProps & { onClose: () => void }>) {
  const t = useTranslations('console');
  const tr = useTranslations('register');
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const onlyOrg = orgs.length === 1 ? orgs[0] : undefined;
  const [orgId, setOrgId] = useState(onlyOrg?.id ?? '');
  const [serves, setServes] = useState<readonly string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [gateOpen, setGateOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const consentDocs = useMemo(() => toConsentDocs(consent ?? undefined), [consent]);
  const agreeLabel = `${tr('consent.accept_prefix')}${tr('consent.privacy_link')}${tr('consent.and')}${tr('consent.terms_link')}.`;

  // Native <dialog> gives focus trapping, focus restore, and Esc-to-close.
  useEffect(() => {
    const el = dialogRef.current;
    el?.showModal?.();
    return () => el?.close?.();
  }, []);

  const copy = useFieldErrorCopy();
  const fe = useHandFieldErrors<'org' | 'serves'>('self-add', {
    org: orgId ? null : { kind: 'required', message: copy.required(t('self_add.org')) },
    serves:
      serves.length > 0 ? null : { kind: 'required', message: copy.required(t('self_add.serves')) },
  });

  const toggle = (id: string, on: boolean) => {
    setMessage(null);
    setServes((prev) => (on ? [...prev, id] : prev.filter((s) => s !== id)));
  };

  const close = () => {
    dialogRef.current?.close?.();
    onClose();
  };

  function onSubmit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!fe.validate()) return;
    if (consentDocs.length === 0) {
      setMessage(tr('consent.load_failed_detail'));
      return;
    }
    setGateOpen(true);
  }

  /** Runs after the consent gate is accepted: posts the request with the stamped consent. */
  async function submitWithConsent() {
    setGateOpen(false);
    const body = SelfAddRequestSchema.safeParse({
      org_id: orgId,
      // Network order, whatever order the boxes were ticked in.
      serves: domains.filter((d) => serves.includes(d.id)).map((d) => d.id),
      consent: stampConsent({ value: true }),
    });
    if (!body.success) {
      setMessage(t('errors.generic'));
      return;
    }
    setBusy(true);
    const r = await addMyself(body.data);
    setBusy(false);
    if (r.ok) {
      close();
      router.refresh();
      return;
    }
    // The account may have been added: reload the page's copy.
    if (r.error.code === RESPONSE_SHAPE_CODE) router.refresh();
    setMessage(t(errorKey(r)));
  }

  return (
    <dialog
      ref={dialogRef}
      aria-label={t('self_add.title')}
      // Escape fires "cancel". The effect cleanup's close() also fires "close",
      // so closing the React state on "close" would unmount the dialog at once.
      onCancel={onClose}
      className="m-auto w-full max-w-[460px] rounded-[14px] bg-white p-5 shadow-xl backdrop:bg-black/40"
    >
      <h3 className="mb-1 font-display text-[15px] font-bold text-ink-900">
        {t('self_add.title')}
      </h3>
      <p className="mb-4 text-[13px] text-ink-600">{t('self_add.intro')}</p>
      <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
        {onlyOrg ? null : (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="self-add-org">{t('self_add.org')}</Label>
            <SelectField
              {...fe.controlProps('org')}
              value={orgId}
              aria-required
              placeholder={t('self_add.org_placeholder')}
              onChange={(v) => {
                setOrgId(v);
                setMessage(null);
              }}
              options={orgs.map((o) => ({ value: o.id, label: o.name }))}
            />
            <FieldMessage id={fe.errorId('org')} message={fe.message('org')} />
          </div>
        )}
        <fieldset
          {...fe.controlProps('serves')}
          tabIndex={-1}
          className="m-0 flex flex-col gap-2 border-0 p-0"
        >
          <legend className="mb-1.5 text-[13px] font-semibold text-ink-800">
            {t('self_add.serves')}
          </legend>
          {domains.map((d) => (
            <label key={d.id} className="flex items-center gap-2.5 text-[13.5px] text-ink-800">
              <input
                type="checkbox"
                checked={serves.includes(d.id)}
                onChange={(e) => toggle(d.id, e.target.checked)}
                className="h-4 w-4 accent-(--bd-primary-600)"
              />
              {d.label}
            </label>
          ))}
          <FieldMessage id={fe.errorId('serves')} message={fe.message('serves')} />
        </fieldset>
        {message ? <output className="text-[13px] text-rose-600">{message}</output> : null}
        <div className="flex items-center justify-end gap-3">
          <Button kind="ghost" onClick={close}>
            {t('self_add.cancel')}
          </Button>
          <Button type="submit" disabled={busy}>
            {t('self_add.submit')}
          </Button>
        </div>
      </form>
      <ConsentGate
        open={gateOpen}
        docs={consentDocs}
        agreeLabel={agreeLabel}
        onAccept={() => void submitWithConsent()}
        onCancel={() => setGateOpen(false)}
      />
    </dialog>
  );
}
