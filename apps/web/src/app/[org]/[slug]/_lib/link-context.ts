/**
 * Reads the event details a registration link carries in its `context` (web app).
 */

/** Title shown when the link context has neither `title` nor `lever_event`. */
const DEFAULT_EVENT_LABEL = 'Register';

/** Event details for the page's hero band. */
export interface LinkEventDetails {
  /** `title`, else `lever_event`, else a default. */
  eventLabel: string;
  /** `org_name`, or `''`. */
  orgName: string;
  /** District, state and event location joined with ` · `, or `''`. */
  locationLabel: string;
}

/**
 * The value when it is a string, else `''`.
 *
 * @param value - A context value.
 */
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Reads the hero band's text from a link's context. Values that are not
 * strings are ignored.
 *
 * @param context - The link's `context` object.
 */
export function readLinkEventDetails(context: Record<string, unknown>): LinkEventDetails {
  return {
    eventLabel: text(context['title']) || text(context['lever_event']) || DEFAULT_EVENT_LABEL,
    orgName: text(context['org_name']),
    locationLabel: [context['district'], context['state'], context['event_location']]
      .map(text)
      .filter((v) => v.length > 0)
      .join(' · '),
  };
}
