/**
 * Public registration link endpoints of the aggregator API (`@aggregator-dpg/api`).
 *
 *   GET  /public/v1/aggregators/:orgSlug/links/:slug
 *     Anonymous resolve of a live link, for rendering the registration form.
 *     404 for missing or draft slugs; 410 for retired or expired ones.
 *
 *   POST /public/v1/aggregators/:orgSlug/registrations/:slug
 *     Anonymous submit. Validates the body against the domain's participant
 *     schema, normalises phone and email, creates the user and profile in
 *     signalstack, records a link_submission row, and returns its id.
 *
 *   POST /public/v1/aggregators/:orgSlug/voice-requests/:slug
 *     Anonymous voice-bot request on a link that offers voice. Creates the
 *     account for a new phone (an existing one is left untouched) and returns
 *     the bot's number.
 *
 * The (org_slug, slug) pair is the access credential; no JWT is needed.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getRegistrationLinksStore } from '../services/registration-links-store/index.js';
import type { RegistrationLink } from '../services/registration-links-store/index.js';
import { getUserStore } from '../services/user-store/index.js';
import { getNetworkConfig } from '../services/network-config.js';
import { domainRequiresConsent, type VoiceBot } from '@aggregator-dpg/network-config/interface';
import {
  describeSchemaIssue,
  formatFieldErrors,
  type FieldError,
} from '@aggregator-dpg/network-config/field-errors';
import { resolveSubmissionShape, publicHintI18nKey } from '../services/registration-mode/index.js';
import { modeOffers, modeOffersVoice, resolveVoiceBot } from '../services/voice-bots/index.js';
import { getSchemaLoader } from '../services/schema-loader/index.js';
import { parseKnownPhone, parseMobilePhone, phoneForField } from '../services/phone.js';
import {
  LIFECYCLE_STATUSES,
  resolveLifecycle,
  type LifecycleStatus,
} from '../services/onboarding/lifecycle.js';
import { getSignalStackWriter } from '../services/signalstack.js';
import { getDb } from '../db/client.js';
import { linkSubmissions } from '../db/schema.js';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';
import { consume } from '../services/rate-limiter/index.js';
import { config } from '../config.js';
import { buildSignalStackItemState } from '@aggregator-dpg/signalstack-writer/item-state';
import {
  checkAccountOnlyBody,
  onboardFailureError,
  readString,
  resolveConsentAndAge,
} from './public-registration-identity.js';

const LinkParamsSchema = z.object({
  orgSlug: z.string().min(1).describe('Aggregator organisation slug.'),
  slug: z.string().min(1).describe('Registration link slug.'),
});

/** Public-safe shape of a live link returned by the resolve endpoint. */
const ResolveLinkResponseSchema = z
  .object({
    slug: z.string(),
    network: z.string().describe("Active signalstack network id (e.g. 'blue_dot')."),
    domain: z.string(),
    context: z.object({}).loose().describe('Link context snapshot (free-form metadata).'),
    registration_mode: z.string(),
    submission_shape: z.string().describe("'account_and_profile' or 'account_only'."),
    public_hint_i18n_key: z.string().nullable(),
    schema_id: z.string().nullable(),
    schema_version: z.string().nullable(),
    schema: z
      .unknown()
      .nullable()
      .describe("JSON Schema for the link's domain; null for account_only links."),
    identity: z
      .object({})
      .loose()
      .describe('Identity field selectors (name / phone / email) for this domain.'),
    expires_at: z.string().nullable(),
    offers: z
      .array(z.enum(['voice', 'form']))
      .describe('Registration channels the page offers, in display order.'),
    voice_bot: z
      .object({
        display_name: z.string(),
        phone: z.string().describe('The number the participant calls; shown before they register.'),
        languages: z.array(z.string()),
        description: z.string().optional(),
      })
      .nullable()
      .describe('The voice bot the link resolves to; null when it offers no voice option.'),
  })
  .loose();

/**
 * Submission body. The profile part is validated at runtime (Ajv) against the
 * domain's participant schema. Identity field names come from the network config.
 * `consent_terms` / `consent_privacy` are accepted on account_only links.
 */
