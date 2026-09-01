import { permanentRedirect } from 'next/navigation';

/**
 * Both consent documents live on `/legal` now. This is the path
 * Signals-DPG#637 names for operators to share over SMS and email, so it keeps
 * working — as a redirect that carries the reader to the terms section of that
 * page. See `../privacy/page.tsx` for why the redirect is permanent.
 */
export default function TermsRedirect(): never {
  permanentRedirect('/legal#terms');
}
