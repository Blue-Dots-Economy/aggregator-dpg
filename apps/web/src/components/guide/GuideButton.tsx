'use client';

import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { CircleHelp, PlayCircle } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { hasSeenTour, isTourRunning, markTourSeen, runTour } from './run-tour';
import { TOURS, findTour, type GuideTour } from './tours';

/**
 * Top-bar "?" menu: tours for this page first, then the rest. Also plays a
 * first-visit tour once and honours `?tour=<id>` links (e.g. from a training
 * email).
 *
 * `?tour` is read from `window.location` rather than `useSearchParams`, so the
 * Topbar never needs a Suspense boundary on a statically rendered page.
 */
export function GuideButton() {
  const t = useTranslations('guide');
  const router = useRouter();
  const pathname = usePathname() ?? '/';
  const [open, setOpen] = React.useState(false);

  const here = TOURS.filter((tour) => tour.matches(pathname));
  const elsewhere = TOURS.filter((tour) => !tour.matches(pathname));

  const start = React.useCallback(
    (tour: GuideTour) => {
      setOpen(false);
      markTourSeen(tour.id);
      if (!tour.matches(pathname)) router.push(tour.path);
      void runTour(tour);
    },
    [pathname, router],
  );

  React.useEffect(() => {
    if (isTourRunning()) return;
    const params = new URLSearchParams(window.location.search);
    const requested = params.get('tour');
    if (requested) {
      params.delete('tour');
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname);
      const tour = findTour(requested);
      if (tour) start(tour);
      return;
    }
    // First visit: play the page's auto-start tour once. Skipped under test
    // runners and browser automation, where an overlay would block the run.
    if (process.env.NODE_ENV === 'test' || navigator.webdriver) return;
    const tour = TOURS.find((x) => x.autoStart && x.matches(pathname));
    if (tour && !hasSeenTour(tour.id)) start(tour);
  }, [pathname, router, start]);

  const label = t('menu');

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          data-tour="guide-button"
          title={label}
          aria-label={label}
          className="w-9 h-9 rounded-[10px] flex items-center justify-center border border-(--bd-border) bg-(--bd-card) text-(--bd-fg-muted) hover:text-(--bd-fg) hover:bg-(--bd-border-soft) transition-colors"
        >
          <CircleHelp size={16} />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="end"
          sideOffset={6}
          className="z-50 w-64 rounded-[12px] border border-(--bd-border) bg-(--bd-card) p-1 shadow-lg"
        >
          <nav aria-label={label}>
            {here.length > 0 && (
              <TourGroup heading={t('this_page')} tours={here} onSelect={start} />
            )}
            {here.length > 0 && elsewhere.length > 0 && (
              <div className="my-1 border-t border-(--bd-border-soft)" />
            )}
            {elsewhere.length > 0 && (
              <TourGroup heading={t('how_do_i')} tours={elsewhere} onSelect={start} />
            )}
          </nav>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function TourGroup({
  heading,
  tours,
  onSelect,
}: Readonly<{ heading: string; tours: GuideTour[]; onSelect: (tour: GuideTour) => void }>) {
  return (
    <div>
      <div className="px-2.5 pt-2 pb-1 text-[10.5px] uppercase tracking-[0.12em] font-semibold text-(--bd-fg-muted) opacity-70">
        {heading}
      </div>
      {tours.map((tour) => (
        <button
          key={tour.id}
          type="button"
          data-tour-item={tour.id}
          onClick={() => onSelect(tour)}
          className="w-full flex items-center gap-2 rounded-[8px] px-2.5 py-2 text-left text-[13px] text-(--bd-fg) hover:bg-(--bd-border-soft) transition-colors"
        >
          <PlayCircle size={15} className="shrink-0 text-(--bd-fg-muted)" />
          {tour.title}
        </button>
      ))}
    </div>
  );
}
