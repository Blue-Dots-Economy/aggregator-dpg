/**
 * Org registration endpoints.
 *
 * Orgs live in `organisations` (`org_type = 'aggregator'`):
 *
 *   POST /v1/orgs/create
 *     Inserts a `pending` org, creates its Keycloak group and a disabled owner
 *     user, and emails the network admin a signed review link. No Signals org.
 *
 *   GET /v1/orgs
 *     Lists active orgs for the coordinator-registration dropdown. Reads the
 *     database only, not Keycloak.
 *
 * Belongs to `@aggregator-dpg/api`.
 */

import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { coolingRetryAfter } from '../services/registration-cooling.js';
import { getOrganisationStore } from '../services/organisation-store/index.js';
import { getUserStore } from '../services/user-store/index.js';
import type { Organisation } from '../services/organisation-store/interface.js';
import { resolveProfileRef } from '../services/schema-ref.js';
import { getIdpAdmin, KC_ATTR, OWNER_CREATED_BY } from '../services/idp-admin/index.js';
import { orgReviewRecipients, sendOrgReviewEmail } from '../services/org-registration-notify.js';
import { getMailer } from '@aggregator-dpg/mailer';
import { renderOrgAlreadyRegistered } from '../services/email-templates/index.js';
import { ownerSignInUrl } from '../services/decisions/org.js';
import { normalisePhone } from '@aggregator-dpg/shared-primitives/phone';
import { splitName } from '../services/name.js';
import { checkOrgInviteResendRate } from '../services/org-invite-resend-rate.js';
import { slugFromName } from '../services/slug.js';
import { orgLocationsFrom } from '../services/org-location.js';
import { validateOrgRegistration } from '../services/org-schema-validator.js';

/** Attempts at a fresh random-suffixed slug when one collides. */
const ORG_SLUG_RETRIES = 3;
import { authenticateAny } from '../services/auth/access-token.js';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';
import { throwTreeRefusal } from './console-shared.js';
import { newChildRefusal } from '../services/organisation-store/tree.js';
import { loadConsentConfig } from '@aggregator-dpg/config-loader/fs';
import { getConsentLedger } from '../services/consent-ledger/index.js';
import type { RecordConsentHook } from '../services/consent-ledger/hook.js';
import { stampConsent } from '../services/registration-consent.js';
import { resolveActiveNetwork } from '@aggregator-dpg/network-config/paths';
import { getNetworkConfig } from '../services/network-config.js';
import { SYSTEM_KNOWN_AS } from '@aggregator-dpg/shared-primitives/user-org';
import { treeRules } from '../services/known-as.js';
import { callerFromAny, recordRouteCaller } from '../services/authz/index.js';
import { errorMessage } from '@aggregator-dpg/shared-primitives/errors';
import { assertServiceCaller, assertSubmitRate } from './registration-shared.js';

/**
 * The fixed parts of an org-registration body. Every other key is a field of
 * the deployment's org-registration schema: it passes through here and is
 * checked by {@link validateOrgRegistration}, so a schema field needs no code.
 */
const OrgCreateBodySchema = z
  .object({
    display_name: z.string().min(1).max(200),
    /**
     * Parent org: the root or an active, non-Default aggregator org (`GET /v1/orgs/parents`).
     * The root when omitted.
     */
    parent_id: z.string().uuid().optional(),
    state: z.string().max(200).optional(),
    owner: z.object({
      name: z.string().min(1).max(200),
      email: z.string().email(),
      phone: z.string().min(1),
    }),
    consent: z.object({
      value: z.literal(true),
      given_at: z.string(),
      valid_till: z.string(),
    }),
    /**
     * The org's address, as picked from the autocomplete.
     *
     * Every part is declared so older clients' bodies are not stripped by `z.object`.
     */
    address: z
      .object({
        streetAddress: z.string().max(500).optional(),
        addressLocality: z.string().max(200).optional(),
        addressDistrict: z.string().max(200).optional(),
        addressRegion: z.string().max(200).optional(),
        postalCode: z.string().max(20).optional(),
        addressCountry: z.string().max(100).optional(),
      })
      .optional(),
    /**
     * `[longitude, latitude]` for the picked address, GeoJSON order.
     *
     * Absent when the user typed an address without picking a suggestion.
     */
    coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]).optional(),
  })
  .passthrough();

