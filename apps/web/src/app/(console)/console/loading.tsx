/**
 * Shown while a console page renders. Every console page reads from the API
 * on the server before it can render.
 */

import { PageLoading } from '@/components/ui/PageLoading';

export default function ConsoleLoading() {
  return <PageLoading />;
}
