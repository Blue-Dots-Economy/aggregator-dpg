/**
 * Org invite endpoints of `@aggregator-dpg/api`.
 *
 *   GET  /v1/org/invite/read     check an org invite link for its registration page
 *   POST /v1/org/invite/accept   register the invited org and its owner under the inviting org
 *
 * Orgs live in `organisations` (`org_type = 'aggregator'`). No Signals org is created.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getOrganisationStore } from '../services/organisation-store/index.js';
import { checkSubmitRate } from '../services/submit-rate.js';
import {
  InviteReadQuerySchema,
  InviteReadResponseSchema,
} from '@aggregator-dpg/shared-primitives/user-org';
import {
  authenticateCaller,
  claimInvite,
  inviteReadHandler,
  releaseInvite,
  usableInvite,
} from './invite-shared.js';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';
import { loadConsentConfig } from '@aggregator-dpg/config-loader/fs';
import { getConsentLedger } from '../services/consent-ledger/index.js';
import type { RecordConsentHook } from '../services/consent-ledger/hook.js';
import { stampConsent } from '../services/registration-consent.js';
import { resolveActiveNetwork } from '@aggregator-dpg/network-config/paths';
import {
  checkOrgForm,
  createOrgWithOwner,
  findOwnerContactClash,
  OrgFormSchema,
  type OrgCreateResult,
} from '../services/registration/org-create.js';

/**
 * The org invite accept body: the org form plus the invite token, with consent
 * required. The parent is the inviting org, never the body.
 */
const OrgInviteAcceptBodySchema = z
  .object({
    invite: z.string().min(1).max(4096),
    ...OrgFormSchema.shape,
    consent: z.object({
      value: z.literal(true),
      given_at: z.string(),
      valid_till: z.string(),
    }),
  })
  .loose();

/**
 * Returns a successful org-creation value, or throws its error as an HTTP error.
 *
 * @throws {HttpError} The error's code, detail, fields and cause.
 */
function unwrapOrThrow<T>(result: OrgCreateResult<T>): T {
  if (result.ok) return result.value;
  const { code, detail, fields, cause } = result.error;
  throw httpError(code, {
    ...(detail !== undefined ? { detail } : {}),
    ...(fields !== undefined ? { fields } : {}),
    ...(cause !== undefined ? { cause } : {}),
  });
}

/** `201` of an org invite accept: pending until the owner enters the email code. */
const OrgInviteAcceptedResponseSchema = z.object({
  org_id: z.string(),
  slug: z.string(),
  status: z.literal('pending'),
  message: z.string(),
  /** The invited owner email, passed to the sign-in page so the owner is not asked for it. */
  login_hint: z.string(),
});

/**
 * Registers the org registration + dropdown routes.
 *
 * @param app - Fastify instance to attach the routes to.
 */