/**
 * Body keys stored elsewhere, so never copied into `profile`.
 *
 * `consent` is stored in the consent ledger.
 */
const ORG_COLUMN_BACKED_KEYS: ReadonlySet<string> = new Set([
  'display_name',
  'parent_id',
  'state',
  'owner',
  'consent',
]);

/**
 * Builds the `profile` payload: the schema-validated fields, plus the address
 * block and the picked coordinates, minus the keys stored elsewhere.
 *
 * The full address is kept because `locations` has no place for the district.
 *
 * @param schemaValues - Values {@link validateOrgRegistration} accepted.
 * @param address - The form's address block, when any.
 * @param coordinates - The picked address coordinates, when any.
 * @returns The `profile` payload; `{}` when the deployment declares no extra fields.
 */
function buildOrgProfile(
  schemaValues: Record<string, unknown>,
  address: z.infer<typeof OrgCreateBodySchema>['address'],
  coordinates: readonly [number, number] | undefined,
): Record<string, unknown> {
  const profile = Object.fromEntries(
    Object.entries(schemaValues).filter(
      ([key, value]) => !ORG_COLUMN_BACKED_KEYS.has(key) && value !== undefined,
    ),
  );
  if (address) profile['address'] = address;
  if (coordinates) profile['coordinates'] = coordinates;
  return profile;
}

const OrgCreatedResponseSchema = z
  .object({
    org_id: z.string(),
    slug: z.string(),
    status: z.string(),
    message: z.string(),
  })
  .passthrough();

const OrgParentsResponseSchema = z.object({
  /** False when the instance is at `max_total_orgs` or no org can take a child. */
  accepting: z.boolean(),
  /** Orgs that can take a child now. */
  parents: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      /** True for the network root. */
      is_root: z.boolean(),
      /** The name of the org's "known as" value, from its parent's list; null for the root. */
      known_as_name: z.string().nullable(),
      /** The name of the "known as" value an org registered under this one gets. */
      child_known_as_name: z.string().nullable(),
    }),
  ),
});

const OrgListResponseSchema = z
  .object({
    orgs: z.array(z.object({ id: z.string(), slug: z.string(), display_name: z.string() })),
  })
  .passthrough();

/**
 * Registers the org registration + dropdown routes.
 *
 * @param app - Fastify instance to attach the routes to.
 */
