import type { JSX } from 'react';
import type { LinkEventDetails } from '../_lib/link-context';

/** Props for {@link RegistrationHero}. */
export interface RegistrationHeroProps {
  /** Band fill colour. */
  color: string;
  /** Domain label above the title. */
  domainLabel: string;
  details: LinkEventDetails;
}

/**
 * Coloured band at the top of the card: domain, event title, organisation
 * and location.
 */
export function RegistrationHero({
  color,
  domainLabel,
  details,
}: Readonly<RegistrationHeroProps>): JSX.Element {
  const { eventLabel, orgName, locationLabel } = details;
  return (
    <div
      className="px-6 sm:px-8 py-6 text-white relative overflow-hidden"
      style={{ background: color }}
    >
      <div className="text-[11.5px] uppercase tracking-[0.14em] font-semibold text-white/70">
        {domainLabel}
      </div>
      <h1 className="font-display font-bold text-[24px] sm:text-[28px] tracking-tight leading-tight mt-1.5">
        {eventLabel}
      </h1>
      {(orgName || locationLabel) && (
        <p className="text-[13.5px] text-white/85 mt-1.5">
          {orgName ? <span className="font-semibold">{orgName}</span> : null}
          {orgName && locationLabel ? <span className="text-white/60"> · </span> : null}
          {locationLabel}
        </p>
      )}
    </div>
  );
}