export function registerAggregatorOrgRoutes(app: FastifyInstance): void {
  app.post(
    '/v1/org/invite/accept',
    {
      config: { rbac: { access: 'service' } },
      schema: {
        tags: ['aggregator-orgs'],
        summary: 'Register an organisation from an invite',
        description:
          'Creates the invited org under the inviting org as `pending`, with its Keycloak group and an owner user that can sign in but holds no access yet. The owner email must be the invited address. The org becomes active when the owner signs in with an email code and calls `POST /v1/user/activate`; no approval. 409 ORG_DEPTH_LIMIT, ORG_CHILD_LIMIT or ORG_TOTAL_LIMIT when the inviting org can no longer take it. Reached with the web BFF service-account token.',
        body: OrgInviteAcceptBodySchema,
        response: {
          201: OrgInviteAcceptedResponseSchema,
          ...errorResponses(400, 401, 409, 410, 500, 503),
        },
      },
    },
    acceptOrgInvite,
  );

  app.get(
    '/v1/org/invite/read',
    {
      config: { rbac: { access: 'service' } },
      schema: {
        tags: ['aggregator-orgs'],
        summary: 'Read an organisation invite for its registration page',
        description:
          'Checks the invite link without using it up and returns the invited email and the inviting org. Reached with the web BFF service-account token.',
        querystring: InviteReadQuerySchema,
        response: {
          200: InviteReadResponseSchema,
          ...errorResponses(400, 401, 409, 410, 503),
        },
      },
    },
    inviteReadHandler('org_owner'),
  );
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
 * Refuses an owner email that already owns an org, and an email or phone another account holds.
 *
 * @throws {HttpError} OWNER_ALREADY_REGISTERED, USER_EXISTS, PHONE_EXISTS or DB_UNAVAILABLE.
 */
async function assertOwnerFree(
  ownerEmail: string,
  phoneE164: string,
  email: string,
): Promise<void> {
  const existing = await getOrganisationStore().findByOwnerEmail(ownerEmail);
  if (!existing.ok) {
    throw httpError('DB_UNAVAILABLE', {
      cause: new Error(existing.error.message),
      fields: { sub_operation: 'orgStore.findByOwnerEmail' },
    });
  }
  if (existing.value) throw httpError('OWNER_ALREADY_REGISTERED', { fields: { email } });
  const contactClash = unwrapOrThrow(await findOwnerContactClash(ownerEmail, phoneE164));
  if (contactClash === 'email') throw httpError('USER_EXISTS', { fields: { email } });
  if (contactClash === 'phone') throw httpError('PHONE_EXISTS', { fields: { phone: phoneE164 } });
}

/**
 * Registers an organisation from an invite.
 *
 * The owner email must be the invited one. The org is created `pending` under
 * the inviting org with a Keycloak owner that is enabled, unverified and
 * `decision_made = invited`; the owner's first email sign-in activates it. The
 * invite is claimed before anything is created and given back if the
 * registration does not complete.
 *
 * @throws {HttpError} On any refusal; the error code names the reason.
 */
async function acceptOrgInvite(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const log = req.log.child({ operation: 'invite.org.accept' });
  const start = Date.now();
  await authenticateCaller(req);

  const body = req.body as z.infer<typeof OrgInviteAcceptBodySchema>;
  const { schemaValues, phoneE164 } = unwrapOrThrow(await checkOrgForm(body));
  const ownerEmail = body.owner.email.toLowerCase();
  const invite = await usableInvite(body.invite, 'org_owner');
  if (ownerEmail !== invite.email) throw httpError('INVITE_EMAIL_MISMATCH');

  const rl = await checkSubmitRate(`${req.ip}|${ownerEmail}`);
  if (!rl.allowed) {
    void reply.header('Retry-After', String(rl.retryAfterSeconds));
    throw httpError('RATE_LIMITED', {
      detail: `Retry in ${rl.retryAfterSeconds}s.`,
      fields: { retry_after_seconds: rl.retryAfterSeconds },
    });
  }
  await assertOwnerFree(ownerEmail, phoneE164, body.owner.email);

  await claimInvite(invite.jti);
  let committed = false;
  try {
    const orgConsent = stampConsent(body.consent);
    if (!orgConsent) {
      throw httpError('SCHEMA_VALIDATION', {
        detail: 'consent.valid_till must be in the future.',
        fields: { 'consent.valid_till': 'invalid' },
      });
    }
    const recordConsent = await orgConsentWriter({ consent: orgConsent, log });
    const { org, slug, groupId } = unwrapOrThrow(
      await createOrgWithOwner({
        form: body,
        schemaValues,
        phoneE164,
        ...(invite.org.isRoot ? {} : { parentId: invite.org.id }),
        createdBy: 'self',
        recordConsent,
        log,
      }),
    );
    committed = true;
    log.info(
      {
        status: 'success',
        latency_ms: Date.now() - start,
        org_id: org.id,
        slug,
        kc_group_id: groupId,
      },
      'invited org registered; awaiting owner email verification',
    );
    return reply.status(201).send({
      org_id: org.id,
      slug,
      status: 'pending',
      message: 'Organisation received. Sign in with the code we email you to finish.',
      login_hint: ownerEmail,
    });
  } finally {
    if (!committed) await releaseInvite(invite.jti, log);
  }
}