export function registerAggregatorOrgRoutes(base: FastifyInstance): void {
  const app = base.withTypeProvider<ZodTypeProvider>();
  app.post(
    '/v1/orgs/create',
    {
      config: { rbac: { access: 'service' } },
      schema: {
        tags: ['aggregator-orgs'],
        summary: 'Submit a new parent-org registration',
        description:
          'Creates a pending org (system of record) + mirrored Keycloak group + disabled org-owner user, and emails the network admin a signed review link. A rejected org registering again is set back to pending under the parent in this request, with the same checks. 409 ORG_DEPTH_LIMIT or ORG_CHILD_LIMIT (with fields.parent_id) when the parent cannot take the org; 409 ORG_TOTAL_LIMIT when the instance is full. 200 instead of 201 when the org already exists: a pending org gets a fresh review link, the owner of an active org gets a sign-in link.',
        body: OrgCreateBodySchema,
        response: {
          200: OrgCreatedResponseSchema,
          201: OrgCreatedResponseSchema,
          ...errorResponses(400, 401, 409, 500, 503),
        },
      },
    },
    async (req, reply) => {
      const log = req.log.child({ operation: 'org-registration.create' });
      const ctx: ReplyContext = { reply, log, start: Date.now() };

      await assertServiceCaller(req);
      const body = req.body;
      const { values, phoneE164 } = await checkOrgBody(body);
      const ownerEmail = body.owner.email.toLowerCase();
      // Looked up before any write, so a failure here leaves nothing half created.
      const reviewers = await orgReviewRecipients(body.parent_id ?? null, log);

      // Rate limit per (ip, owner email), like the coordinator submit.
      await assertSubmitRate(`${req.ip}|${ownerEmail}`, reply);

      // A resubmit by an owner who already has an org is answered from that
      // org's status; no new org is created.
      const existing = await getOrganisationStore().findByOwnerEmail(ownerEmail);
      if (!existing.ok) {
        throw httpError('DB_UNAVAILABLE', {
          cause: new Error(existing.error.message),
          fields: { sub_operation: 'orgStore.findByOwnerEmail' },
        });
      }
      if (existing.value) return answerResubmit(existing.value, body, ctx);

      // One person per email and per phone across coordinators and org owners.
      // Checked before any write. The phone is the OTP login key.
      const contactClash = await findOwnerContactClash(ownerEmail, phoneE164);
      // The email belongs to another account; an owner's is handled above.
      if (contactClash === 'email') {
        throw httpError('USER_EXISTS', { fields: { email: body.owner.email } });
      }
      if (contactClash === 'phone') {
        throw httpError('PHONE_EXISTS', { fields: { phone: phoneE164 } });
      }

      const { org, slug } = await createOrgRow(body, values, phoneE164, log);
      const groupId = await provisionOrgInIdp(org, slug, body, phoneE164, log);

      await sendOrgReviewEmail(
        {
          orgId: org.id,
          displayName: body.display_name,
          ownerEmail: body.owner.email,
          ownerPhone: phoneE164,
          parentId: org.parentId,
          parentName: org.parentName,
          recipients: reviewers,
        },
        log,
      );

      log.info(
        {
          status: 'success',
          latency_ms: Date.now() - ctx.start,
          org_id: org.id,
          slug,
          kc_group_id: groupId,
        },
        'org registration submitted',
      );

      return reply.status(201).send({
        org_id: org.id,
        slug,
        status: 'pending',
        message: 'Organisation submitted. A reviewer will approve it before coordinators can join.',
      });
    },
  );

  app.get(
    '/v1/orgs/parents',
    {
      config: { rbac: { access: 'service' } },
      schema: {
        tags: ['aggregator-orgs'],
        summary: 'List the orgs a new org can register under',
        description:
          'Returns the network root first, then active aggregator orgs other than the Default org, sorted by name, that can take a child now; each with its "known as" name and the name an org registered under it would get. `accepting` is false when the instance is full or no org can take a child.',
        response: { 200: OrgParentsResponseSchema, ...errorResponses(401, 500, 503) },
      },
    },
    async (req, reply) => {
      const auth = await authenticateAny(req);
      if (!auth.ok) {
        throw httpError('UNAUTHORIZED', {
          detail: auth.error.message,
          fields: { reason: auth.error.code },
        });
      }
      await recordRouteCaller(req, callerFromAny(auth.context));
      const store = getOrganisationStore();
      const [root, active, total] = await Promise.all([
        store.findRoot(),
        store.listActive(),
        store.countTotal(),
      ]);
      if (!root.ok) {
        throw httpError('DB_UNAVAILABLE', {
          cause: new Error(root.error.message),
          fields: { sub_operation: 'orgStore.findRoot' },
        });
      }
      if (!active.ok) {
        throw httpError('DB_UNAVAILABLE', {
          cause: new Error(active.error.message),
          fields: { sub_operation: 'orgStore.listActive' },
        });
      }
      if (!total.ok) {
        throw httpError('DB_UNAVAILABLE', {
          cause: new Error(total.error.message),
          fields: { sub_operation: 'orgStore.countTotal' },
        });
      }
      const candidates = [
        ...(root.value ? [root.value] : []),
        ...active.value.filter((o) => !o.isDefault),
      ];
      const children = await store.childCounts(candidates.map((o) => o.id));
      if (!children.ok) {
        throw httpError('DB_UNAVAILABLE', {
          cause: new Error(children.error.message),
          fields: { sub_operation: 'orgStore.childCounts' },
        });
      }
      const childNames = await store.defaultKnownAsNames(candidates.map((o) => o.id));
      if (!childNames.ok) {
        throw httpError('DB_UNAVAILABLE', {
          cause: new Error(childNames.error.message),
          fields: { sub_operation: 'orgStore.defaultKnownAsNames' },
        });
      }
      const org = (await getNetworkConfig()).aggregator.organisation;
      const rules = treeRules(org);
      // The instance total is reported by `accepting`, not per parent.
      const parents = candidates
        .filter((o) => {
          const refused = newChildRefusal(o.depth, children.value[o.id] ?? 0, total.value, rules);
          return refused === null || refused === 'TOTAL_LIMIT';
        })
        .map((o) => {
          const isRoot = o.id === root.value?.id;
          return {
            id: o.id,
            name: o.displayName,
            is_root: isRoot,
            known_as_name: isRoot ? null : o.knownAsName,
            child_known_as_name: childNames.value[o.id] ?? SYSTEM_KNOWN_AS.name,
          };
        });
      const accepting = total.value < rules.maxTotalOrgs && parents.length > 0;
      return reply.status(200).send({ accepting, parents });
    },
  );

  app.get(
    '/v1/orgs',
    {
      config: { rbac: { access: 'service' } },
      schema: {
        tags: ['aggregator-orgs'],
        summary: 'List active orgs for the coordinator-registration dropdown',
        description:
          'Returns active aggregator orgs sorted by name (plain SQL, no Keycloak admin API). The Default org is listed only while it is the only active org.',
        response: { 200: OrgListResponseSchema, ...errorResponses(401, 500, 503) },
      },
    },
    async (req, reply) => {
      const auth = await authenticateAny(req);
      if (!auth.ok) {
        throw httpError('UNAUTHORIZED', {
          detail: auth.error.message,
          fields: { reason: auth.error.code },
        });
      }
      await recordRouteCaller(req, callerFromAny(auth.context));
      const page = await getOrganisationStore().listActive();
      if (!page.ok) {
        throw httpError('DB_UNAVAILABLE', {
          cause: new Error(page.error.message),
          fields: { sub_operation: 'orgStore.listActive' },
        });
      }
      // The Default org is listed only while no other org is active.
      const hasRealOrg = page.value.some((o) => !o.isDefault);
      const listed = hasRealOrg ? page.value.filter((o) => !o.isDefault) : page.value;
      return reply.status(200).send({
        orgs: listed.map((o) => ({ id: o.id, slug: o.slug, display_name: o.displayName })),
      });
    },
  );
}