const PublicRegistrationSubmitBodySchema = z
  .object({})
  .loose()
  .describe(
    "Dynamic registration payload validated at runtime against the link domain's participant JSON Schema (identity fields such as name/phone/email plus profile fields). consent_terms / consent_privacy are accepted on account_only links. item_locations optionally carries coordinates the registrant picked from the address autocomplete.",
  );

/**
 * Max submitted coordinates. No schema caps the array and the input is
 * unauthenticated, so the limit is set here.
 */
const MAX_ITEM_LOCATIONS = 25;

/**
 * Coordinates the registrant picked from the address autocomplete, sent to
 * signalstack as `item_locations`.
 *
 * Absent or empty: signalstack geocodes the address text instead. Non-empty:
 * stored as-is. `lat`/`lng` must be numbers, as signalstack requires.
 */
const ItemLocationsSchema = z
  .array(
    z.object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      label: z.string().min(1).optional(),
    }),
  )
  .max(MAX_ITEM_LOCATIONS);

/** 201 payload — participant created (or saved as draft) and pushed to signalstack. */
const SubmitAcceptedResponseSchema = z
  .object({
    outcome: z.string().describe("'passed'"),
    submission_id: z.string().optional(),
    registration_mode: z.string(),
    submission_shape: z.string(),
    lifecycle_status: z.enum(LIFECYCLE_STATUSES).nullable(),
    owned_elsewhere: z.boolean(),
  })
  .loose();

/** 409 payload: the phone or email is already registered. */
const SubmitSkippedResponseSchema = SubmitAcceptedResponseSchema.extend({
  outcome: z.string().describe("'skipped'"),
  message: z.string(),
}).loose();

/** Voice request body: identity, consent and birth year only; checked at runtime. */
const VoiceRequestBodySchema = z
  .object({})
  .loose()
  .describe(
    "The domain's identity name and phone keys, consent_terms / consent_privacy, and year_of_birth (or age) on guardian-gated domains. Phone is required; email and profile fields are rejected.",
  );

/** 200 payload of a voice request: the bot to call and whether the phone already had an account. */
const VoiceRequestResponseSchema = z.object({
  existing: z
    .boolean()
    .describe('True when the phone already had an account; nothing was created then.'),
  voice_bot: z.object({
    display_name: z.string(),
    phone: z.string().describe('E.164 number to call.'),
    languages: z.array(z.string()),
  }),
});

