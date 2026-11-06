/**
 * Reads the caller's IP address for BFF routes that forward it to the API,
 * which rate-limits per caller (web app).
 */

/**
 * The caller's IP: the first `x-forwarded-for` entry, else the request's `ip`
 * when the host sets one, else an empty string.
 *
 * @param req - The incoming request.
 * @returns The IP address, or `''` when it is not known.
 */
export function clientIpOf(req: Request): string {
  const first = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '';
  if (first) return first;
  return 'ip' in req && typeof req.ip === 'string' ? req.ip : '';
}