type OrgCreateBody = z.infer<typeof OrgCreateBodySchema>;

/** What a registration answer needs: the reply, the logger and the start time. */
interface ReplyContext {
  reply: FastifyReply;
  log: FastifyBaseLogger;
  start: number;
}

/**
 * Checks the body against the deployment's org-registration schema, which
 * decides the other fields, and normalises the owner's phone.
 *
 * @returns The schema-checked values and the E.164 phone.
 * @throws {HttpError} SCHEMA_VALIDATION or INVALID_PHONE
 */
async function checkOrgBody(body: OrgCreateBody) {
  const schemaCheck = await validateOrgRegistration(body);
  if (!schemaCheck.ok) {
    throw httpError('SCHEMA_VALIDATION', {
      detail: Object.entries(schemaCheck.errors)
        .map(([field, message]) => `${field}: ${message}`)
        .join('; '),
      fields: { field_errors: schemaCheck.errors },
    });
  }
  const phoneResult = normalisePhone(body.owner.phone);
  if (!phoneResult.ok) {
    throw httpError('INVALID_PHONE', {
      detail: phoneResult.error.message,
      fields: { input: body.owner.phone },
    });
  }
  return { values: schemaCheck.values, phoneE164: phoneResult.value };
}

/**
 * Answers a submit by an owner who already has an org, from that org's status.
 *
 * Never writes the submitted fields: the submit is anonymous, so an email
 * match alone must not change the org. Stored values are used. The parent is
 * the one exception: a rejected org is revived under the submitted parent, and
 * it stays pending until an admin approves it.
 *
 * @throws {HttpError} OWNER_ALREADY_REGISTERED for a retired org, and the
 *   errors of {@link reviveRejectedOrg} and {@link resendOwnerInvite}.
 */
async function answerResubmit(
  prior: Organisation,
  body: OrgCreateBody,
  ctx: ReplyContext,
): Promise<FastifyReply> {
  if (prior.status === 'inactive') {
    return reclaimOrgReview(await reviveRejectedOrg(prior, body), ctx);
  }
  // Approved: re-send the sign-in link. Mail goes to the stored owner email,
  // never the submitted one, since this submit is anonymous.
  if (prior.status === 'active') return resendOwnerInvite(prior, ctx);
  // Retired: never send a credential.
  if (prior.status !== 'pending') {
    throw httpError('OWNER_ALREADY_REGISTERED', { fields: { email: body.owner.email } });
  }
  return reclaimOrgReview(prior, ctx);
}

/**
 * Sets a rejected org back to pending under the submitted parent, refusing it
 * until the cooling window from `rejected_at` ends.
 *
 * @returns The revived row; it may sit under a new parent now.
 * @throws {HttpError} REGISTRATION_COOLING, a tree refusal, CONFLICT or DB_UNAVAILABLE
 */
