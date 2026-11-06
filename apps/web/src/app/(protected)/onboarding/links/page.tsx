import type { JSX } from 'react';
import { RegistrationLinksView } from '../_components/RegistrationLinksView';

/**
 * Registration links page (Server Component).
 *
 * The view reads its data in the browser through TanStack Query.
 */
export default function RegistrationLinksPage(): JSX.Element {
  return <RegistrationLinksView />;
}
