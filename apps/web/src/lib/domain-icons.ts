/**
 * Icons for network domains (`apps/web`), so a domain looks the same here as
 * in the Signals UI. Copied from signals-dpg `apps/ui/src/lib/domain-icons.ts`;
 * keep the two in step.
 *
 * @module apps/web/src/lib/domain-icons
 */

import {
  Accessibility,
  Box,
  Briefcase,
  Building2,
  GraduationCap,
  HandHeart,
  Search,
  UserCheck,
  type LucideIcon,
} from 'lucide-react';

/**
 * `<network_id>:<domain_id>` keys are tried first so one domain id can render
 * differently per network; the plain domain id is the fallback, then `Box`.
 */
export const domainIcons: Record<string, LucideIcon> = {
  // blue_dot (opportunities)
  'blue_dot:seeker': Search,
  'blue_dot:provider': Briefcase,
  'blue_dot:service_provider': Building2,

  // purple_dot (disability services)
  'purple_dot:seeker': Accessibility,
  'purple_dot:provider': HandHeart,

  // Network-agnostic fallbacks; yellow_dot (education):
  student_profile: GraduationCap,
  learner_profile: GraduationCap,
  student: GraduationCap,
  tutor_counsellor_profile: UserCheck,
  tutor_counsellor: UserCheck,
  coaching_center: Building2,
  // Neutral seeker/provider icons, so an unmapped network does not imply disability services.
  seeker: Search,
  provider: Briefcase,
  service_provider: Building2,
};

/**
 * The icon for a domain.
 *
 * @param domainId - The domain id, e.g. `seeker`.
 * @param networkId - The network id, e.g. `blue_dot`, for a network-specific icon.
 * @returns The icon, or `Box` for an unknown domain.
 */
export function getDomainIcon(
  domainId: string | null | undefined,
  networkId?: string | null,
): LucideIcon {
  if (!domainId) return Box;
  if (networkId) {
    const scoped = domainIcons[`${networkId}:${domainId}`];
    if (scoped) return scoped;
  }
  return domainIcons[domainId] ?? Box;
}