async function reviveRejectedOrg(prior: Organisation, body: OrgCreateBody): Promise<Organisation> {
  const retryAfter = coolingRetryAfter(prior.rejectedAt, prior.updatedAt);
  if (retryAfter) {
    throw httpError('REGISTRATION_COOLING', {
      fields: { email: body.owner.email, retry_after: retryAfter },
    });
  }
  const rules = treeRules((await getNetworkConfig()).aggregator.organisation);
  const revived = await getOrganisationStore().revive(prior.id, body.parent_id, rules);
  if (revived.ok) return revived.value;
  throwTreeRefusal(revived.error, { parent_id: body.parent_id ?? null });
  // The row stopped being a rejected org after it was read.
  if (revived.error.code === 'NOT_FOUND') {
    throw httpError('CONFLICT', {
      detail: 'The organisation changed while it was being registered again. Try again.',
    });
  }
  throw httpError('DB_UNAVAILABLE', {
    cause: new Error(revived.error.message),
    fields: { sub_operation: 'orgStore.revive' },
  });
}

/**
 * Re-sends the review link for an existing pending or revived org. The row,
 * the Keycloak owner and the group are reused unchanged.
 */
async function reclaimOrgReview(row: Organisation, ctx: ReplyContext): Promise<FastifyReply> {
  await sendOrgReviewEmail(
    {
      orgId: row.id,
      displayName: row.displayName,
      ownerEmail: row.ownerEmail,
      ownerPhone: row.ownerPhone ?? '',
      parentId: row.parentId,
      parentName: row.parentName,
    },
    ctx.log,
  );
  ctx.log.info(
    { status: 'success', latency_ms: Date.now() - ctx.start, org_id: row.id, reclaim: true },
    'org re-submitted — review link re-sent (no field change)',
  );
  // Consent is recorded only on a fresh registration, not here.
  return ctx.reply.status(200).send({
    org_id: row.id,
    slug: row.slug,
    status: 'pending',
    message: 'Organisation re-submitted. A fresh approval link has been sent for review.',
  });
}

/**
 * Mails the owner of an approved org a sign-in link. A failed send is logged,
 * not raised. The row is not changed.
 *
 * @throws {HttpError} RATE_LIMITED
 */
async function resendOwnerInvite(row: Organisation, ctx: ReplyContext): Promise<FastifyReply> {
  const { reply, log } = ctx;
  // Rate-limited per owner address and fails closed. Not the route's shared
  // submit limiter: that one is keyed on IP and fails open.
  const resendRate = await checkOrgInviteResendRate(row.ownerEmail);
  if (!resendRate.allowed) {
    void reply.header('Retry-After', String(resendRate.retryAfterSeconds));
    log.warn(
      {
        status: 'skipped',
        org_id: row.id,
        reason: 'resend_rate_limited',
        retry_after_seconds: resendRate.retryAfterSeconds,
      },
      'invite-link resend throttled for this owner address',
    );
    throw httpError('RATE_LIMITED', {
      detail: `Retry in ${resendRate.retryAfterSeconds}s.`,
      fields: { retry_after_seconds: resendRate.retryAfterSeconds },
    });
  }

  const mail = renderOrgAlreadyRegistered({
    orgName: row.displayName,
    inviteUrl: ownerSignInUrl(),
  });
  const send = await getMailer().send({
    to: row.ownerEmail,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  });
  if (!send.ok) {
    log.warn(
      {
        status: 'failure',
        sub_operation: 'mailer.send.orgAlreadyRegistered',
        org_id: row.id,
        code: send.error.code,
        cause: send.error.message,
      },
      'already-registered invite link could not be delivered',
    );
  }
  log.info(
    {
      status: 'success',
      latency_ms: Date.now() - ctx.start,
      org_id: row.id,
      already_registered: true,
      mail_sent: send.ok,
    },
    'org already active — sign-in link sent to the owner on file',
  );
  // Report a failed send so the owner knows to contact support.
  return reply.status(200).send({
    org_id: row.id,
    slug: row.slug,
    status: 'active',
    mail_sent: send.ok,
    message: send.ok
      ? 'This organisation is already registered. The coordinator invitation link has been sent to the owner email on file.'
      : 'This organisation is already registered, but the coordinator invitation link could not be emailed just now. Please try again shortly, or contact support.',
  });
}

