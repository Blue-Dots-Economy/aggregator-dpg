import { redirect } from 'next/navigation';

/**
 * Both consent documents live on `/legal` now. This path is one of the two
 * operators have already shared over SMS and email (Signals-DPG#637), so it
 * keeps working — as a redirect that carries the reader to the privacy section
 * of that page.
 *
 * A 307, deliberately not `permanentRedirect`'s 308: a 308 is cached by
 * browsers indefinitely and never revalidated, so restoring this route later
 * would not restore the behaviour of anyone who had already hit it once. The
 * `/legal` naming stays a cheap call to reverse only while this redirect is
 * temporary — promote it to 308 once nobody wants these paths back.
 *
 * The fragment survives either way: a browser keeps the one it is given in
 * `Location`.
 */
export default function PrivacyRedirect(): never {
  redirect('/legal#privacy');
}
