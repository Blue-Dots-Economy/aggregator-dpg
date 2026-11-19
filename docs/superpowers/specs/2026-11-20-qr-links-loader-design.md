# QR links per coordinator: design

**Issue:** #1119, part of the instance speed-run (bluedots-infra-deployments#146)
**Branch:** side branch `hotfix/up-speedrun` only (see `2026-11-19-org-structure-loader-design.md`, "Where the code lives"). It is built on #1122 (two-option form), which must be carried into `hotfix/up-speedrun` first.
**Date:** 2026-11-20
**Status:** approved 2026-11-20

## Why

Coordinators loaded by the org loader (#1118) have never logged in, so they can't create their own QR links. Our team creates one live link per coordinator and profile type from a sheet, and hands product the URLs and QR images to share. Each link opens the two-option form (talk to the voice bot, or register / sign in).

## Goals

- An operator command in the API image that reads a links sheet on stdin and creates live links on each coordinator's behalf, using the two-option mode.
- `check` writes nothing and lists every problem with its row number. `apply` refuses on any problem. A rerun is safe.
- A CSV of the created links on stdout.
- A local script that turns that CSV into one QR PNG per link.

## Non-goals

- Editing, re-pointing or retiring links. The portal already does that once coordinators log in.
- Emails, or anything a participant sees beyond the existing two-option form.
- Recording the operator on the link row (see "Who created it").

## Anti-goals

- A second copy of the link-creation rules that drifts from the portal's.
- Any file with personal data written inside the pod.
- Creating duplicate links on a rerun.

## Approaches

| | Approach | Trade-off |
|---|---|---|
| **A (chosen)** | The pod command prints the link CSV to stdout, as the other speed-run tools do. A local script, run from a repo checkout on the operator's laptop, turns the CSV into PNGs. | Every pod tool works the same way and the API image needs no new dependency. Costs one extra local step. |
| B | The pod command writes a ZIP (CSV plus PNGs) to stdout. | One step, but it adds a zip library to the API image, and binary output over `kubectl exec` is easier to corrupt. |

Aniket picked A.

## Design

### Shared service (refactor, no route change)

Move the create step of `POST /v1/links/create` (`apps/api/src/routes/registration-links.ts`) into `apps/api/src/services/registration-links/create.ts`. That covers:
- mode validation against `registration_modes` and `AGGREGATOR_ONBOARDING_ENABLED`;
- the served-domain check;
- the voice-bot key resolution added by #1122;
- slug choice with collision retry;
- the insert;
- going live.

The route and the command both call it. The route keeps its auth (`requireApproved`), maps errors to the same HTTP responses, and its existing tests pass unchanged.

### Command

`node dist/tools/qr-links.js check|apply --links - --operator <name>`, run through `kubectl exec -i … -c api`. It follows the org loader's pattern:
- stdin only;
- logs to stderr (`LOG_DESTINATION`);
- exit codes 0 ok, 1 refused or failed, 2 usage;
- timeouts from config.

**Input columns:**
- `coordinator_email` (required);
- `profile_type` (required);
- `voice_bot` (optional when the domain has one bot or a default);
- `link_name` (optional, becomes the slug);
- `expires_on` (optional, `YYYY-MM-DD`, must be in the future).

The same CSV reader rules as the org loader apply: trim, `,` delimiter, line numbers kept, malformed rows reported.

**`check` problems:**
- unknown coordinator;
- coordinator not `active` or with no Signals org;
- profile type not served;
- unknown voice bot, or one not serving that profile type;
- invalid `link_name` (must be the same slug pattern as the route);
- expiry in the past or unparseable;
- duplicate rows in the file (same coordinator, type and name).

**`apply`:**
- creates a live link in mode `voice_or_form` (the mode key comes from the instance config, so it is checked, not hardcoded) for each row, through the shared service;
- `created_by` is the coordinator's id; the column is a required user id. The operator goes in the logs and the report. This is the same call as #1124;
- stops at the first failure.

**Rerun:** a row is `already_loaded` when that coordinator already has a live link with the same profile type and, if given, the same `link_name` slug. Nothing is created and the existing URL is reported. Without a `link_name`, an existing live `voice_or_form` link for that coordinator and type counts as already loaded.

**Report (stdout CSV):** `line`, `coordinator_email`, `profile_type`, `voice_bot`, `slug`, `url`, `outcome` (`created` / `already_loaded` / `failed` / `not_run`), `error_code`. The URL is built the same way the route builds `public_url`.

### Local QR script

`apps/api/scripts/qr-images.ts`, run from a checkout:

```
pnpm --filter @aggregator-dpg/api exec tsx scripts/qr-images.ts --in links.csv --out qr/
```

- It reads the report CSV and writes one PNG per row with outcome `created` or `already_loaded`, named `<coordinator email local part>-<profile_type>[-<slug>].png`, made filesystem-safe.
- It uses the same `qrcode` options as the portal's download (`RegistrationLinksSection.tsx`), so images match.
- `qrcode` becomes a dev dependency of `apps/api`, not shipped in the image.
- It never contacts the server.

### Runbook

`docs/qr-links-runbook.md`:
- the sheet template;
- `check`, then `apply`, through `kubectl exec -i`;
- the local PNG step;
- hand-over to product;
- delete local files;
- the rerun rules;
- the message table.

## Constraints

- The command needs the full API environment and runs only inside the API pod.
- The two-option mode and voice-bot config come from #1122. On instances with `voice_bots: []` the links still create, and show register / sign in only.

## Left to the builder

- Exact module names, CSV column order, and whether the reader shares code with the org loader's parser (preferred, if it doesn't twist that parser).