/**
 * Creates the pending org row, with its consent in the same transaction and
 * before any Keycloak call, so a ledger failure leaves nothing behind. A slug
 * clash is retried with a new slug.
 *
 * @returns The new org and the slug it got.
 * @throws {HttpError} SCHEMA_VALIDATION for an expired consent, and the errors
 *   of {@link throwOrgCreateError}.
 */
async function createOrgRow(
  body: OrgCreateBody,
  values: Record<string, unknown>,
  phoneE164: string,
  log: FastifyBaseLogger,
): Promise<{ org: Organisation; slug: string }> {
  const orgProfileRef = resolveProfileRef('org-registration.v1.json');
  if (!orgProfileRef) {
    log.warn(
      {
        operation: 'org-registration.create',
        status: 'skipped',
        sub_operation: 'resolveProfileRef',
      },
      'org-registration schema not found — storing profile without a variant ref',
    );
  }
  const orgConsent = stampConsent(body.consent);
  if (!orgConsent) {
    throw httpError('SCHEMA_VALIDATION', {
      detail: 'consent.valid_till must be in the future.',
      fields: { 'consent.valid_till': 'invalid' },
    });
  }
  const recordConsent = await orgConsentWriter({ consent: orgConsent, log });
  const rules = treeRules((await getNetworkConfig()).aggregator.organisation);
  const orgStore = getOrganisationStore();
  const createOnce = (slug: string) =>
    orgStore.create(
      {
        slug,
        displayName: body.display_name,
        // Schemas with an address block collect the state there.
        state: body.address?.addressRegion ?? body.state ?? null,
        ownerEmail: body.owner.email.toLowerCase(),
        ownerPhone: phoneE164,
        ownerName: body.owner.name,
        // The address is also kept in `profile` and `state`.
        locations: orgLocationsFrom(body.address, body.state, body.coordinates),
        profile: buildOrgProfile(values, body.address, body.coordinates),
        // The schema file that resolved; NULL means unknown.
        profileRef: orgProfileRef,
        ...(body.parent_id ? { parentId: body.parent_id } : {}),
        recordConsent,
      },
      rules,
    );
  // Each retry depends on the previous outcome, so the attempts are sequential.
  const createWithRetry = async (attempt: number, slug: string) => {
    const result = await createOnce(slug);
    const retry =
      !result.ok && result.error.code === 'DUPLICATE_SLUG' && attempt + 1 < ORG_SLUG_RETRIES;
    if (retry) return createWithRetry(attempt + 1, slugFromName(body.display_name));
    return { result, slug };
  };
  const { result, slug } = await createWithRetry(0, slugFromName(body.display_name));
  if (!result.ok) throwOrgCreateError(result.error, body, phoneE164, slug);
  return { org: result.value, slug };
}

/**
 * Maps a failed org create to the route's error.
 *
 * @throws {HttpError} ORG_NAME_TAKEN, ORG_SLUG_TAKEN, a tree refusal,
 *   USER_EXISTS, PHONE_EXISTS, CONSENT_WRITE_FAILED or DB_UNAVAILABLE
 */
function throwOrgCreateError(
  error: Parameters<typeof throwTreeRefusal>[0] & { message: string },
  body: OrgCreateBody,
  phoneE164: string,
  slug: string,
): never {
  if (error.code === 'DUPLICATE_NAME') {
    throw httpError('ORG_NAME_TAKEN', { fields: { display_name: body.display_name } });
  }
  if (error.code === 'DUPLICATE_SLUG') {
    throw httpError('ORG_SLUG_TAKEN', { fields: { slug } });
  }
  throwTreeRefusal(error, { parent_id: body.parent_id ?? null });
  // A concurrent registration took the email or phone after the pre-check.
  if (error.code === 'DUPLICATE_EMAIL') {
    throw httpError('USER_EXISTS', { fields: { email: body.owner.email } });
  }
  if (error.code === 'DUPLICATE_PHONE') {
    throw httpError('PHONE_EXISTS', { fields: { phone: phoneE164 } });
  }
  if (error.code === 'CONSENT_WRITE_FAILED') {
    throw httpError('CONSENT_WRITE_FAILED', {
      cause: new Error(error.message),
      fields: { sub_operation: 'recordOrgConsent', rolled_back: true },
    });
  }
  throw httpError('DB_UNAVAILABLE', {
    cause: new Error(error.message),
    fields: { sub_operation: 'orgStore.create' },
  });
}

