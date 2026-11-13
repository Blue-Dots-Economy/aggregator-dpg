/**
 * The card at the top of a console list page: the organisation, its status,
 * the viewer's part in it and the page's main action.
 */

import type { ReactNode } from 'react';
import { I } from '../../icons';
import { ConsoleStatusPill, type ConsoleStatus } from './ConsoleUi';

export function ConsoleOrgCard({
  name,
  status,
  note,
  action,
}: Readonly<{
  name: string;
  status?: ConsoleStatus;
  note: string;
  action?: ReactNode;
}>) {
  return (
    <div className="bd-card bd-shadow flex flex-wrap items-center gap-3.5 px-5 py-4">
      <span className="grid h-10 w-10 flex-none place-items-center rounded-[11px] bg-(--bd-primary-50) text-(--bd-primary)">
        <I.briefcase size={20} />
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2.5 font-display text-[17px] font-extrabold text-ink-900">
          <span className="truncate">{name}</span>
          {status ? <ConsoleStatusPill status={status} /> : null}
        </div>
        <div className="text-[12.5px] text-ink-500">{note}</div>
      </div>
      {action ? <div className="w-full sm:ml-auto sm:w-auto">{action}</div> : null}
    </div>
  );
}
