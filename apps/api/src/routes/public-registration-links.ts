/**
 * Public registration link endpoints.
 *
 *   GET  /public/v1/aggregators/:orgSlug/links/:slug
 *     Anonymous resolve. Returns the public-safe shape of a live link so a
 *     BFF can render the registration form. 404 for missing or draft slugs;
 *     410 for retired or expired ones.
 *
 *   POST /public/v1/aggregators/:orgSlug/registrations/:slug
 *     Anonymous synchronous submit. Validates the body against the active
 *     participant schema for the link's domain, normalises phone+email,
 *     creates the participant + a link_submission row, and returns the
 *     submission id.
 *
 * Security model: (org_slug, slug) pair is the access token. No JWT
 * required. Aggregator scoping is implicit via the link row.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { PostgresParticipantsWriter } from '@aggregator-dpg/participants-writer/postgres';
import type { ParticipantsWriterBase } from '@aggregator-dpg/participants-writer/interface';
import { getRegistrationLinksStore } from '../services/registration-links-store/index.js';
import type { RegistrationLink } from '../services/registration-links-store/index.js';
import { getAggregatorStore } from '../services/aggregator-store/index.js';
import { getNetworkConfig } from '../services/network-config.js';
import { getSchemaLoader } from '../services/schema-loader/index.js';
import { normalisePhone } from '../services/phone.js';
import { resolveLifecycle } from '../services/onboarding/lifecycle.js';
import {
  planCompletionDispatch,
  type CompletionAction,
} from '../services/onboarding/dispatch_completion.js';
import { getOutboundDispatchLog } from '../services/outbound-dispatch-log/index.js';
import { getOutboundDispatchQueue } from '../services/queue.js';
import { OUTBOUND_DISPATCH_QUEUE } from '@aggregator-dpg/queue';
import { getSignalStackWriter } from '../services/signalstack.js';
import { getDb } from '../db/client.js';
import { linkSubmissions } from '../db/schema.js';
import { httpError } from '../errors/http-error.js';
import { consume } from '../services/rate-limiter/index.js';
import { config } from '../config.js';
import type { SignalStackOnboardParticipantResult } from '@aggregator-dpg/signalstack-writer/interface';

let participantsWriter: ParticipantsWriterBase | null = null;
function getParticipantsWriter(): ParticipantsWriterBase {
  if (participantsWriter) return participantsWriter;
  participantsWriter = new PostgresParticipantsWriter(getDb());
  return participantsWriter;
}

/** Test helper — override the writer (e.g., inject a fake). */
export function _setParticipantsWriter(w: ParticipantsWriterBase | null): void {
  participantsWriter = w;
}

interface OrgSlugParams {
  orgSlug?: string;
  slug?: string;
}

