'use client';

/**
 * Error screen body shared by the route `error.tsx` files: a title, a short
 * explanation, a retry and a link back to a home page.
 *
 * Callers pass translated copy only. Never pass the error's message or digest.
 */

import { startTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CircleAlert } from 'lucide-react';
import { buttonClass } from '@/components/ui/button-class';

/** Translated text for the error screen. */
export interface PageErrorCopy {
  title: string;
  body: string;
  retry: string;
  home: string;
}

/** Props for {@link PageError}. */
export interface PageErrorProps {
  copy: PageErrorCopy;
  /** Target of the home link. */
  homeHref: string;
  /** The `reset` function Next.js passes to `error.tsx`; clears the error state. */
  reset: () => void;
}

/**
 * Renders the error message with a retry button and a home link.
 *
 * Retry refreshes the route as well as resetting the boundary, so a page that
 * failed on a server read is fetched from the server again.
 */
export function PageError({ copy, homeHref, reset }: Readonly<PageErrorProps>) {
  const router = useRouter();
  const retry = () => {
    startTransition(() => {
      router.refresh();
      reset();
    });
  };
  return (
    <section className="bd-card bd-shadow mx-auto mt-10 flex max-w-lg flex-col items-center gap-3 px-6 py-10 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-full bg-rose-50 text-rose-600">
        <CircleAlert size={22} aria-hidden="true" />
      </span>
      <h1 className="font-display text-[20px] font-bold text-ink-900">{copy.title}</h1>
      <p className="text-[14px] text-ink-500">{copy.body}</p>
      <div className="mt-2 flex flex-wrap justify-center gap-2">
        <button type="button" className={buttonClass('primary')} onClick={retry}>
          {copy.retry}
        </button>
        <Link className={buttonClass('ghost')} href={homeHref}>
          {copy.home}
        </Link>
      </div>
    </section>
  );
}
