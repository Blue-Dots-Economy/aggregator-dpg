---
name: aggregator-e2e
description: Use when the user wants to end-to-end test the aggregator locally — launches the stack (docker + mailpit) and exercises every flow from the UI in a real browser plus the backend API directly. Covers invite-only onboarding (invite, register, email-code activation), OTP login, dashboard, profile, registration links + public submit, bulk CSV upload, contact support, and campaign jobs, with the key negative cases. Triggers: "test all the flows", "full e2e", "run the aggregator end to end", "test everything from the UI".
---

# Aggregator DPG — full-stack E2E

Launches the local stack and drives every user-facing flow twice: once through the
real UI in a visible browser, once against the API directly. The two halves catch
different things. The UI half catches wiring the API tests can't see (a BFF route
using the wrong auth helper, a disabled submit button, a consent gate that never
unlocks). The API half catches contract breaks the UI would hide (a 503 where a
409 belongs, a missing rate limit).

**Read `apps/api/CLAUDE.md` and `apps/web/CLAUDE.md` before interpreting a
failure** — several "bugs" this suite can surface are documented, deliberate
behaviour (org routes 404 rather than 403 when the flag is off; "Request an
update" on `/profile` has no backend behind it yet).

## Ground rules

- **Never edit a tracked file or a `.env` to make the run work.** Everything is
  configured with inline env vars. A test run must leave the working tree clean.
- **Tag every seeded row** with `$E2E_TAG` and clean up at the end. A half-cleaned
  DB makes the _next_ run lie.
- **Report what happened, including skips.** A flow that could not run is a SKIP,
  never a PASS. If a precondition failed, say which.
- **One restart is a fix; a retry loop is a lie.** The nginx `/auth` 502 has a
  documented cause and one restart clears it. Anything else that needs retrying
  is a finding — report it.

## Phase 0 — preflight

```bash
source .claude/skills/aggregator-e2e/lib/e2e-helpers.sh
echo "tag=$E2E_TAG  network=$NETWORK  base=$BASE_URL"
docker info >/dev/null 2>&1 && echo "docker OK" || echo "docker DOWN"
lsof -tiTCP:8080 -sTCP:LISTEN >/dev/null 2>&1 && echo "NOTE: something already owns :8080" || true
_ROOT=$(git rev-parse --show-toplevel); B="$_ROOT/.claude/skills/gstack/browse/dist/browse"
[ -x "$B" ] || B=~/.claude/skills/gstack/browse/dist/browse
[ -x "$B" ] && echo "browse OK: $B" || echo "browse MISSING — run /connect-chrome once to build it"
```

If Docker is down, **stop and ask the user to start it** (`! open -a Docker`).
Don't try to work around it.

## Phase 1 — launch

```bash
stack_up          # dev overlay (mailpit, host ports)
wait_for_stack    # blocks on health/ready, then prints the dependency table
mail_clear        # a clean inbox makes "the newest mail" unambiguous
```

`stack_up` runs `pnpm stack:up`, which is `docker compose -f docker-compose.yml -f
docker-compose.dev.yml --profile storage up -d --build`. Three things that matters for:

- **The dev overlay is what makes mail testable.** It points the api, the worker
  _and_ Keycloak at `mailpit:1025`, so OTP codes and approval links land in
  mailpit (`http://localhost:8025`) instead of trying real SMTP. Without it the
  api falls back to whatever `SMTP_HOST` is in `apps/api/.env` — commonly a real
  Gmail host, which fails auth and makes the login/approval flows untestable.
- **Onboarding is by invite only.** There is no public sign-up: an owner invites
  (`/v1/user/invite`, `/v1/org/invite`), the invitee registers from the link and
  becomes active after signing in with the emailed code (`/v1/user/activate`).
- **`--build` is required, not optional.** `NEXT_PUBLIC_*` is baked into the web
  image at build time.

Confirm from `wait_for_stack` that `config network` equals `$NETWORK`. If it
prints something else, the api is reading a stale `AGGREGATOR_CONFIG_PATH` —
stop and fix that before trusting any result.

## Phase 2 — API suite

Anonymous and public surfaces first; they need no token.

```bash
ok "health/live"            "$(code $API_URL/health/live)" 200
ok "health/ready"           "$(code $API_URL/health/ready)" 200
ok "aggregator-config"      "$(code $API_URL/v1/aggregator-config)" 200
ok "support/config authed"  "$(code $API_URL/v1/support/config)" 401
ok "dashboard needs auth"   "$(code $API_URL/v1/dashboard/items)" 401
ok "org routes registered"  "$(code $API_URL/v1/org/hierarchy)" 401
ok "unknown route 404"      "$(code $API_URL/v1/nope)" 404
```

Then the invite contract. Accept is service-authed, so drive it through the web
BFF (`/api/invite/user/accept`, `/api/invite/org/accept`), which attaches the
service token. Mint an invite as an owner first (Phase 3, flow 2) and take the
`invite=` token from the mail in mailpit.

**Negatives that have each been a real bug — keep them:**

| Case                                                                  | Expect                                              | Why it matters                                                                                                                                                       |
| --------------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Same invite, 5 **concurrent** accepts, invited email, distinct phones | exactly one 201, rest `409 INVITE_ALREADY_USED`     | The invite is the only volume bound on a forwarded link. Fire them with `&` + `wait`, not sequentially — sequential accepts only prove the row is no longer pending. |
| Duplicate **phone** on an accept                                      | `409 PHONE_EXISTS` **and** invite back to `pending` | An ordinary user error must not burn a one-time link. Check the row, not just the status code.                                                                       |
| Accept with **another** email than the invited one                    | `400 INVITE_EMAIL_MISMATCH`, invite still `pending` | The invited address is what the email code proves.                                                                                                                   |
| Activate before verifying the email                                   | `403 EMAIL_NOT_VERIFIED`, account still `pending`   | Only the emailed code proves the address.                                                                                                                            |

Verify the invite side-effects in the DB, not just the response:

```bash
psql_q "SELECT status, consumed_at IS NULL FROM registration_invites WHERE jti='$JTI';"
psql_q "SELECT count(*) FROM users WHERE user_type='coordinator' AND org_id='$ORG_ID';"
```

Remaining API groups, same shape — assert status **and** the persisted effect:
`/v1/links/create` + activate/deactivate + `/public/v1/aggregators/:orgSlug/links/:slug`

- `/public/v1/aggregators/:orgSlug/registrations/:slug` (public submit);
  `/v1/bulk-uploads` (presign) → `/start` → poll `/v1/bulk-uploads/:id` →
  `/v1/bulk-uploads/:id/errors.csv`; `/v1/support/config` + `/v1/support`;
  `/v1/campaign/{export,voice,email}` + job poll;
  `/v1/dashboard/items` incl. `?lifecycle=` and `meta.tiles`;
  `/v1/user/invite` + `/v1/org/invite` (owner token; out-of-reach org → 404).

## Phase 3 — UI suite

```bash
$B connect          # visible Chromium; the user watches every step
$B goto "$BASE_URL"
```

Drive with `$B snapshot -i` → act on `@eN` refs → assert with `$B text`. Take
`$B screenshot` at each terminal state; those are the artifacts worth keeping
when something fails.

**Flow order matters — later flows need earlier ones:**

1. **Invite an organisation** — sign in as the network admin → Onboarded
   Organisations → Invite organisations → invite mail in mailpit → open the
   link in a fresh context → register → sign in with the emailed code → the org
   is `active` and its owner lands in the console.
2. **Invite a user** — as that owner, My Team → Invite users → mail → register
   from the link → emailed code → the user is `active` and listed in My Team.
3. **Waiting states** — an invite not opened yet and a registration not verified
   yet both show as **Invited** in My Team and Onboarded Organisations.
4. **Broken links** — an expired, a used and a tampered link each show their
   message instead of the form; `/register` without an invite says invite only.
5. **OTP login** — `/login`, email → Keycloak mails a 6-digit code to mailpit →
   `mail_extract_otp` → enter → lands on `/dashboard`.
6. **Dashboard + profile** — tiles, lifecycle filters, export; `/profile` renders
   the same `registration.v1` schema **read-only** (every field disabled).
7. **Registration links** — `/onboarding/links`: create, QR renders (derived
   client-side, no S3), activate/deactivate, then open the public link in a
   fresh context and submit a participant.
8. **Bulk upload** — `/onboarding/bulk-uploads`: download the template in **both**
   formats (`?format=xlsx` and the CSV default — the shipped
   `config/$NETWORK/bulk-samples/*.csv` were deleted in #564; both are now
   generated from the live schema), fill a couple of rows from the workbook's
   "3. Sample data" tab, save as CSV, upload it → watch the worker process it →
   row counts land → download `errors.csv`. Then upload a deliberately broken CSV
   (missing a required column, and a file with **blank optional cells and >20
   rows** — the shape that used to trip PapaParse header re-derivation) and
   confirm the failures are reported per row rather than as a whole-file 500.
9. **Contact support** — visible in the sidebar only when the api reports
   `SUPPORT_EMAIL` configured; submit with an attachment, assert mail in mailpit.
   If unset, that's a **SKIP with the reason**, not a failure.

### UI gotchas that will otherwise eat the run

- **The consent modal is scroll-gated (#636).** The accept checkbox stays
  `[disabled]` until each document has been scrolled to its end, so a plain
  `click` on it silently does nothing. Scroll the inner scroll region first:
  ```bash
  $B js '(() => { const s = Array.from(document.querySelectorAll("section")).find(e => e.scrollHeight > e.clientHeight + 20); if (!s) return "none"; s.scrollTop = s.scrollHeight; s.dispatchEvent(new Event("scroll",{bubbles:true})); return s.scrollTop; })()'
  ```
  Then tick the checkbox, then "Accept & continue". Check both tabs (Privacy and
  Terms) if the tracker still shows one unread.
- **Submit starts `[disabled]`.** Fill every `*` field before asserting on it;
  a disabled button is not a bug report.
- **An already-used invite still renders the whole form.** Enforcement is at
  submit, not on the landing. Expected today — the user fills the form before
  being told. Worth flagging as UX, not as a test failure.
- **`403 MISSING_AGGREGATOR_ID` on `/profile` is a setup gap, not a code bug.**
  The `aggregator_id` + `phone_number` protocol mappers must be added by hand
  after a fresh realm import (`SETUP.md` §5). Report it as a SKIP with that
  pointer.
- **Login bouncing after the OTP** means the Keycloak client's valid redirect
  URIs don't include the origin you're serving from. In docker-only mode
  (`https://localhost`) this is already correct; it bites on `:3000`.

## Phase 4 — report and clean up

```bash
e2e_report      # prints the PASS/FAIL/SKIP table; non-zero exit if anything failed
e2e_cleanup     # deletes every row tagged $E2E_TAG + any generated seed script
git status --porcelain   # MUST be clean; if not, you changed a tracked file — revert it
```

Then summarise for the user: what passed, every failure with the actual vs
expected and the screenshot path, and every skip **with its reason**. Do not
describe a flow as covered if it was skipped.

Leave the stack up unless asked to tear it down (`pnpm stack:down`, or
`stack:reset` to also drop volumes — that destroys data). `$B disconnect` closes
the browser.

## Extending this

When you add a flow to the app, add it here in both halves. When a bug escapes to
review, add the negative case that would have caught it — the table in Phase 2 is
a list of bugs that actually shipped, which is what makes it worth running.