export async function registerPublicRegistrationLinkRoutes(app: FastifyInstance): Promise<void> {
  app.get('/public/v1/aggregators/:orgSlug/links/:slug', async (req, reply) => {
    const { orgSlug, slug } = req.params as OrgSlugParams;
    if (!orgSlug || !slug) {
      throw httpError('SCHEMA_VALIDATION', { detail: 'orgSlug and slug are required.' });
    }
    const log = req.log.child({ operation: 'public.linkResolve', org_slug: orgSlug, slug });
    const start = Date.now();

    const link = await loadLiveLinkByOrgAndSlug(orgSlug, slug, log);

    // Pull the link domain's JSON Schema from the live network config so
    // the public registration page can render the form without a
    // separate fetch (and without hardcoding any seeker/provider
    // assumption). Networks that omit the domain return 404 — the link
    // points at a no-longer-declared domain.
    const networkCfg = await getNetworkConfig();
    const linkDomainCfg = networkCfg.domains[link.domain];
    if (!linkDomainCfg) {
      throw httpError('NOT_FOUND', {
        detail: `link domain '${link.domain}' not declared in network ${networkCfg.network.id}`,
      });
    }

    log.info({
      status: 'success',
      latency_ms: Date.now() - start,
      link_id: link.id,
      domain: link.domain,
    });

    // Per-link submission_mode locks the form shape:
    //   - 'account_and_profile' (default): identity + full profile schema.
    //   - 'account_only': identity only — `schema` is nulled so the client
    //     never accidentally renders a profile form for this link.
    const accountOnly = link.submissionMode === 'account_only';

    return reply.send({
      slug: link.slug,
      // Active network id (e.g. 'blue_dot' / 'orange_dot'). The BFF needs
      // it alongside the domain to call /lookup, which scopes the probe
      // to the right signalstack network.
      network: networkCfg.network.id,
      domain: link.domain,
      context: link.context,
      submission_mode: link.submissionMode,
      schema_id: accountOnly ? null : `participant-${link.domain}`,
      schema_version: accountOnly ? null : 'v1',
      schema: accountOnly ? null : linkDomainCfg.schema,
      // Identity field selectors (name / phone / email) for this domain.
      // The public form needs them to relax required-field validation when
      // the user opts into "submit identity now, complete later": account-only
      // submits create no item, so only the identity fields signalstack needs
      // (a name + at least one contact) stay mandatory.
      identity: linkDomainCfg.identity,
      expires_at: link.expiresAt ? link.expiresAt.toISOString() : null,
    });
  });

  app.post('/public/v1/aggregators/:orgSlug/registrations/:slug', async (req, reply) => {
    const { orgSlug, slug } = req.params as OrgSlugParams;
    if (!orgSlug || !slug) {
      throw httpError('SCHEMA_VALIDATION', { detail: 'orgSlug and slug are required.' });
    }
    const log = req.log.child({
      operation: 'public.registrationSubmit',
      org_slug: orgSlug,
      slug,
    });
    const start = Date.now();

    // Rate limit by (orgSlug, slug, ip). CAPTCHA enforcement is handled at
    // the BFF layer (Cloudflare Turnstile) — the API layer keeps a coarse
    // fallback so a misconfigured BFF can't expose unbounded write traffic.
    const ip = (req.ip ?? '0.0.0.0').toString();
    const rate = await consume({
      namespace: 'link-submit',
      key: `${orgSlug}:${slug}:${ip}`,
      windowSeconds: config.PUBLIC_SUBMIT_RATE_WINDOW_SECONDS,
      max: config.PUBLIC_SUBMIT_RATE_MAX_PER_WINDOW,
    });
    if (!rate.allowed) {
      void reply.header('Retry-After', String(rate.retryAfterSeconds));
      log.warn({ status: 'rate_limited', count: rate.count, ip });
      throw httpError('RATE_LIMITED', {
        detail: `Retry in ${rate.retryAfterSeconds}s.`,
      });
    }

    const link = await loadLiveLinkByOrgAndSlug(orgSlug, slug, log);

    const rawBody = (req.body ?? {}) as Record<string, unknown>;

    // Identity selectors live in the network config; load them up front so
    // both the account_only allowed-key guard and the downstream normaliser
    // share one source of truth.
    const networkCfgEarly = await getNetworkConfig();
    const linkDomainCfgEarly = networkCfgEarly.domains[link.domain];
    if (!linkDomainCfgEarly) {
      throw httpError('NOT_FOUND', {
        detail: `link domain '${link.domain}' not declared in network ${networkCfgEarly.network.id}`,
      });
    }

    // `account_only` links lock the form shape: identity fields only, no
    // profile payload, no schema render. Reject any item_state or stray
    // top-level key BEFORE we touch the Ajv path. The `partial` flag is
    // accepted but ignored (forced true / submit_mode=account_only
    // regardless of value). Allowed identity field names come from the
    // network config so the rule stays generic across signalstack networks
    // (blue_dot uses `phone`, purple_dot uses `mobile_number`, etc.). Server
    // enforcement only — the web form already renders just identity fields
    // when mode=account_only, but trusting the client would let a tampered
    // submit bypass the capture-scope intent.
    if (link.submissionMode === 'account_only') {
      const allowed = new Set<string>([
        'consent_terms',
        'consent_privacy',
        'partial',
        ...[
          linkDomainCfgEarly.identity.name,
          linkDomainCfgEarly.identity.phone,
          linkDomainCfgEarly.identity.email,
        ].filter((k): k is string => typeof k === 'string' && k.length > 0),
      ]);
      for (const key of Object.keys(rawBody)) {
        if (!allowed.has(key)) {
          throw httpError('SUBMISSION_MODE_MISMATCH', {
            detail: `account_only link does not accept field '${key}'`,
            fields: { rejected_key: key },
          });
        }
      }
      // Identity-presence guard: name AND (phone OR email) must be present.
      // Without this we'd defer to signalstack-writer.onboard's guardInput
      // which 502s — wrong status code for a client-side missing-field.
      const nameKey = linkDomainCfgEarly.identity.name;
      const phoneKey = linkDomainCfgEarly.identity.phone;
      const emailKey = linkDomainCfgEarly.identity.email;
      const hasName =
        nameKey && typeof rawBody[nameKey] === 'string' && (rawBody[nameKey] as string).length > 0;
      const hasPhone =
        phoneKey &&
        typeof rawBody[phoneKey] === 'string' &&
        (rawBody[phoneKey] as string).length > 0;
      const hasEmail =
        emailKey &&
        typeof rawBody[emailKey] === 'string' &&
        (rawBody[emailKey] as string).length > 0;
      if (!hasName || (!hasPhone && !hasEmail)) {
        throw httpError('SCHEMA_VALIDATION', {
          detail: 'account_only requires name and at least one of phone or email',
          fields: {
            missing: [
              ...(!hasName ? [nameKey ?? 'name'] : []),
              ...(!hasPhone && !hasEmail ? ['phone_or_email'] : []),
            ],
          },
        });
      }
    }

    // Pull the lifecycle hint off the envelope BEFORE Ajv runs against the
    // domain schema (which would reject the unknown top-level field).
    // `partial: true` flips signals' lifecycle path to `account_only` —
    // signals creates the user row only, no item, and the response carries
    // no lifecycle fields. v1 surfaces the toggle explicitly; we
    // deliberately do not infer it from "body contains only identity
    // fields" because implicit detection is brittle when schemas evolve.
    // For `account_only` links the link itself forces this — the body
    // flag is meaningless because the route never accepts item_state.
    const partial = link.submissionMode === 'account_only' || rawBody['partial'] === true;
    const body: Record<string, unknown> = { ...rawBody };
    delete body['partial'];
    const submitMode: 'with_item' | 'account_only' = partial ? 'account_only' : 'with_item';

    // Identity selectors come from the resolved network config so the
    // route stays generic across signalstack networks. The sniffer
    // picks them up from the schema; aggregator.config.yaml overrides
    // when needed. Loaded up front so `account_only` validation can keep
    // just the identity fields required (see below).
    const networkCfg = await getNetworkConfig();
    const linkDomainCfg = networkCfg.domains[link.domain];
    if (!linkDomainCfg) {
      throw httpError('NOT_FOUND', {
        detail: `link domain '${link.domain}' not declared in network ${networkCfg.network.id}`,
      });
    }
    const phoneSourceKey = linkDomainCfg.identity.phone;

    // 1. Schema validation against the link's domain schema. Skipped for
    // `account_only` links — the upstream identity-presence guard already
    // enforced shape (name + phone OR email + consent), no profile fields
    // are written, and running Ajv would mis-flag the consent toggles as
    // `additionalProperties` violations against the profile schema.
    if (link.submissionMode !== 'account_only') {
      // Load the raw schema as well so we can strip empty-string optional
      // fields before Ajv runs — an empty cell for an optional
      // `format: uri` / `format: email` field would otherwise trip the
      // format check even though the field was never required.
      const schemaRef = { id: `participant-${link.domain}`, version: 'v1' };
      const loader = getSchemaLoader();
      const [validatorResult, schemaResult] = await Promise.all([
        loader.getValidator(schemaRef),
        loader.getSchema(schemaRef),
      ]);
      if (!validatorResult.success) {
        log.error({ status: 'failure', sub: 'schema.load', error: validatorResult.error.code });
        throw httpError('INTERNAL', {
          detail: 'Registration schema unavailable.',
          cause: new Error(validatorResult.error.message),
        });
      }
      if (schemaResult.success) {
        stripEmptyOptionalCells(body, schemaResult.value as Record<string, unknown>);
      }
      const validate = validatorResult.value;
      if (!validate(body)) {
        let issues = validate.errors ?? [];
        // `partial: true` (per-submit account_only opt-in on full links)
        // creates no item — profile fields aren't written, so their
        // constraints don't apply. Keep only errors on the identity
        // selectors (name + at least one contact, which signalstack needs
        // for the user row) and `additionalProperties` (unknown top-level
        // keys still rejected). The client seeds array fields with `[]`,
        // so without this an optional `minItems: 1` field would block a
        // bare identity submission.
        if (partial) {
          const identityKeys = new Set(
            [
              linkDomainCfg.identity.name,
              linkDomainCfg.identity.phone,
              linkDomainCfg.identity.email,
            ].filter((k): k is string => typeof k === 'string' && k.length > 0),
          );
          issues = issues.filter((e) => {
            if (e.keyword === 'additionalProperties') return true;
            const field =
              e.keyword === 'required'
                ? ((e.params as { missingProperty?: string })?.missingProperty ?? '')
                : (e.instancePath ?? '').split('/')[1] || '';
            return identityKeys.has(field);
          });
        }
        if (issues.length > 0) {
          throw httpError('SCHEMA_VALIDATION', {
            detail: 'Submission failed schema validation.',
            fields: { issues },
          });
        }
      }
    }

    // 2. Normalisation. The server discards any client-supplied
    // `participant_id` (anonymous caller probing prevention) and derives the
    // dedup key from the normalised phone — same person re-submitting the
    // form hits the wrapper's ON CONFLICT path and returns outcome='skipped'.
    // Falls back to a fresh UUID when phone is absent so dedup degrades
    // gracefully for phone-optional schemas (no dedup, but still works).
    delete (body as Record<string, unknown>)['participant_id'];
    const emailSourceKey = linkDomainCfg.identity.email;
    const phoneRaw =
      typeof body[phoneSourceKey] === 'string' ? (body[phoneSourceKey] as string) : '';
    let phoneNormalised: string | null = null;
    if (phoneRaw) {
      const phone = normalisePhone(phoneRaw);
      if (!phone.ok) {
        throw httpError('INVALID_PHONE', { detail: phone.error.message });
      }
      phoneNormalised = phone.value;
    }
    // Email is optional in IdentitySelectors
    // override is undefined; dedup falls back to phone-only.
    const emailRaw =
      emailSourceKey && typeof body[emailSourceKey] === 'string'
        ? (body[emailSourceKey] as string)
        : '';
    const emailNormalised = emailRaw ? emailRaw.trim().toLowerCase() : null;
    const participantId = phoneNormalised ?? randomUUID();

    // 2a. Resolve the aggregator's signalstack org id BEFORE opening the
    // transaction. Anonymous submitters carry no token, so the value must
    // come from `aggregators.signalstack_org_id` (written at approval time
    // or by the login-time backfill in `requireApproved`). A NULL here means
    // the aggregator never completed the signalstack handshake — fail fast
    // with 503 so the participant retries rather than landing a half-pushed
    // row.
    const ss = getSignalStackWriter();
    let signalstackOrgId: string | null = null;
    if (ss) {
      const aggLookup = await getAggregatorStore().findById(link.aggregatorId);
      if (!aggLookup.ok) {
        throw httpError('DB_UNAVAILABLE', {
          fields: { sub_operation: 'aggregatorStore.findById' },
        });
      }
      if (!aggLookup.value) {
        throw httpError('NOT_FOUND', { detail: 'Aggregator missing for live link.' });
      }
      signalstackOrgId = aggLookup.value.signalstackOrgId;
      if (!signalstackOrgId) {
        throw httpError('SIGNALSTACK_ORG_NOT_REGISTERED', {
          fields: { aggregator_id: link.aggregatorId, link_id: link.id },
        });
      }
    }

    // 3 + 4. participant UPSERT (via shared writer), link_submission INSERT,
    // AND signalstack push must all commit atomically. A signalstack failure
    // rolls back the local rows so the caller sees a single, honest outcome:
    // a 2xx response means the participant exists in both stores. Tightens
    // the DB connection hold time — acceptable for a public-link form submit
    // (low volume). If push volume ever requires async fan-out, switch to an
    // outbox table inside the tx + worker consumer.
    // Lifecycle fields hoisted out of the tx scope so the response path can
    // surface them without re-reading the signals response. `null` is the
    // honest default: signals is disabled (no push) OR the submit was
    // account_only — neither produces a lifecycle classification.
    let lifecycleStatusOut: 'draft' | 'live' | 'paused' | null = null;
    let completionPctOut: number | null = null;
    let ownedElsewhere = false;
    // Capture the raw signals onboard result outside the tx so the
    // dispatcher fan-out (Task 11) can hand it to the planner without
    // re-running onboard. `null` means signalstack was disabled OR push
    // was skipped — the planner short-circuits on the empty actions list
    // anyway, but we still gate on the result to keep the read crisp.
    let onboardResultOut: SignalStackOnboardParticipantResult | null = null;
    const writer = getParticipantsWriter();
    const txResult = await getDb().transaction(async (tx) => {
      // Bind the writer to the active tx for atomicity. If a custom writer
      // (test fake) was injected via _setParticipantsWriter, use it directly.
      type DbCtor = ConstructorParameters<typeof PostgresParticipantsWriter>[0];
      const txWriter: ParticipantsWriterBase =
        writer instanceof PostgresParticipantsWriter
          ? new PostgresParticipantsWriter(tx as unknown as DbCtor)
          : writer;

      const writeResult = await txWriter.writeLinkSubmission({
        aggregatorId: link.aggregatorId,
        type: link.domain,
        participantId,
        data: body,
        phone: phoneNormalised,
        email: emailNormalised,
        sourceLinkId: link.id,
      });

      if (!writeResult.success) {
        // Bubble DB failure to fastify so the request returns 500.
        throw new Error(writeResult.error.message);
      }
      const { outcome: writeOutcome, participant } = writeResult.value;
      let outcome: 'passed' | 'skipped' = writeOutcome;
      const participantRowId = participant.id;

      const submission = await tx
        .insert(linkSubmissions)
        .values({
          linkId: link.id,
          aggregatorId: link.aggregatorId,
          participantId: participantRowId,
          metadataSnapshot: link.context,
          submittedData: body,
          outcome,
        })
        .returning({ id: linkSubmissions.id });

      // Outward signalstack push, inside the same tx so a downstream failure
      // rolls the local rows back. Local participant table is deduped per
      // (aggregator_id, type, participant_id); signalstack is the global
      // identity store and must also see the row, otherwise the dashboard
      // and downstream consumers are out of sync.
      if (ss && signalstackOrgId) {
        const nameSourceKey = linkDomainCfg.identity.name;
        const name =
          typeof body[nameSourceKey] === 'string'
            ? (body[nameSourceKey] as string)
            : participantRowId;
        const phoneFromBody =
          typeof body[phoneSourceKey] === 'string'
            ? (body[phoneSourceKey] as string)
            : phoneNormalised;
        const pushPhone = phoneNormalised ?? phoneFromBody;
        const result = await ss.onboard({
          actingOrgId: signalstackOrgId,
          name,
          ...(pushPhone ? { phoneNumber: pushPhone } : {}),
          ...(emailNormalised ? { email: emailNormalised } : {}),
          terms_accepted: networkCfg.aggregator.onboarding.presume_consent,
          privacy_accepted: networkCfg.aggregator.onboarding.presume_consent,
          channel: 'link',
          source_id: link.id,
          network: config.SIGNALSTACK_ITEM_NETWORK,
          domain: link.domain,
          item_type: linkDomainCfg.itemType,
          profile: buildSignalStackItemState(link.domain, body, pushPhone, linkDomainCfg),
          submit_mode: submitMode,
        });

        if (!result.success) {
          log.error({
            status: 'failure',
            sub: 'signalstack.push',
            error: result.error.message,
            code: result.error.code,
            link_id: link.id,
            participant_id: participantRowId,
          });
          throw httpError('SIGNALSTACK_PUSH_FAILED', {
            detail: `Signalstack rejected the participant push (${result.error.code}).`,
            fields: { code: result.error.code, message: result.error.message },
            cause: result.error,
          });
        }

        // Cross-org existing user → signalstack has the person under a
        // different aggregator and won't expose/duplicate them here.
        // Record a skipped outcome so the form shows the friendly
        // "already registered" screen instead of a hard failure.
        // `already_registered` (legacy) and `owned_elsewhere` (Task 4 rename)
        // carry the same signal during the transition — OR them together so
        // either field flips the outcome.
        const isExisting =
          Boolean(result.value.already_registered) || Boolean(result.value.owned_elsewhere);
        if (isExisting) {
          outcome = 'skipped';
        }

        // Resolve lifecycle through the back-compat helper so the absent →
        // 'live' rule stays centralised. `account_only` submits produce no
        // item, so we suppress lifecycle fields entirely (null) — the
        // resolver would otherwise return 'live' for an absent column.
        const lifecycleStatus =
          submitMode === 'account_only' || !result.value.profile_item_id
            ? null
            : resolveLifecycle({
                ...(result.value.lifecycle_status
                  ? { lifecycle_status: result.value.lifecycle_status }
                  : {}),
              });
        const completionPct =
          submitMode === 'account_only' || !result.value.profile_item_id
            ? null
            : (result.value.completion_pct ?? null);
        ownedElsewhere = Boolean(result.value.owned_elsewhere);
        lifecycleStatusOut = lifecycleStatus;
        completionPctOut = completionPct;
        onboardResultOut = result.value;

        log.info({
          status: 'success',
          sub: 'signalstack.push',
          user_id: result.value.user_id,
          profile_item_id: result.value.profile_item_id,
          onboarded_at: result.value.onboarded_at,
          already_registered: result.value.already_registered ?? false,
          owned_elsewhere: ownedElsewhere,
          lifecycle_status: lifecycleStatus,
          completion_pct: completionPct,
          submit_mode: submitMode,
          link_id: link.id,
          participant_id: participantRowId,
        });
      }

      return {
        outcome,
        participantRowId,
        submissionId: submission[0]?.id,
      };
    });
    const { outcome, participantRowId, submissionId } = txResult;

    // Dispatcher fan-out — runs OUTSIDE the participant transaction so a
    // Redis hiccup or a per-row enqueue failure cannot roll back the
    // already-committed participant + link_submission rows. The planner
    // is pure; it short-circuits to `[]` on owned_elsewhere, already-
    // registered, missing item, empty actions, or non-draft lifecycle —
    // we still call it so the gating logic lives in one place.
    //
    // `account_only` links never enqueue. Belt-and-braces: the T8 admin
    // guard already prevents completion_actions on account_only links
    // (so the array would be empty and the planner would short-circuit
    // to `[]`), but the design pins this as an explicit per-mode behaviour
    // — surface the skip in code so a future regression can't sneak in.
    if (
      link.submissionMode !== 'account_only' &&
      onboardResultOut &&
      link.completionActions.length > 0
    ) {
      const directives = planCompletionDispatch({
        onboardResult: onboardResultOut,
        actions: link.completionActions as CompletionAction[],
        participantId: participantRowId,
        aggregatorId: link.aggregatorId,
      });
      const dispatchLog = getOutboundDispatchLog();
      const dispatchQueue = getOutboundDispatchQueue();
      for (const directive of directives) {
        const enqueueStart = Date.now();
        const enqueued = await dispatchLog.enqueue({
          aggregator_id: directive.aggregator_id,
          participant_id: directive.participant_id,
          item_id: directive.item_id,
          channel: directive.channel,
          template_id: directive.template_id,
          payload: {
            delay_seconds: directive.delay_seconds,
            max_retries: directive.max_retries,
          },
        });
        if (!enqueued.success) {
          // A persistence failure does not block the user's submit
          // response. Log and continue with the next directive — the
          // composite-key uniqueness guarantees a retry on the next
          // submit attempt is safe.
          log.error({
            operation: 'outboundDispatch.enqueue',
            status: 'failure',
            error: enqueued.error.message,
            error_type: enqueued.error.constructor.name,
            latency_ms: Date.now() - enqueueStart,
            participant_id: directive.participant_id,
            item_id: directive.item_id,
            channel: directive.channel,
            template_id: directive.template_id,
          });
          continue;
        }
        try {
          const job = await dispatchQueue.add(
            OUTBOUND_DISPATCH_QUEUE,
            { dispatchId: enqueued.value.id },
            {
              // Honour the link's per-action delay budget. BullMQ takes
              // milliseconds — `delay_seconds * 1000`.
              delay: directive.delay_seconds * 1000,
              // BullMQ's `attempts` is total tries (initial + retries),
              // so map the link's `max_retries` to attempts by adding 1.
              attempts: directive.max_retries + 1,
            },
          );
          log.info({
            operation: 'outboundDispatch.enqueue',
            status: 'success',
            latency_ms: Date.now() - enqueueStart,
            dispatch_id: enqueued.value.id,
            job_id: job.id,
            channel: directive.channel,
            template_id: directive.template_id,
            delay_seconds: directive.delay_seconds,
            max_retries: directive.max_retries,
            participant_id: directive.participant_id,
            item_id: directive.item_id,
          });
        } catch (queueErr) {
          // Same swallow-and-log policy as the dispatch-log failure: the
          // user already has a participant row; the dispatcher will
          // pick up the queued log row on a future enqueue retry or via
          // a manual sweep.
          log.error({
            operation: 'outboundDispatch.enqueue',
            status: 'failure',
            sub: 'queue.add',
            error: (queueErr as Error).message,
            error_type: (queueErr as Error).constructor.name,
            latency_ms: Date.now() - enqueueStart,
            dispatch_id: enqueued.value.id,
            channel: directive.channel,
            template_id: directive.template_id,
            participant_id: directive.participant_id,
            item_id: directive.item_id,
          });
        }
      }
    }

    log.info({
      status: 'success',
      event_type: 'audit',
      audit: 'link.submission_recorded',
      latency_ms: Date.now() - start,
      link_id: link.id,
      outcome,
      participant_id: participantRowId,
      submission_id: submissionId,
      lifecycle_status: lifecycleStatusOut,
      completion_pct: completionPctOut,
      owned_elsewhere: ownedElsewhere,
      submit_mode: submitMode,
    });

    if (outcome === 'skipped') {
      // Surface dedup in the response status to match the design (409).
      // `participant_id` is intentionally omitted on the public path so we
      // do not leak the DB row UUID of an existing participant to an
      // anonymous caller.
      return reply.code(409).send({
        outcome,
        submission_id: submissionId,
        message: 'This mobile number or email is already registered with this aggregator.',
        submission_mode: link.submissionMode,
        lifecycle_status: lifecycleStatusOut,
        completion_pct: completionPctOut,
        owned_elsewhere: ownedElsewhere,
      });
    }

    return reply.code(201).send({
      outcome,
      submission_id: submissionId,
      submission_mode: link.submissionMode,
      lifecycle_status: lifecycleStatusOut,
      completion_pct: completionPctOut,
      owned_elsewhere: ownedElsewhere,
    });
  });
}

