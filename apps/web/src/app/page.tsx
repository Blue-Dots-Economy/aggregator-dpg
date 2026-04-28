'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../lib/auth-context';

export default function HomePage() {
  const router = useRouter();
  const { isAuthenticated, isHydrated } = useAuth();

  useEffect(() => {
    if (!isHydrated) return;
    router.replace(isAuthenticated ? '/blue-dots' : '/login');
  }, [isHydrated, isAuthenticated, router]);

  return null;
}
