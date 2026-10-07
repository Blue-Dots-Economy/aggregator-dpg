/**
 * Org registration endpoints (spec §6.1 / §6 dropdown).
 *
 * Always registered: the org hierarchy is always on since migration 0028.
 * Orgs live in `organisations` (`org_type = 'aggregator'`):
 *
 *   POST /v1/orgs/create
 *     Inserts a `pending` `aggregator_orgs` row (system of record), creates the
 *     mirrored KC group + a disabled org-owner KC user, and emails the network
 *     admin a signed approve/reject review link. No signalstack org.
 *
 *   GET /v1/orgs
 *     Lists active orgs for the coordinator-registration dropdown — plain SQL
 *     on `aggregator_orgs WHERE status='active'`, no Keycloak admin API (A5).
 *
 * Belongs to `@aggregator-dpg/api`.
 */

import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { coolingRetryAfter } from '../services/registration-cooling.js';
import { getAggregatorOrgStore } from '../services/aggregator-org-store/index.js';
import { getAggregatorStore } from '../services/aggregator-store/index.js';
import type { AggregatorOrg } from '../services/aggregator-org-store/interface.js';
import { resolveProfileRef } from '../services/schema-ref.js';
import { getIdpAdmin, KC_ATTR, OWNER_CREATED_BY } from '../services/idp-admin/index.js';
import { sendOrgReviewEmail } from '../services/org-registration-notify.js';
import { getMailer } from '@aggregator-dpg/mailer';
import { renderOrgAlreadyRegistered } from '../services/email-templates/index.js';
import { ownerSignInUrl } from '../services/decisions/org.js';
import { normalisePhone } from '@aggregator-dpg/shared-primitives/phone';
import { splitName } from '../services/name.js';
import { checkSubmitRate } from '../services/submit-rate.js';
import { checkOrgInviteResendRate } from '../services/org-invite-resend-rate.js';
import { slugFromName } from '../services/slug.js';
import { orgLocationsFrom, orgUrlFrom } from '../services/org-location.js';

/** Attempts at a fresh random-suffixed slug when one collides. */
const ORG_SLUG_RETRIES = 3;
import { authenticateAny } from '../services/auth/access-token.js';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';
import { loadConsentConfig } from '@aggregator-dpg/config-loader/fs';
import { getConsentLedger } from '../services/consent-ledger/index.js';
import type { RecordConsentHook } from '../services/consent-ledger/hook.js';
import { stampConsent } from '../services/registration-consent.js';
import { resolveActiveNetwork } from '@aggregator-dpg/network-config/paths';
import { callerFromAny, enforceRouteAccess } from '../services/authz/index.js';

const OrgCreateBodySchema = z.object({
  display_name: z.string().min(1).max(200),
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
  // Schema-driven fields from the Aug 2026 review. Present only on deployments
  // whose org-registration schema declares them (UP-GZB today); every other
  // network omits them and they stay undefined. All persist to
  // `aggregator_orgs.profile` — none has a column of its own.
  website: z.string().url().max(2048).optional(),
  aggregator_type: z.array(z.enum(['seeker', 'provider', 'service_provider'])).optional(),
  organisation_type: z.enum(['educational', 'non_educational']).optional(),
  organisation_sub_type_educational: z.string().max(100).optional(),
  organisation_sub_type_non_educational: z.string().max(100).optional(),
  management_type: z.enum(['private', 'government', 'ngo', 'other']).optional(),
  /**
   * One free-text address, as picked from the autocomplete (#810).
   *
   * The discrete parts are no longer collected, but they stay declared here so
   * a body written against the previous schema still validates rather than
   * being silently stripped — `z.object` defaults to stripping unknown keys,
   * which would turn an old client into a silent data-loss path.
   */
  address: z
    .object({
      streetAddress: z.string().max(500).optional(),
      addressLocality: z.string().max(200).optional(),
      // ka-dhwd, up-gzb and alimco all collected a district before #810, so
      // dropping it would be the exact silent-stripping path this block
      // exists to prevent.
      addressDistrict: z.string().max(200).optional(),
      addressRegion: z.string().max(200).optional(),
      postalCode: z.string().max(20).optional(),
      addressCountry: z.string().max(100).optional(),
    })
    .optional(),
  /**
   * `[longitude, latitude]` for the picked address, GeoJSON order.
   *
   * Must be declared to survive: `z.object` strips undeclared keys silently,
   * so an omission here would drop the coordinate with no error anywhere.
   * Absent whenever the user typed an address without picking a suggestion.
   */
  coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]).optional(),
});

