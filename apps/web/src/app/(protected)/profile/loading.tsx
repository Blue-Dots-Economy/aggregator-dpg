/**
 * Shown while the profile page renders. The page loads the registration
 * schema and the network's organisation types on the server first.
 */

import { PageLoading } from '@/components/ui/PageLoading';

export default function ProfileLoading() {
  return <PageLoading />;
}