export function registerPublicRegistrationLinkRoutes(base: FastifyInstance): void {
  const app = base.withTypeProvider<ZodTypeProvider>();
  app.get(
    '/public/v1/aggregators/:orgSlug/links/:slug',
    {
      config: { rbac: { access: 'public' } },
      schema: {
        tags: ['public-registration'],
        summary: 'Resolve a public registration link',
        description:
          'Looks up a live (non-expired, active) registration link by org slug + link slug. Returns the link metadata (domain, context, schema id) that the public registration form needs. 404 for missing/draft slugs, 410 for retired or expired ones.',
        params: LinkParamsSchema,
        response: {
          200: ResolveLinkResponseSchema,
          ...errorResponses(400, 404, 410, 503),
        },
      },
    },
    async (req, reply) => {
      const { orgSlug, slug } = req.params;
      const log = req.log.child({ operation: 'public.linkResolve', org_slug: orgSlug, slug });
      const start = Date.now();

      const link = await loadLiveLinkByOrgAndSlug(orgSlug, slug, log);

      // Include the domain's JSON Schema from the network config so the page needs
      // no second fetch. A domain no longer in the config returns 404.
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

      // The link's registration_mode sets the form shape:
      //   - 'account_and_profile': identity + full profile schema.
      //   - 'account_only': identity only; `schema` is null.
      const submissionShape = resolveSubmissionShape(link.registrationMode, networkCfg);
      const hintKey = publicHintI18nKey(link.registrationMode, networkCfg);
      const accountOnly = submissionShape === 'account_only';

      // Resolve the bot only for modes that offer voice. `voice` is dropped from
      // `offers` when none applies. The bot's number is returned so the page
      // can show it before the participant gives their details.
      const modeChannels = modeOffers(link.registrationMode, networkCfg);
      let bot: VoiceBot | null = null;
      if (modeChannels.includes('voice')) {
        const resolved = resolveVoiceBot(link, networkCfg);
        bot = resolved.bot;
        if (resolved.fellBack) {
          log.warn({
            status: 'voice_bot_fallback',
            link_id: link.id,
            voice_bot_key: link.voiceBotKey,
          });
        }
      }
      const offers = bot ? modeChannels : modeChannels.filter((o) => o !== 'voice');

      return reply.send({
        slug: link.slug,
        // Active network id; the BFF passes it to /lookup.
        network: networkCfg.network.id,
        domain: link.domain,
        context: link.context,
        registration_mode: link.registrationMode,
        submission_shape: submissionShape,
        public_hint_i18n_key: hintKey,
        schema_id: accountOnly ? null : `participant-${link.domain}`,
        schema_version: accountOnly ? null : 'v1',
        schema: accountOnly ? null : linkDomainCfg.schema,
        // Identity field selectors for this domain. On an account-only submit only
        // these stay required (a name + at least one contact).
        identity: linkDomainCfg.identity,
        expires_at: link.expiresAt ? link.expiresAt.toISOString() : null,
        offers,
        voice_bot: bot
          ? {
              display_name: bot.display_name,
              phone: bot.phone,
              languages: bot.languages,
              ...(bot.description !== undefined && { description: bot.description }),
            }
          : null,
      });
    },
  );

  app.post(
    '/public/v1/aggregators/:orgSlug/registrations/:slug',
    {
      config: { rbac: { access: 'public' } },
      schema: {
        tags: ['public-registration'],
        summary: 'Submit a public participant registration',
        description:
          "Public endpoint reached by the QR-link registration form. Validates the submission against the link's domain schema (runtime Ajv — the body shape is dynamic per network/domain), then creates the user + profile in signalstack. Returns 201 on success, 409 (outcome:'skipped') when the identity is already owned by ANOTHER aggregator, and 429 when the per-link rate limit trips. There is no de-duplication within an aggregator: a repeat submission creates a new profile and returns 201.",
        params: LinkParamsSchema,
        body: PublicRegistrationSubmitBodySchema,
        response: {
          201: SubmitAcceptedResponseSchema,
          409: SubmitSkippedResponseSchema,
          ...errorResponses(400, 404, 410, 429, 500, 502, 503),
        },
      },
    },
    async (req, reply) => {
      const { orgSlug, slug } = req.params;
      const log = req.log.child({
        operation: 'public.registrationSubmit',
        org_slug: orgSlug,
        slug,
      });
      const start = Date.now();

      await enforceSubmitRateLimit(req, reply, orgSlug, slug, log);

      const link = await loadLiveLinkByOrgAndSlug(orgSlug, slug, log);

      const rawBody = req.body;

      // Identity selectors from the network config, shared by the account_only
      // key guard and the normaliser.
      const networkCfgEarly = await getNetworkConfig();
      const linkDomainCfgEarly = networkCfgEarly.domains[link.domain];
      if (!linkDomainCfgEarly) {
        throw httpError('NOT_FOUND', {
          detail: `link domain '${link.domain}' not declared in network ${networkCfgEarly.network.id}`,
        });
      }
      // Consent is required only when the domain has `consent_required`.
      const consentRequiredForDomain = domainRequiresConsent(linkDomainCfgEarly.goLiveRequired);

      // Unknown registration_mode values fall back to `account_and_profile`
      // (see resolveSubmissionShape).
      const submissionShape = resolveSubmissionShape(link.registrationMode, networkCfgEarly);

      // `account_only`: accept identity fields only. Reject item_state or any other
      // top-level key before Ajv runs.
      if (submissionShape === 'account_only') {
        checkAccountOnlyBody(rawBody, linkDomainCfgEarly.identity, {
          requirePhone: false,
          allowEmail: true,
        });
      }

      // The link's registration_mode sets the submit shape. `account_only` creates
      // the user only (no item). `account_and_profile` always submits an item;
      // missing profile fields make it `draft`. A stray `partial` key is stripped.
      const body: Record<string, unknown> = { ...rawBody };
      delete body['partial'];

      // Read and strip `item_locations` so it never reaches Ajv or item_state.
      // Reject a malformed value here; signalstack's own 400 could not be traced to it.
      const rawItemLocations = body['item_locations'];
      delete body['item_locations'];
      let itemLocations: z.infer<typeof ItemLocationsSchema> = [];
      if (rawItemLocations !== undefined) {
        const parsed = ItemLocationsSchema.safeParse(rawItemLocations);
        if (!parsed.success) {
          throw httpError('SCHEMA_VALIDATION', {
            detail: `item_locations is invalid: ${parsed.error.issues[0]?.message ?? 'unexpected shape'}`,
          });
        }
        itemLocations = parsed.data;
      }

      const submitMode: 'with_item' | 'account_only' =
        submissionShape === 'account_only' ? 'account_only' : 'with_item';

      // Consent and birth year are read, then stripped so they never reach Ajv
      // or item_state.
      const { compliance, age: ageNum } = resolveConsentAndAge(body, {
        consentRequired: consentRequiredForDomain,
        withItem: submitMode === 'with_item',
      });

      // Identity selectors come from the network config (schema sniffer, with
      // aggregator.config.yaml overrides).
      const networkCfg = await getNetworkConfig();
      const linkDomainCfg = networkCfg.domains[link.domain];
      if (!linkDomainCfg) {
        throw httpError('NOT_FOUND', {
          detail: `link domain '${link.domain}' not declared in network ${networkCfg.network.id}`,
        });
      }
      const phoneSourceKey = linkDomainCfg.identity.phone;

      // 0. Clean the phone first, so the schema check below sees the stored form. Any
      // valid number passes; Signals refuses a non-mobile only for a new person.
      const phoneRaw = readString(body, phoneSourceKey) ?? '';
      let phoneNormalised: string | null = null;
      if (phoneRaw && phoneSourceKey) {
        const phone = parseKnownPhone(phoneRaw);
        if (!phone.ok) {
          throw httpError('INVALID_PHONE', { detail: phone.error.message });
        }
        phoneNormalised = phone.value;
        body[phoneSourceKey] = phoneForField(phone.value, linkDomainCfg.schema, phoneSourceKey);
      }

      // 1. Validate against the domain schema. Skipped for `account_only`: identity
      // was checked above and Ajv would flag the consent keys as extra properties.
      if (submissionShape !== 'account_only') {
        // Remove empty cells before Ajv, so an unfilled field is absent rather than
        // failing `format`/`type`/`minLength`. Same as the worker's bulk-row strip.
        const schemaRef = { id: `participant-${link.domain}`, version: 'v1' };
        const loader = getSchemaLoader();
        const validatorResult = await loader.getValidator(schemaRef);
        if (!validatorResult.success) {
          log.error({ status: 'failure', sub: 'schema.load', error: validatorResult.error.code });
          throw httpError('INTERNAL', {
            detail: 'Registration schema unavailable.',
            cause: new Error(validatorResult.error.message),
          });
        }
        stripEmptyCells(body);

        // Name and at least one contact are required even on a partial profile;
        // Ajv below ignores `required`. Same rule as the account_only guard.
        {
          const present = (k?: string): boolean => Boolean(readString(body, k));
          const nameKey = linkDomainCfg.identity.name;
          const emailKey = linkDomainCfg.identity.email;
          const hasName = present(nameKey);
          const hasPhone = present(phoneSourceKey);
          const hasEmail = present(emailKey);
          if (!hasName || (!hasPhone && !hasEmail)) {
            throw httpError('SCHEMA_VALIDATION', {
              detail: 'Registration requires name and at least one of phone or email.',
              fields: {
                missing: [
                  ...(!hasName ? [nameKey ?? 'name'] : []),
                  ...(!hasPhone && !hasEmail ? ['phone_or_email'] : []),
                ],
              },
            });
          }
        }

        const validate = validatorResult.value;
        if (!validate(body)) {
          // Partial profiles are accepted: drop `required` errors outside a `then` branch, since
          // signals marks such an item `draft`. Constraints on present fields still 400.
          //
          // For a conditional requirement (`allOf`/`if`/`then`), a `required` error
          // inside `then` is kept because signals enforces it. Ajv's `if` summary error
          // names no field, so it is dropped.
          const isConditionalRequired = (e: { keyword?: string; schemaPath?: string }) =>
            e.keyword === 'required' && (e.schemaPath ?? '').includes('/then/');
          const issues = (validate.errors ?? []).filter(
            (e) => e.keyword !== 'if' && (e.keyword !== 'required' || isConditionalRequired(e)),
          );
          if (issues.length > 0) {
            // Name each failed field in Signals' wording (#904): the form shows
            // `detail` in its banner, so it must say which field is wrong.
            const described = issues.map((e) => describeSchemaIssue(e, linkDomainCfg.schema));
            throw httpError('SCHEMA_VALIDATION', {
              detail: formatFieldErrors(described),
              fields: { issues, field_errors: fieldErrorMap(described) },
            });
          }
        }
      }

      // 2. Normalise the email. Any client-supplied `participant_id` is
      // dropped, so an anonymous caller cannot choose it.
      delete body['participant_id'];
      const emailSourceKey = linkDomainCfg.identity.email;
      // Email is optional.
      const emailRaw = readString(body, emailSourceKey) ?? '';
      const emailNormalised = emailRaw ? emailRaw.trim().toLowerCase() : null;

      // 2a. Read the signalstack org id from `users.signalstack_org_id` before the
      // transaction. NULL means the org was never registered with signalstack: answer
      // 503 so the participant retries.
      const ss = getSignalStackWriter();
      let signalstackOrgId: string | null = null;
      if (ss) {
        const aggLookup = await getUserStore().findById(link.userId);
        if (!aggLookup.ok) {
          throw httpError('DB_UNAVAILABLE', {
            fields: { sub_operation: 'userStore.findById' },
          });
        }
        if (!aggLookup.value) {
          throw httpError('NOT_FOUND', { detail: 'Aggregator missing for live link.' });
        }
        signalstackOrgId = aggLookup.value.signalstackOrgId;
        if (!signalstackOrgId) {
          throw httpError('SIGNALSTACK_ORG_NOT_REGISTERED', {
            fields: { aggregator_id: link.userId, link_id: link.id },
          });
        }
      }

      // 3 + 4. The link_submission INSERT and the signalstack push commit together:
      // a push failure rolls the row back, so a 2xx means signals has the profile.
      // Lifecycle fields are null when signals is disabled or the submit is account_only.
      let lifecycleStatusOut: LifecycleStatus | null = null;
      let ownedElsewhere = false;
      const txResult = await getDb().transaction(async (tx) => {
        // Default outcome; signals overwrites it when configured.
        const insertedOutcome: 'passed' | 'skipped' = 'passed';
        let outcome: 'passed' | 'skipped' = insertedOutcome;

        const submission = await tx
          .insert(linkSubmissions)
          .values({
            linkId: link.id,
            userId: link.userId,
            metadataSnapshot: link.context,
            submittedData: body,
            outcome,
          })
          .returning({ id: linkSubmissions.id });

        // Push inside the transaction so a failure rolls back the submission row.
        if (ss && signalstackOrgId) {
          const nameSourceKey = linkDomainCfg.identity.name;
          // Fallback only; the guard above rejects a blank name. The link id is an opaque UUID.
          const name = readString(body, nameSourceKey) ?? link.id;
          const phoneFromBody = readString(body, phoneSourceKey) ?? phoneNormalised;
          const pushPhone = phoneNormalised ?? phoneFromBody;
          const result = await ss.onboard({
            actingOrgId: signalstackOrgId,
            requestId: req.id,
            name,
            ...(pushPhone ? { phoneNumber: pushPhone } : {}),
            ...(emailNormalised ? { email: emailNormalised } : {}),
            // Adult: send consent via `compliance`, plus age. Minor: send neither.
            ...(compliance ? { compliance } : {}),
            ...(ageNum !== undefined ? { age: ageNum } : {}),
            channel: 'link',
            source_id: link.id,
            network: config.SIGNALSTACK_ITEM_NETWORK,
            domain: link.domain,
            item_type: linkDomainCfg.itemType,
            profile: buildSignalStackItemState(body, pushPhone, linkDomainCfg.identity.phone),
            // Omitted when empty so signalstack geocodes the address text.
            ...(itemLocations.length > 0 ? { item_locations: itemLocations } : {}),
            submit_mode: submitMode,
          });

          if (!result.success) {
            log.error({
              status: 'failure',
              sub: 'signalstack.push',
              error: result.error.message,
              code: result.error.code,
              link_id: link.id,
            });
            throw onboardFailureError(result.error, linkDomainCfg.schema);
          }

          // `account_only` creates no item, so lifecycle fields are null.
          const lifecycleStatus =
            submitMode === 'account_only' || !result.value.profile_item_id
              ? null
              : resolveLifecycle({
                  ...(result.value.lifecycle_status
                    ? { lifecycle_status: result.value.lifecycle_status }
                    : {}),
                });
          ownedElsewhere = Boolean(result.value.owned_elsewhere);
          lifecycleStatusOut = lifecycleStatus;

          // Signals decides the outcome. Each submission creates a new profile; there
          // is no dedup within an aggregator. Skip only when another aggregator owns
          // the identity (tenant isolation).
          outcome = ownedElsewhere ? 'skipped' : 'passed';

          log.info({
            status: 'success',
            sub: 'signalstack.push',
            user_id: result.value.user_id,
            profile_item_id: result.value.profile_item_id,
            onboarded_at: result.value.onboarded_at,
            already_registered: result.value.already_registered ?? false,
            owned_elsewhere: ownedElsewhere,
            lifecycle_status: lifecycleStatus,
            submit_mode: submitMode,
            link_id: link.id,
          });
        }

        // The row was inserted with `passed`; store any correction to `skipped` in
        // the same transaction so the row matches the response.
        const submissionId = submission[0]?.id;
        if (submissionId && outcome !== insertedOutcome) {
          await tx
            .update(linkSubmissions)
            .set({ outcome })
            .where(eq(linkSubmissions.id, submissionId));
        }

        return {
          outcome,
          submissionId,
        };
      });
      const { outcome, submissionId } = txResult;

      log.info({
        status: 'success',
        event_type: 'audit',
        audit: 'link.submission_recorded',
        latency_ms: Date.now() - start,
        link_id: link.id,
        outcome,
        submission_id: submissionId,
        lifecycle_status: lifecycleStatusOut,
        owned_elsewhere: ownedElsewhere,
        submit_mode: submitMode,
      });

      if (outcome === 'skipped') {
        // Owned by another aggregator: 409 with no participant identifier.
        return reply.code(409).send({
          outcome,
          submission_id: submissionId,
          message: 'This mobile number or email is already registered with another aggregator.',
          registration_mode: link.registrationMode,
          submission_shape: submissionShape,
          lifecycle_status: lifecycleStatusOut,
          owned_elsewhere: ownedElsewhere,
        });
      }

      return reply.code(201).send({
        outcome,
        submission_id: submissionId,
        registration_mode: link.registrationMode,
        submission_shape: submissionShape,
        lifecycle_status: lifecycleStatusOut,
        owned_elsewhere: ownedElsewhere,
      });
    },
  );

  app.post(
    '/public/v1/aggregators/:orgSlug/voice-requests/:slug',
    {
      config: { rbac: { access: 'public' } },
      schema: {
        tags: ['public-registration'],
        summary: 'Get the voice-bot number of a public link, creating the account if new',
        description:
          "Public endpoint behind the 'talk to the voice bot' option of a two-option link. Checks the phone with signalstack first: a new phone gets an account (no profile) under the link's aggregator; an existing one, whoever owns it, is left untouched. Returns the bot's number either way (200, never 409 for an existing account). 409 when the link offers no voice option or no bot resolves; 429 when the per-link rate limit, shared with the form submit, trips.",
        params: LinkParamsSchema,
        body: VoiceRequestBodySchema,
        response: {
          200: VoiceRequestResponseSchema,
          ...errorResponses(400, 404, 409, 410, 429, 502, 503),
        },
      },
    },
    async (req, reply) => {
      const { orgSlug, slug } = req.params;
      const log = req.log.child({ operation: 'public.voiceRequest', org_slug: orgSlug, slug });
      const start = Date.now();

      await enforceSubmitRateLimit(req, reply, orgSlug, slug, log);

      const link = await loadLiveLinkByOrgAndSlug(orgSlug, slug, log);
      const networkCfg = await getNetworkConfig();
      const domainCfg = networkCfg.domains[link.domain];
      if (!domainCfg) {
        throw httpError('NOT_FOUND', {
          detail: `link domain '${link.domain}' not declared in network ${networkCfg.network.id}`,
        });
      }

      const resolved = modeOffersVoice(link.registrationMode, networkCfg)
        ? resolveVoiceBot(link, networkCfg)
        : null;
      const bot = resolved?.bot ?? null;
      if (!bot) {
        log.info({ status: 'failure', reason: 'voice_bot_unavailable', link_id: link.id });
        throw httpError('VOICE_BOT_UNAVAILABLE');
      }
      if (resolved?.fellBack) {
        log.warn({
          status: 'voice_bot_fallback',
          link_id: link.id,
          voice_bot_key: link.voiceBotKey,
        });
      }

      const rawBody = req.body;
      checkAccountOnlyBody(rawBody, domainCfg.identity, { requirePhone: true, allowEmail: false });
      const body: Record<string, unknown> = { ...rawBody };
      const { compliance, age } = resolveConsentAndAge(body, {
        consentRequired: domainRequiresConsent(domainCfg.goLiveRequired),
        withItem: false,
      });

      // Any valid number finds a stored person; a new one must be a mobile (checked below).
      const phone = parseKnownPhone(readString(body, domainCfg.identity.phone) ?? '');
      if (!phone.ok) {
        throw httpError('INVALID_PHONE', { detail: phone.error.message });
      }
      const phoneNumber = phone.value;

      const ss = getSignalStackWriter();
      if (!ss) {
        log.error({ status: 'failure', sub: 'signalstack.disabled', link_id: link.id });
        throw httpError('SIGNALSTACK_ORG_NOT_REGISTERED', {
          detail: 'Signalstack integration is not configured.',
        });
      }
      const aggLookup = await getUserStore().findById(link.userId);
      if (!aggLookup.ok) {
        throw httpError('DB_UNAVAILABLE', { fields: { sub_operation: 'userStore.findById' } });
      }
      if (!aggLookup.value) {
        throw httpError('NOT_FOUND', { detail: 'Aggregator missing for live link.' });
      }
      const actingOrgId = aggLookup.value.signalstackOrgId;
      if (!actingOrgId) {
        throw httpError('SIGNALSTACK_ORG_NOT_REGISTERED', {
          fields: { aggregator_id: link.userId, link_id: link.id },
        });
      }

      // Probe first: an account-only onboard for an existing user is not a
      // no-op in Signals (it records consent again and can put drafts live).
      const probe = await ss.probeUser({
        actingOrgId,
        requestId: req.id,
        phoneNumber,
        network: config.SIGNALSTACK_ITEM_NETWORK,
        domain: link.domain,
      });
      if (!probe.success) {
        log.error({
          status: 'failure',
          sub: 'signalstack.probe',
          error: probe.error.message,
          code: probe.error.code,
          link_id: link.id,
        });
        throw httpError('SIGNALSTACK_PROBE_FAILED', {
          detail: 'Could not check the phone number.',
          fields: { code: probe.error.code },
          cause: probe.error,
        });
      }
      const existing = probe.value.user_exists;
      if (!existing) {
        const mobile = parseMobilePhone(phoneNumber);
        if (!mobile.ok) throw httpError('INVALID_PHONE', { detail: mobile.error.message });
      }

      // The stored body keeps identity only; consent and birth year were stripped.
      const submission = {
        linkId: link.id,
        userId: link.userId,
        metadataSnapshot: link.context,
        submittedData: body,
      };
      let outcome: 'passed' | 'skipped';
      if (existing) {
        outcome = 'skipped';
        await getDb()
          .insert(linkSubmissions)
          .values({ ...submission, outcome })
          .returning({ id: linkSubmissions.id });
      } else {
        outcome = 'passed';
        // The row and the onboard commit together: an onboard failure rolls the row back.
        await getDb().transaction(async (tx) => {
          await tx
            .insert(linkSubmissions)
            .values({ ...submission, outcome })
            .returning({ id: linkSubmissions.id });
          const result = await ss.onboard({
            actingOrgId,
            requestId: req.id,
            name: readString(body, domainCfg.identity.name) ?? link.id,
            phoneNumber,
            ...(compliance ? { compliance } : {}),
            ...(age !== undefined ? { age } : {}),
            channel: 'link',
            source_id: link.id,
            network: config.SIGNALSTACK_ITEM_NETWORK,
            domain: link.domain,
            item_type: domainCfg.itemType,
            profile: buildSignalStackItemState(body, phoneNumber, domainCfg.identity.phone),
            submit_mode: 'account_only',
          });
          if (!result.success) {
            log.error({
              status: 'failure',
              sub: 'signalstack.push',
              error: result.error.message,
              code: result.error.code,
              link_id: link.id,
            });
            throw onboardFailureError(result.error, domainCfg.schema);
          }
        });
      }

      // Audit line, no PII: `outcome: 'passed'` means an account was created.
      log.info({
        status: 'success',
        event_type: 'audit',
        audit: 'link.voice_request_recorded',
        latency_ms: Date.now() - start,
        link_id: link.id,
        voice_bot_key: bot.key,
        existing,
        outcome,
      });

      return reply.send({
        existing,
        voice_bot: { display_name: bot.display_name, phone: bot.phone, languages: bot.languages },
      });
    },
  );
}

