'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import type { useUpdateLink } from '@/hooks/useOnboarding';
import type { ApiRegistrationLink } from '@/services/onboarding.service';
import {
  buildLinkSlug,
  buildLinkTitle,
  contextString,
  contextTagsText,
  failureText,
  parseTags,
  type LinkFormFields,
} from './link-form';
import { LinkField } from './LinkField';

/** State and save action of a draft link's edit form; see {@link useLinkEditForm}. */
export interface LinkEdit {
  form: LinkFormFields;
  setField: (key: keyof LinkFormFields, value: string) => void;
  /** Message of the last failed save. */
  error: string | null;
  /** Saves the edits; resolves `true` on success. */
  save: () => Promise<boolean>;
  /** Whether a save is in flight. */
  saving: boolean;
}

/**
 * Holds the edit form of a draft link.
 *
 * Call it in the card, so typed values are kept while the form is closed.
 * Saves the context fields and a new slug; the registration mode is not sent.
 */
export function useLinkEditForm(
  link: ApiRegistrationLink,
  update: ReturnType<typeof useUpdateLink>,
): LinkEdit {
  const ctx = link.context;
  const [form, setForm] = useState<LinkFormFields>(() => ({
    state: contextString(ctx, 'state'),
    district: contextString(ctx, 'district'),
    lever_event: contextString(ctx, 'lever_event'),
    event_date: contextString(ctx, 'event_date'),
    event_location: contextString(ctx, 'event_location'),
    tags: contextTagsText(ctx),
  }));
  const [error, setError] = useState<string | null>(null);

  const save = async (): Promise<boolean> => {
    setError(null);
    try {
      const slug = buildLinkSlug(form);
      await update.mutateAsync({
        id: link.link_id,
        patch: {
          ...(slug ? { slug } : {}),
          context: {
            ...ctx,
            title: buildLinkTitle(form),
            state: form.state || undefined,
            district: form.district || undefined,
            lever_event: form.lever_event || undefined,
            event_date: form.event_date || undefined,
            event_location: form.event_location || undefined,
            tags: parseTags(form.tags),
          },
        },
      });
      return true;
    } catch (err) {
      setError(failureText(err));
      return false;
    }
  };

  return {
    form,
    setField: (key, value) => setForm((f) => ({ ...f, [key]: value })),
    error,
    save,
    saving: update.isPending,
  };
}

/** Props for {@link LinkEditForm}. */
export interface LinkEditFormProps {
  edit: LinkEdit;
  /** Called after a successful save, and on Cancel. */
  onClose: () => void;
}

/** Inline edit form for a draft link. */
export function LinkEditForm({ edit, onClose }: Readonly<LinkEditFormProps>) {
  const t = useTranslations('onboarding');
  const { form, setField, error, saving } = edit;
  const onSave = async () => {
    // The Save button is disabled while required fields are missing.
    if (await edit.save()) onClose();
  };

  return (
    <div className="mt-4 pt-4 border-t border-(--bd-border) grid grid-cols-1 md:grid-cols-2 gap-3">
      <LinkField label={t('create_link.field_state')} required>
        <input
          className="bd-input"
          value={form.state}
          onChange={(e) => setField('state', e.target.value)}
        />
      </LinkField>
      <LinkField label={t('create_link.field_district')} required>
        <input
          className="bd-input"
          value={form.district}
          onChange={(e) => setField('district', e.target.value)}
        />
      </LinkField>
      <LinkField label={t('create_link.field_event')} required>
        <input
          className="bd-input"
          value={form.lever_event}
          onChange={(e) => setField('lever_event', e.target.value)}
        />
      </LinkField>
      <LinkField label={t('create_link.field_event_date')}>
        <input
          type="date"
          className="bd-input"
          value={form.event_date}
          onChange={(e) => setField('event_date', e.target.value)}
        />
      </LinkField>
      <LinkField label={t('create_link.field_event_location')}>
        <input
          className="bd-input"
          value={form.event_location}
          onChange={(e) => setField('event_location', e.target.value)}
        />
      </LinkField>
      {error && (
        <div className="md:col-span-2 text-[12.5px] text-rose-700 bg-rose-50 border border-rose-200 rounded-[10px] px-3 py-2">
          {error}
        </div>
      )}
      <div className="md:col-span-2 flex items-center justify-end gap-2">
        <Button kind="ghost" onClick={onClose} disabled={saving}>
          {t('link_card.cancel')}
        </Button>
        <Button
          onClick={onSave}
          disabled={saving || !form.state || !form.district || !form.lever_event}
        >
          {saving ? t('link_card.saving') : t('link_card.save_draft')}
        </Button>
      </div>
    </div>
  );
}
