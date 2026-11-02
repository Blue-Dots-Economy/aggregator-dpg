# Multi-domain coordinators (#890)

## Summary

A coordinator should manage profiles in more than one domain (for example seeker and provider), with a domain dropdown on the dashboard. The data model and Signals already support a list of domains per coordinator. The work is in aggregator-dpg, where registration, the Keycloak claim, the API checks and the web portal still use a single domain. signals-dpg needs no schema change or migration.

## What already supports multiple domains

| Layer                              | State                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| Coordinator record                 | `users.serves text[]`; empty means every domain                                                  |
| Console                            | Admin can edit `serves` as a list; the change is pushed to Signals                               |
| Approval                           | Pushes the full `serves` list to Signals (`organization.metadata.domains`)                       |
| Signals dashboard, export, decrypt | Scope by the org's declared domain list; dashboard returns one block per domain (`by_domain`)    |
| Network config                     | Any number of domains per network                                                                |
| Org registration                   | Orgs have a `domains` field, validated against the network only; not enforced or sent to Signals |

## Gaps

| Area                        | Single-domain behaviour today                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Registration                | Form and API take one `type`; stored as a one-item `serves`                                                   |
| Keycloak `aggregator_type`  | Written once at signup, single-valued; the console `serves` edit never updates it                             |
| Bulk upload, link create    | Reject any domain other than the claim value                                                                  |
| Dashboard and export routes | Default to the network's first domain; never checked against `serves`                                         |
| Login backfill to Signals   | Sends only the first domain of `serves` (runs once, while the Signals org id is missing)                      |
| `profile/me`                | Returns `type` = first entry of `serves`                                                                      |
| Web dashboard               | View fixed to the coordinator's one domain; no selector                                                       |
| Web links and bulk upload   | Domain shown read-only                                                                                        |
| Bug                         | A coordinator with empty `serves` (every domain) has `type = null`; the dashboard stays on the loading screen |

Result today: an admin who widens `serves` updates Signals, but bulk upload and link creation still reject the second domain.

## Signals default aggregators

A participant who signs up without an aggregator (self sign-up, voice agent) is assigned to the org holding the default binding for their domain (`default_for_bindings`, for example `blue_dot/seeker`). Production has two default orgs, one per domain. Nominations are a manual database update; there is no API or runbook.

| Scenario                                             | Impact                                                                                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Default routing                                      | Unchanged: picked by binding, not by an org's domain list                                                                            |
| Coordinator mirrored to a default org gains a domain | Does not receive that domain's default participants unless the binding is updated by hand                                            |
| Multi-domain aggregator alongside the two defaults   | Allowed; only bindings are exclusive                                                                                                 |
| One org holding both bindings (merge)                | Allowed by schema; needs an ordered manual procedure; existing participants stay with the old org (assignment is write-once)         |
| Participant single-domain lock (`DOMAIN_LOCKED`)     | Unaffected; a person is still one domain                                                                                             |
| Upsert that drops a domain a default org is bound to | Risk: accepted without error; the org keeps receiving new participants for that domain but can no longer see, export or decrypt them |

The last row matters for #890: the login backfill and a console `serves` edit both rewrite the Signals domain list. Whether this can hit production depends on whether the two default orgs are aggregator-dpg coordinator mirrors (check `metadata.external_id` on orgs with a binding).

## Changes

| Area                                   | Change                                                                                                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| API checks                             | Replace the claim comparison with an "is in `serves`" check (empty = all) for bulk template, bulk create and link create                                                                                                 |
| Dashboard and export routes            | Default to the first served domain; reject a domain not served                                                                                                                                                           |
| Login backfill                         | Send the full `serves`, or every network domain when empty                                                                                                                                                               |
| `profile/me`                           | Add `serves: string[]`; keep `type` for compatibility                                                                                                                                                                    |
| Lists                                  | Optional `domain` filter on links and bulk-upload lists                                                                                                                                                                  |
| Registration                           | Domain field becomes multi-select across all per-network schema copies; API accepts a list                                                                                                                               |
| Keycloak                               | Stop gating on `aggregator_type`; either leave it informational or make it multivalued and keep it in sync                                                                                                               |
| Web                                    | Shared active-domain state (URL `?domain=`, then last choice, then first served); dropdown when more than one domain; selectors on links and bulk upload; sidebar badge and `/profile` follow it; fix the null-type hang |
| Console                                | Confirm before removing a domain from `serves` (removal cuts decrypt access to that domain's existing participants)                                                                                                      |
| signals-dpg (optional, separate issue) | Refuse or warn on an upsert that drops a bound domain; check declared domains on onboarding; write the default-nomination runbook                                                                                        |

No database backfill is needed. Single-domain tests in bulk upload, links, registration, dashboard and the matching web components need updating.

## Open questions

1. Do coordinators pick domains at registration, or only admins in the console? Console-only drops the registration change.
2. Dropdown (as in the issue) or one tab per domain?
3. Does empty `serves` stay valid as "every domain", with the dropdown listing all network domains?
4. Keycloak `aggregator_type`: leave informational, or make multivalued? Does the external campaign-manager system read it?
5. Are the two production default orgs aggregator-dpg coordinator mirrors?
6. Are the Signals hardening items in scope for this sprint?
