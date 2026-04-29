import { redirect } from 'next/navigation';
import { getSession } from '../lib/server-session';

export default async function HomePage() {
  const session = await getSession();
  redirect(session ? '/blue-dots' : '/login');
}
