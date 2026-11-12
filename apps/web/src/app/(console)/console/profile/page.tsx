/**
 * Console profile: the caller's own organisation page. Anyone without one
 * organisation of their own goes to the organisations page.
 */

import { redirect } from 'next/navigation';
import { getConsoleActor } from '@/lib/console-actor';
import { ownProfileOrgId } from '@/lib/capabilities';
import ConsoleOrgPage from '../orgs/[id]/page';

export default async function ConsoleProfilePage() {
  const actor = await getConsoleActor();
  if (!actor.ok) return null;
  const id = ownProfileOrgId(actor.me);
  if (!id) redirect('/console/orgs');
  return ConsoleOrgPage({ params: Promise.resolve({ id }) });
}