/**
 * Build the `item_state` block sent to signalstack from the participant
 * payload.
 *
 * The body passes through unchanged — we only override the phone field
 * (chosen via the domain's identity selectors) so signalstack stores
 * the E.164 form the writer resolved upstream, not whatever raw value
 * the form / CSV carried.
 */
/**
 * Mutates `payload`: deletes any top-level field whose value is an
 * empty string and is not declared in the schema's `required` array.
 * Lets optional `format: uri` / `format: email` fields stay blank
 * without tripping Ajv format checks. JSON-Schema-spec-compliant —
 * `required: false` fields may be omitted entirely.
 */
function stripEmptyOptionalCells(
  payload: Record<string, unknown>,
  jsonSchema: Record<string, unknown>,
): void {
  const required = Array.isArray(jsonSchema['required'])
    ? new Set(jsonSchema['required'] as string[])
    : new Set<string>();
  for (const [field, value] of Object.entries(payload)) {
    if (required.has(field)) continue;
    if (typeof value === 'string' && value.trim() === '') {
      delete payload[field];
    }
  }
}

function buildSignalStackItemState(
  _domain: string,
  body: Record<string, unknown>,
  pushPhone: string | null,
  domainCfg: { identity: { phone: string } },
): Record<string, unknown> {
  const itemState: Record<string, unknown> = { ...body };

  // Signalstack's item_state schema validates the phone field with the
  // network's own pattern (e.g. purple_dot mobile_number requires
  // `^[0-9]{10}$`). The E.164 form is already carried up-stack as the
  // user.phone_number identity arg, so item_state should keep the raw
  // body value the user submitted. Only overwrite when the body had no
  // value at all — preserves the bulk-CSV fallback while letting form
  // submits pass schema validation upstream.
  const rawPhone = body[domainCfg.identity.phone];
  if (pushPhone && (typeof rawPhone !== 'string' || rawPhone.length === 0)) {
    itemState[domainCfg.identity.phone] = pushPhone;
  }

  return itemState;
}

