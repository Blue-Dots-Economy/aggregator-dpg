import { permanentRedirect } from 'next/navigation';

/**
 * Both consent documents live on `/legal` now. This path is one of the two
 * operators have already shared over SMS and email (Signals-DPG#637), so it
 * keeps working — as a redirect that carries the reader to the privacy section
 * of that page.
 *
 * `permanentRedirect` (308) rather than a temporary one: the move is not going
 * to be undone, so clients and search engines may as well remember it instead
 * of re-asking on every visit. The fragment survives — a browser keeps the one
 * it is given in `Location`.
 */
export default function PrivacyRedirect(): never {
  permanentRedirect('/legal#privacy');
}