/**
 * Creates the org's Keycloak group and its disabled owner user (enabled at
 * approval), and stamps both on the row. Any failure deletes what was created,
 * not deactivates it, so the owner's email and phone are freed for a retry.
 *
 * The group is named from the slug; the org name is a `display_name` attribute.
 *
 * @returns The Keycloak group id.
 * @throws {HttpError} IDP_UNAVAILABLE, USER_EXISTS, NAME_INVALID_CHARACTERS or DB_UNAVAILABLE
 */
async function provisionOrgInIdp(
  org: Organisation,
  slug: string,
  body: OrgCreateBody,
  phoneE164: string,
  log: FastifyBaseLogger,
): Promise<string> {
  const idp = getIdpAdmin();
  const group = await idp.createGroup(`org-${slug}`, {
    org_id: org.id,
    display_name: body.display_name,
  });
  if (!group.ok) {
    await discardHalfCreatedOrg(org.id, null, log);
    throw httpError('IDP_UNAVAILABLE', {
      cause: new Error(group.error.message),
      fields: { sub_operation: 'idp.createGroup', rolled_back: true },
    });
  }

  const { firstName, lastName } = splitName(body.owner.name);
  const ownerUser = await idp.createUser({
    email: body.owner.email,
    username: body.owner.email,
    phone: phoneE164,
    enabled: false,
    firstName,
    lastName,
    attributes: {
      [KC_ATTR.PHONE_NUMBER]: phoneE164,
      [KC_ATTR.DECISION_MADE]: 'pending',
      // Marks a user this app created; only such a user may be disabled when replaced.
      [KC_ATTR.CREATED_BY]: OWNER_CREATED_BY,
    },
  });
  if (!ownerUser.ok) {
    await discardHalfCreatedOrg(org.id, group.value.id, log);
    throwOwnerUserError(ownerUser.error, body.owner.email);
  }

  const stamped = await getOrganisationStore().update(org.id, {
    kcGroupId: group.value.id,
    ownerKcSub: ownerUser.value.id,
  });
  if (!stamped.ok) {
    // Roll back the group, the row and the new owner user so a retry can succeed.
    await discardHalfCreatedOrg(org.id, group.value.id, log);
    const removed = await idp.deleteUser(ownerUser.value.id);
    if (!removed.ok) {
      log.warn(
        {
          status: 'failure',
          sub_operation: 'idp.deleteUser',
          org_id: org.id,
          code: removed.error.code,
        },
        'could not remove the Keycloak owner user of a half-created org',
      );
    }
    throw httpError('DB_UNAVAILABLE', {
      cause: new Error(stamped.error.message),
      fields: { sub_operation: 'orgStore.update.stamp', rolled_back: true },
    });
  }
  return group.value.id;
}

/**
 * Maps a failed Keycloak owner-user create to the route's error.
 *
 * @throws {HttpError} USER_EXISTS, NAME_INVALID_CHARACTERS or IDP_UNAVAILABLE
 */
function throwOwnerUserError(error: { code: string; message: string }, email: string): never {
  if (error.code === 'USER_EXISTS') {
    throw httpError('USER_EXISTS', { fields: { email, rolled_back: true } });
  }
  if (error.code === 'INVALID_NAME') {
    throw httpError('NAME_INVALID_CHARACTERS', {
      fields: { name: 'owner.name', rolled_back: true },
    });
  }
  throw httpError('IDP_UNAVAILABLE', {
    cause: new Error(error.message),
    fields: { sub_operation: 'idp.createUser', rolled_back: true },
  });
}

/**
 * Builds the consent-ledger write that `orgStore.create` runs inside its transaction.
 *
 * The consent config is read now, before the transaction. A failed ledger
 * write throws, so the store rolls back and answers `CONSENT_WRITE_FAILED`.
 *
 * @param consent - The server-stamped consent; its `valid_till` is stored.
 * @param log - Request-scoped child logger.
 * @returns The hook to pass as `recordConsent`.
 * @throws {HttpError} CONSENT_WRITE_FAILED when the consent config cannot be read.
 */