/**
 * Body keys that already own a typed column on `aggregator_orgs`, and so must
 * never be copied into `profile`.
 *
 * Keeping one authoritative home per field is what stops the jsonb payload and
 * the columns drifting apart. `consent` is excluded because the consent
 * ledger records it (with its `valid_till`, 0029).
 */
const ORG_COLUMN_BACKED_KEYS: ReadonlySet<string> = new Set([
  'display_name',
  'state',
  'owner',
  'consent',
]);

/**
 * Collects the schema-driven fields of an org-registration body into the
 * `profile` payload.
 *
 * Only keys with no column of their own are carried over, so adding a field to
 * the org-registration schema needs no storage change — just an entry on
 * {@link OrgCreateBodySchema}.
 *
 * @param body - Validated org-registration body.
 * @returns The `profile` payload; `{}` when the deployment declares no extra fields.
 */
function buildOrgProfile(body: z.infer<typeof OrgCreateBodySchema>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(body).filter(
      ([key, value]) => !ORG_COLUMN_BACKED_KEYS.has(key) && value !== undefined,
    ),
  );
}

const OrgCreatedResponseSchema = z
  .object({
    org_id: z.string(),
    slug: z.string(),
    status: z.string(),
    message: z.string(),
  })
  .passthrough();

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
export function registerAggregatorOrgRoutes(app: FastifyInstance): void {
  app.post(
    '/v1/orgs/create',
    {
      config: { rbac: { access: 'service' } },
      schema: {
        tags: ['aggregator-orgs'],
        summary: 'Submit a new parent-org registration',
        description:
          'Creates a pending org (system of record) + mirrored Keycloak group + disabled org-owner user, and emails the network admin a signed review link.',
        body: OrgCreateBodySchema,
        response: { 201: OrgCreatedResponseSchema, ...errorResponses(400, 401, 409, 500, 503) },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const log = req.log.child({ operation: 'org-registration.create' });
      const start = Date.now();

      const auth = await authenticateAny(req);
      if (!auth.ok) {
        throw httpError('UNAUTHORIZED', {
          detail: auth.error.message,
          fields: { reason: auth.error.code },
        });
      }
      await enforceRouteAccess(req, callerFromAny(auth.context));

      const body = req.body as z.infer<typeof OrgCreateBodySchema>;

      const phoneResult = normalisePhone(body.owner.phone);
      if (!phoneResult.ok) {
        throw httpError('INVALID_PHONE', {
          detail: phoneResult.error.message,
          fields: { input: body.owner.phone },
        });
      }
      const phoneE164 = phoneResult.value;

      const orgStore = getAggregatorOrgStore();
      const idp = getIdpAdmin();
      const ownerEmail = body.owner.email.toLowerCase();

      // Re-send the network-admin review link for an existing recoverable org
      // without touching its fields. Shared by the still-pending reclaim and the
      // rejected-then-cooling-elapsed revive path (#726): both re-use the SAME
      // row, leaving the disabled KC owner + mirrored group intact.
      const reclaimOrgReview = async (row: AggregatorOrg): Promise<FastifyReply> => {
        await sendOrgReviewEmail(
          {
            orgId: row.id,
            displayName: row.displayName,
            ownerEmail: row.ownerEmail,
            ownerPhone: row.ownerPhone ?? '',
          },
          log,
        );
        log.info(
          { status: 'success', latency_ms: Date.now() - start, org_id: row.id, reclaim: true },
          'org re-submitted — review link re-sent (no field change)',
        );
        // v1 records consent only on fresh registration, not on reclaim (deliberate).
        return reply.status(200).send({
          org_id: row.id,
          slug: row.slug,
          status: 'pending',
          message: 'Organisation re-submitted. A fresh approval link has been sent for review.',
        });
      };

      // Re-send the coordinator-invite (grant) link for an org that is already
      // approved. Soft-fail on the mail send, matching the approval path: the
      // org is live either way, so a mail outage must not surface as a
      // registration failure. Nothing about the row is touched.
      const resendOwnerInvite = async (row: AggregatorOrg): Promise<FastifyReply> => {
        // Bound per OWNER ADDRESS, fail-closed, before anything is minted.
        // The route's inherited submit limiter is keyed `ip|email` and fails
        // open, so rotating IPs buys a fresh bucket and a Redis outage removes
        // the cap entirely — neither is acceptable on a path where every
        // admitted call produces another independent 90-day credential.
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

        // Phase 5: a console sign-in link, never a fresh 90-day grant.
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
            latency_ms: Date.now() - start,
            org_id: row.id,
            already_registered: true,
            mail_sent: send.ok,
          },
          'org already active — sign-in link sent to the owner on file',
        );
        // Never claim delivery that did not happen: the whole point of this
        // branch is an owner who never received the first email, so telling
        // them a second one is on its way when the send just failed leaves
        // them waiting instead of contacting support.
        return reply.status(200).send({
          org_id: row.id,
          slug: row.slug,
          status: 'active',
          mail_sent: send.ok,
          message: send.ok
            ? 'This organisation is already registered. The coordinator invitation link has been sent to the owner email on file.'
            : 'This organisation is already registered, but the coordinator invitation link could not be emailed just now. Please try again shortly, or contact support.',
        });
      };

      // Rate limit per (ip, owner email) — org create does KC group + user +
      // email per hit, so throttle it like the coordinator submit.
      const rl = await checkSubmitRate(`${req.ip}|${ownerEmail}`);
      if (!rl.allowed) {
        void reply.header('Retry-After', String(rl.retryAfterSeconds));
        throw httpError('RATE_LIMITED', {
          detail: `Retry in ${rl.retryAfterSeconds}s.`,
          fields: { retry_after_seconds: rl.retryAfterSeconds },
        });
      }

      // §7 reclaim: a resubmit by the same owner against a still-recoverable
      // org (pending, or rejected == inactive) refreshes that row and re-mints
      // the network-admin review link, instead of erroring on the existing KC
      // owner user. An *active* org for this owner is a genuine duplicate.
      const existing = await orgStore.findByOwnerEmail(ownerEmail);
      if (!existing.ok) {
        throw httpError('DB_UNAVAILABLE', {
          cause: new Error(existing.error.message),
          fields: { sub_operation: 'orgStore.findByOwnerEmail' },
        });
      }
      if (existing.value) {
        const prior = existing.value;
        // Recovery only re-sends the review link — never writes the resubmitted
        // display_name/state/phone. The submit is anonymous, so overwriting on an
        // owner-email match alone would let anyone hijack the org. Re-mint uses
        // the STORED values and the link goes to the network admin.
        if (prior.status === 'inactive') {
          // Rejected org (#726): block re-registration until the cooling window
          // elapses, measured from the write-once `rejected_at`. Once it lapses,
          // revive the SAME row to pending (clearing `rejected_at`) and re-send
          // the review link — the disabled KC owner + group stay intact.
          const retryAfter = coolingRetryAfter(prior.rejectedAt, prior.updatedAt);
          if (retryAfter) {
            throw httpError('REGISTRATION_COOLING', {
              fields: { email: body.owner.email, retry_after: retryAfter },
            });
          }
          const revived = await orgStore.update(prior.id, {
            status: 'pending',
            rejectedAt: null,
          });
          if (!revived.ok) {
            throw httpError('DB_UNAVAILABLE', {
              cause: new Error(revived.error.message),
              fields: { sub_operation: 'orgStore.reviveRejected' },
            });
          }
          return reclaimOrgReview(prior);
        }
        if (prior.status === 'active') {
          // An approved org re-submitting is almost always its owner looking for
          // the coordinator-invite link they lost — the org-approved email is
          // sent once, soft-fails, and the owner cannot sign in to recover it,
          // so a bare 409 leaves the org permanently unable to onboard anyone.
          // Re-send the link instead. Mail goes to the STORED owner email, never
          // `body.owner.email`: this submit is anonymous, so honouring the
          // submitted address would hand a stranger the org's invite credential.
          return resendOwnerInvite(prior);
        }
        if (prior.status !== 'pending') {
          // retired — a dead org owns this owner email, and must never be
          // handed a working credential.
          throw httpError('OWNER_ALREADY_REGISTERED', { fields: { email: body.owner.email } });
        }
        // Still pending → re-send the review link, no field change.
        return reclaimOrgReview(prior);
      }

      // One person per email and per phone across coordinators AND org owners
      // (the `contact` table, migration 0025). Checked before anything is
      // written so a clash never leaves a half-provisioned org behind.
      //  * email held by a coordinator → the same 409 the Keycloak USER_EXISTS
      //    branch below returns (it used to fire only after the org row and
      //    KC group had been created and rolled back);
      //  * phone held by a coordinator, or by a different org's owner →
      //    PHONE_EXISTS. The phone is the OTP login key; two users on one
      //    number make login ambiguous.
      const contactClash = await findOwnerContactClash(ownerEmail, phoneE164);
      if (contactClash === 'email') {
        throw httpError('OWNER_ALREADY_REGISTERED', { fields: { email: body.owner.email } });
      }
      if (contactClash === 'phone') {
        throw httpError('PHONE_EXISTS', { fields: { phone: phoneE164 } });
      }

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
      // The slug carries a random suffix; retry a collision like
      // createAggregatorWithSlug does (review A11).
      // Registration consent is written in the SAME transaction as the org
      // (0029): a ledger failure leaves no org, owner account or contact, and
      // nothing has reached Keycloak yet. The config is read before the
      // transaction opens; `valid_till` is clamped like a coordinator's.
      const orgConsent = stampConsent(body.consent);
      if (!orgConsent) {
        throw httpError('SCHEMA_VALIDATION', {
          detail: 'consent.valid_till must be in the future.',
          fields: { 'consent.valid_till': 'invalid' },
        });
      }
      const recordConsent = await orgConsentWriter({ consent: orgConsent, log });
      let slug = slugFromName(body.display_name);
      const createOnce = (s: string) =>
        orgStore.create({
          slug: s,
          displayName: body.display_name,
          // `address.addressRegion` is the form's only State input on schemas that
          // declare an address block; the standalone `state` field is hidden there.
          // Prefer it so the column stays populated either way.
          state: body.address?.addressRegion ?? body.state ?? null,
          ownerEmail: ownerEmail,
          ownerPhone: phoneE164,
          ownerName: body.owner.name,
          // Org details (0028); the same values also stay in `profile` /
          // `state` until Phase 4 drops them.
          url: orgUrlFrom(body.website),
          locations: orgLocationsFrom(body.address, body.state, body.coordinates),
          profile: buildOrgProfile(body),
          // Derived from the schema file that actually resolved, not from the
          // brand env — a missing override must not be recorded as if its
          // variant had produced the payload. NULL means "variant unknown".
          profileRef: orgProfileRef,
          recordConsent,
        });
      // Each retry depends on the previous outcome, so the attempts are sequential.
      const createWithRetry = async (attempt: number): ReturnType<typeof createOnce> => {
        const result = await createOnce(slug);
        if (result.ok || result.error.code !== 'DUPLICATE_SLUG') return result;
        if (attempt + 1 >= ORG_SLUG_RETRIES) return result;
        slug = slugFromName(body.display_name);
        return createWithRetry(attempt + 1);
      };
      const created = await createWithRetry(0);
      if (!created.ok) {
        if (created.error.code === 'DUPLICATE_NAME') {
          throw httpError('ORG_NAME_TAKEN', { fields: { display_name: body.display_name } });
        }
        if (created.error.code === 'DUPLICATE_SLUG') {
          throw httpError('ORG_SLUG_TAKEN', { fields: { slug } });
        }
        // Backstops for the contact pre-check above (a concurrent registration
        // took the email/phone between the check and the insert).
        if (created.error.code === 'DUPLICATE_EMAIL') {
          throw httpError('OWNER_ALREADY_REGISTERED', { fields: { email: body.owner.email } });
        }
        if (created.error.code === 'DUPLICATE_PHONE') {
          throw httpError('PHONE_EXISTS', { fields: { phone: phoneE164 } });
        }
        if (created.error.code === 'CONSENT_WRITE_FAILED') {
          throw httpError('CONSENT_WRITE_FAILED', {
            cause: new Error(created.error.message),
            fields: { sub_operation: 'recordOrgConsent', rolled_back: true },
          });
        }
        throw httpError('DB_UNAVAILABLE', {
          cause: new Error(created.error.message),
          fields: { sub_operation: 'orgStore.create' },
        });
      }
      const org = created.value;

      // Mirrored KC group (authz mirror — spec §9). On failure the org is
      // deleted (below), so a half-provisioned org never lingers.
      // The group name is slug-based (unique + stable); the human org name is
      // carried as a `display_name` attribute so it is visible in Keycloak.
      const group = await idp.createGroup(`org-${slug}`, {
        org_id: org.id,
        display_name: body.display_name,
      });
      if (!group.ok) {
        // Delete the half-created org (the contact GC trigger then frees the
        // owner's email/phone) rather than parking it inactive: an inactive
        // row that never got a Keycloak owner would hold the owner's contact
        // and block every retry with PHONE_EXISTS.
        await discardHalfCreatedOrg(org.id, null, log);
        throw httpError('IDP_UNAVAILABLE', {
          cause: new Error(group.error.message),
          fields: { sub_operation: 'idp.createGroup', rolled_back: true },
        });
      }

      // Disabled org-owner KC user (enabled at approval — spec §9 / A8).
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
          // Marks a user this app created, so a replaced owner may be disabled
          // without touching a login shared with Signals (design C4).
          [KC_ATTR.CREATED_BY]: OWNER_CREATED_BY,
        },
      });
      if (!ownerUser.ok) {
        await discardHalfCreatedOrg(org.id, group.value.id, log);
        if (ownerUser.error.code === 'USER_EXISTS') {
          throw httpError('OWNER_ALREADY_REGISTERED', {
            fields: { email: body.owner.email, rolled_back: true },
          });
        }
        throw httpError('IDP_UNAVAILABLE', {
          cause: new Error(ownerUser.error.message),
          fields: { sub_operation: 'idp.createUser', rolled_back: true },
        });
      }

      const stamped = await orgStore.update(org.id, {
        kcGroupId: group.value.id,
        ownerKcSub: ownerUser.value.id,
      });
      if (!stamped.ok) {
        // Roll the half-created org back completely: its group and row, and
        // the owner user this request just created (so a retry can register
        // again instead of hitting USER_EXISTS on a stranded disabled user).
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

      await sendOrgReviewEmail(
        {
          orgId: org.id,
          displayName: body.display_name,
          ownerEmail: body.owner.email,
          ownerPhone: phoneE164,
        },
        log,
      );

      log.info(
        {
          status: 'success',
          latency_ms: Date.now() - start,
          org_id: org.id,
          slug,
          kc_group_id: group.value.id,
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
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = await authenticateAny(req);
      if (!auth.ok) {
        throw httpError('UNAUTHORIZED', {
          detail: auth.error.message,
          fields: { reason: auth.error.code },
        });
      }
      await enforceRouteAccess(req, callerFromAny(auth.context));
      const page = await getAggregatorOrgStore().listActive();
      if (!page.ok) {
        throw httpError('DB_UNAVAILABLE', {
          cause: new Error(page.error.message),
          fields: { sub_operation: 'orgStore.listActive' },
        });
      }
      // The Default org is selectable only while no real org is active (D3-12).
      const hasRealOrg = page.value.some((o) => !o.isDefault);
      const listed = hasRealOrg ? page.value.filter((o) => !o.isDefault) : page.value;
      return reply.status(200).send({
        orgs: listed.map((o) => ({ id: o.id, slug: o.slug, display_name: o.displayName })),
      });
    },
  );
}

