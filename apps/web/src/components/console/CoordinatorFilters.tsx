'use client';

/**
 * The coordinator list's filters: organisation, status and served domain.
 *
 * A plain GET form; the page re-reads on the server. It applies when a filter
 * changes. The Apply button shows only without JavaScript. The organisation
 * filter shows only when the viewer reaches more than one organisation.
 */

import type { ChangeEvent, ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '../ui/Button';
import type { OrgOption } from '../../lib/console-org-options';

const STATUSES = ['pending', 'active', 'inactive', 'retired'] as const;

/** Current filter values; empty means "all". */
export interface CoordinatorFilterValues {
  orgId: string;
  status: string;
  serves: string;
}

/**
 * Renders the filter bar.
 *
 * @param action - The page to submit to.
 * @param values - The current values.
 * @param orgs - The organisation choices, in tree order.
 * @param domains - The network's domains.
 */
export function CoordinatorFilters({
  action,
  values,
  orgs,
  domains,
}: Readonly<{
  action: string;
  values: CoordinatorFilterValues;
  orgs: readonly OrgOption[];
  domains: ReadonlyArray<{ id: string; label: string }>;
}>) {
  const t = useTranslations('console');
  /** Submits the form, leaving out "all" choices so the URL holds only real filters. */
  const submit = (e: ChangeEvent<HTMLSelectElement>) => {
    const form = e.currentTarget.form;
    if (!form) return;
    for (const el of Array.from(form.elements)) {
      if (el instanceof HTMLSelectElement && el.value === '') el.disabled = true;
    }
    form.requestSubmit();
  };
  const field = (label: string, select: ReactNode) => (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] font-medium text-(--bd-fg-muted)">{label}</span>
      {select}
    </label>
  );
  return (
    // Keyed on the values: a link to other filters (Clear filters, a chip) is a
    // client navigation, and the selects only read their value when created.
    <form
      key={`${values.orgId}|${values.status}|${values.serves}`}
      method="get"
      action={action}
      className="flex flex-wrap items-end gap-3 text-[13.5px]"
    >
      {orgs.length > 1
        ? field(
            t('coordinators.org_filter'),
            <select
              name="org_id"
              defaultValue={values.orgId}
              className="bd-input min-w-[240px] max-w-[360px]"
              onChange={submit}
            >
              <option value="">{t('coordinators.all_orgs')}</option>
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>,
          )
        : null}
      {field(
        t('coordinators.status_filter'),
        <select
          name="status"
          defaultValue={values.status}
          className="bd-input min-w-[150px]"
          onChange={submit}
        >
          <option value="">{t('coordinators.all')}</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`status.${s}`)}
            </option>
          ))}
        </select>,
      )}
      {domains.length > 0
        ? field(
            t('coordinators.serves_filter'),
            <select
              name="serves"
              defaultValue={values.serves}
              className="bd-input min-w-[150px]"
              onChange={submit}
            >
              <option value="">{t('coordinators.all_domains')}</option>
              {domains.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>,
          )
        : null}
      <noscript>
        <Button type="submit" kind="ghost">
          {t('coordinators.apply')}
        </Button>
      </noscript>
    </form>
  );
}