/**
 * Applies the per-link submit rate limit, keyed by (orgSlug, slug, ip).
 *
 * The form submit and the voice request share the budget. CAPTCHA is checked
 * in the BFF; this is a fallback.
 *
 * @throws {HttpError} `RATE_LIMITED`, with a `Retry-After` header, when the window is used up.
 */
async function enforceSubmitRateLimit(
  req: FastifyRequest,
  reply: FastifyReply,
  orgSlug: string,
  slug: string,
  log: FastifyRequest['log'],
): Promise<void> {
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
}

/**
 * Deletes every top-level field whose value is empty (`null`, `undefined`,
 * blank string, or empty array), required or not.
 *
 * An absent required field makes signals mark the item `draft`. Matches the
 * worker's `stripAllEmptyCells`.
 *
 * @param payload - The submission body; mutated in place.
 */
function stripEmptyCells(payload: Record<string, unknown>): void {
  for (const [field, value] of Object.entries(payload)) {
    const isEmpty =
      value === null ||
      value === undefined ||
      (typeof value === 'string' && value.trim() === '') ||
      (Array.isArray(value) && value.length === 0);
    if (isEmpty) {
      delete payload[field];
    }
  }
}

/**
 * Loads a registration link by (org_slug, slug) and checks it is `live`.
 * Missing answers 404; retired or expired answers 410.
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

/**
 * Collapses described field errors into `{ field: message }`, first message
 * per field, the same shape as Signals' `fields` map.
 *
 * @param errors - Described field errors in report order.
 * @returns One message per field; field-less errors are left out.
 */
function fieldErrorMap(errors: readonly FieldError[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of errors) {
    if (e.field && !Object.hasOwn(out, e.field)) out[e.field] = e.message;
  }
  return out;
}