/**
 * Builds the org's consent-ledger write for `orgStore.create`, which runs it
 * inside the create transaction (0029). The consent config is read here,
 * BEFORE the transaction opens. Network/brand come from
 * resolveActiveNetwork() so the recorded version matches the content the web
 * layer displayed.
 *
 * Fail-closed: a config that cannot be read refuses the registration up front;
 * a failed ledger write throws inside the transaction, so the store rolls the
 * org, its owner account and contact back and answers `CONSENT_WRITE_FAILED`.
 *
 * @param consent - The server-stamped consent (its `valid_till` is stored, D4-4).
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
        error: e instanceof Error ? e.message : String(e),
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
 * Reports whether an org owner's email or phone already belongs to someone
 * else — a coordinator, or (for the phone) another org's owner. Same-email org
 * rows are handled earlier by the reclaim/revive/resend branches, so a phone
 * match on an org with the SAME owner email is not a clash.
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
  const aggregators = getAggregatorStore();
  const byEmail = await aggregators.findByContactEmail(ownerEmail);
  if (!byEmail.ok) {
    throw httpError('DB_UNAVAILABLE', {
      cause: new Error(byEmail.error.message),
      fields: { sub_operation: 'aggregatorStore.findByContactEmail' },
    });
  }
  if (byEmail.value) return 'email';

  const byPhone = await aggregators.findByContactPhone(phoneE164);
  if (!byPhone.ok) {
    throw httpError('DB_UNAVAILABLE', {
      cause: new Error(byPhone.error.message),
      fields: { sub_operation: 'aggregatorStore.findByContactPhone' },
    });
  }
  if (byPhone.value) return 'phone';

  const orgByPhone = await getAggregatorOrgStore().findByOwnerPhone(phoneE164);
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
 * Removes an org whose Keycloak provisioning failed part-way: its mirrored
 * group (when one was created) and the row itself. Best-effort — each step is
 * logged; a leftover is reported by scripts/sql/contact-preflight.sql
 * ("inactive_orgs_without_kc_owner") and the stale-registration prune.
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
  const d = await getAggregatorOrgStore().deleteById(orgId);
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