async function orgConsentWriter({
  consent,
  log,
}: {
  consent: { valid_till: string };
  log: ReturnType<FastifyRequest['log']['child']>;
}): Promise<RecordConsentHook> {
  const { network, brand } = resolveActiveNetwork();
  let termsVersion: number;
  let privacyVersion: number;
  try {
    const consentCfg = await loadConsentConfig(network, brand);
    termsVersion = consentCfg.audiences.org.documents.terms.current_version;
    privacyVersion = consentCfg.audiences.org.documents.privacy.current_version;
  } catch (e) {
    log.error(
      {
        operation: 'consentLedger.recordOrgConsent',
        status: 'failure',
        error: errorMessage(e),
        network,
        brand: brand ?? null,
      },
      'consent config load failed — registration refused',
    );
    throw httpError('CONSENT_WRITE_FAILED', {
      fields: { sub_operation: 'loadConsentConfig', rolled_back: true },
    });
  }

  return async (executor, orgId) => {
    const result = await getConsentLedger()
      .withExecutor(executor)
      .recordRegistrationConsent({
        subjectType: 'organisation',
        subjectId: orgId,
        network,
        brand: brand ?? null,
        termsVersion,
        privacyVersion,
        validTill: new Date(consent.valid_till),
      });
    if (!result.success) {
      log.error(
        {
          operation: 'consentLedger.recordOrgConsent',
          status: 'failure',
          error: result.error.message,
          error_type: result.error.name,
          org_id: orgId,
          network,
          brand: brand ?? null,
          terms_version: termsVersion,
          privacy_version: privacyVersion,
        },
        'consent ledger write failed — registration rolled back',
      );
      // Throwing inside the store's transaction rolls the registration back.
      throw result.error;
    }
  };
}

/**
 * Reports whether an org owner's email or phone already belongs to someone else.
 *
 * A phone match on an org with the same owner email is not a clash.
 *
 * @param ownerEmail - Lowercased owner email.
 * @param phoneE164 - Canonical owner phone.
 * @returns `'email'`, `'phone'`, or `null` when the pair is free.
 * @throws {HttpError} `DB_UNAVAILABLE` when a lookup fails.
 */
async function findOwnerContactClash(
  ownerEmail: string,
  phoneE164: string,
): Promise<'email' | 'phone' | null> {
  const aggregators = getUserStore();
  const byEmail = await aggregators.findByContactEmail(ownerEmail);
  if (!byEmail.ok) {
    throw httpError('DB_UNAVAILABLE', {
      cause: new Error(byEmail.error.message),
      fields: { sub_operation: 'userStore.findByContactEmail' },
    });
  }
  if (byEmail.value) return 'email';

  const byPhone = await aggregators.findByContactPhone(phoneE164);
  if (!byPhone.ok) {
    throw httpError('DB_UNAVAILABLE', {
      cause: new Error(byPhone.error.message),
      fields: { sub_operation: 'userStore.findByContactPhone' },
    });
  }
  if (byPhone.value) return 'phone';

  const orgByPhone = await getOrganisationStore().findByOwnerPhone(phoneE164);
  if (!orgByPhone.ok) {
    throw httpError('DB_UNAVAILABLE', {
      cause: new Error(orgByPhone.error.message),
      fields: { sub_operation: 'orgStore.findByOwnerPhone' },
    });
  }
  if (orgByPhone.value && orgByPhone.value.ownerEmail !== ownerEmail) return 'phone';
  return null;
}

/**
 * Removes an org whose Keycloak setup failed part-way: its group, if any, and its row.
 *
 * Best effort; each failed step is logged.
 *
 * @param orgId - The half-created org.
 * @param groupId - Its Keycloak group id, or `null` when none was created.
 * @param log - Request logger.
 */
async function discardHalfCreatedOrg(
  orgId: string,
  groupId: string | null,
  log: FastifyBaseLogger,
): Promise<void> {
  if (groupId) {
    const g = await getIdpAdmin().deleteGroup(groupId);
    if (!g.ok) {
      log.warn(
        { status: 'failure', sub_operation: 'idp.deleteGroup', org_id: orgId, code: g.error.code },
        'could not remove the Keycloak group of a half-created org',
      );
    }
  }
  const d = await getOrganisationStore().deleteById(orgId);
  if (!d.ok) {
    log.warn(
      {
        status: 'failure',
        sub_operation: 'orgStore.deleteById',
        org_id: orgId,
        code: d.error.code,
      },
      'could not remove a half-created org row',
    );
  }
}
