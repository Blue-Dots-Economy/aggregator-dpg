'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Sidebar } from '../../components/shell/Sidebar';
import { useAuth } from '../../lib/auth-context';

export default function PortalLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { isAuthenticated, isHydrated } = useAuth();

  useEffect(() => {
    if (isHydrated && !isAuthenticated) {
      router.replace('/login');
    }
  }, [isHydrated, isAuthenticated, router]);

  if (!isHydrated || !isAuthenticated) {
    return null;
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 min-w-0 overflow-x-hidden">
        <div className="max-w-[1480px] mx-auto px-8 py-7">{children}</div>
      </main>
    </div>
  );
}