/**
 * Loads a registration link by (org_slug, slug) and asserts it is currently
 * `live`. Translates store/null/expiry into the canonical 404 / 410 status
 * codes.
 */
async function loadLiveLinkByOrgAndSlug(
  orgSlug: string,
  slug: string,
  log: FastifyRequest['log'],
): Promise<RegistrationLink> {
  const store = getRegistrationLinksStore();
  const found = await store.findByOrgAndSlug(orgSlug, slug);
  if (!found.ok) {
    throw httpError('DB_UNAVAILABLE', { cause: new Error(found.error.message) });
  }
  if (!found.value || found.value.status === 'draft') {
    log.info({ status: 'failure', reason: 'not_found' });
    throw httpError('NOT_FOUND', { detail: 'No registration link for this slug.' });
  }
  if (found.value.status === 'retired') {
    log.info({ status: 'failure', reason: 'retired', link_id: found.value.id });
    throw httpError('LINK_NOT_LIVE', {
      detail: 'This registration link has been retired.',
    });
  }
  if (found.value.expiresAt && found.value.expiresAt.getTime() < Date.now()) {
    log.info({ status: 'failure', reason: 'expired', link_id: found.value.id });
    throw httpError('LINK_NOT_LIVE', {
      detail: 'This registration link has expired.',
    });
  }
  return found.value;
}
