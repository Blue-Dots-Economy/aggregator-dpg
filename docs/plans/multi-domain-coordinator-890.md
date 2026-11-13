# Plan: coordinators managing multiple domains (#890)

## Goal

A coordinator can work with more than one domain (seeker and provider). The dashboard shows a domain dropdown that opens on one domain by default.

## Key points

1. **Most of the foundation exists.** aggregator-dpg already stores a list of domains per coordinator, and Signals already scopes dashboards, exports and decryption by a list.
2. **The work is in aggregator-dpg.** Registration, upload and link checks, and the portal screens still assume one domain.
3. **Signals needs no change and no data migration.**
4. **Admins can't fully give a coordinator a second domain today.** The console saves it, but bulk upload and link creation still reject the new domain, because they check a login-token value set once at registration.
5. **A single default org for all domains works with no code change.** It is an operations change in Signals. Existing self sign-up users stay with their current org unless moved.

## Changes in aggregator-dpg

| Area                    | Change                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| Domain checks           | Bulk upload and link creation allow any domain the coordinator serves, read from the database, not the token |
| Dashboard and export    | Open on the coordinator's first domain; refuse a domain they do not serve                                    |
| Profile API             | Return the coordinator's full domain list                                                                    |
| Sync to Signals         | Always send the full domain list (one path sends only the first domain)                                      |
| Registration            | Coordinator can pick more than one domain                                                                    |
| Dashboard screen        | Domain dropdown when the coordinator has more than one domain; the choice stays in the URL                   |
| Upload and link screens | Domain becomes a selector instead of a fixed label                                                           |
| Bug fix                 | A coordinator set to "all domains" gets stuck on the dashboard loading screen                                |
| Console                 | Ask for confirmation before removing a domain from a coordinator                                             |

## Single default org for all domains

### How it works today

A participant who signs up without an aggregator (Signals app or voice agent) goes to the default org for their domain. Production has two: one for seeker, one for provider. Defaults are set by a manual database change in Signals; there is no screen or API.

### Switching to one default org

Signals already allows one org to be the default for every domain. After the switch:

| Participant arrives through  | Goes to                        |
| ---------------------------- | ------------------------------ |
| Signals app sign-up          | The single default org         |
| Voice agent                  | The single default org         |
| A coordinator (upload, link) | That coordinator's org, as now |

Steps, done by an operator on the Signals database:

1. Pick the org. Reusing one of the two current default orgs means fewer users to move.
2. Add every domain to that org's domain list. If the org belongs to an aggregator-dpg coordinator, set the domains in the console.
3. In one step, remove the other org's default and make the chosen org the default for every domain.

### Existing users

The switch affects new sign-ups only.

| Option     | Result                                                                     | When to choose                                  |
| ---------- | -------------------------------------------------------------------------- | ----------------------------------------------- |
| Leave them | Old default org keeps its users and must stay in use to see or export them | Someone actively works the old org's users      |
| Move them  | All self sign-up users in one org; old org loses access to them            | Recommended when the old org has no active user |

Moving is a one-off production data fix, since Signals has no tool for it:

- Move only users who signed up without an aggregator. Users a coordinator onboarded stay where they are.
- Keep a list of moved users first; Signals does not log owner changes.
- Refresh the new org's dashboard afterwards. Without a refresh the dashboard can show old ownership for up to an hour.
- Profiles, consent and each user's domain do not change.

## Risks

| Risk                                                                                                                  | Mitigation                                                     |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| A domain list sent to Signals that leaves out the default org's domain hides those users from that org, with no error | Always send the full list; confirm before removing a domain    |
| A coordinator who gains a domain expects that domain's self sign-ups                                                  | Only the default org gets them; say so in the console          |
| The login-token domain value is also issued to the external campaign-manager client                                   | Confirm it does not rely on a single domain before changing it |

## Decisions needed

1. Can coordinators pick several domains at registration, or only admins in the console?
2. Dropdown (as in the issue) or one tab per domain?
3. Keep two default orgs, or move to one? If one, leave or move existing users?
4. Is either current default org linked to an aggregator-dpg coordinator? (A database check in production Signals.)
5. Is any Signals hardening (refusing a list that drops a default org's domain) in scope for this sprint?
