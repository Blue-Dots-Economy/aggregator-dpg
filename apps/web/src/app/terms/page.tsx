import { redirect } from 'next/navigation';

/**
 * Both consent documents live on `/legal` now. This is the path
 * Signals-DPG#637 names for operators to share over SMS and email, so it keeps
 * working — as a redirect that carries the reader to the terms section of that
 * page. See `../privacy/page.tsx` for why it is a 307 and not a 308.
 */
export default function TermsRedirect(): never {
  redirect('/legal#terms');
}
