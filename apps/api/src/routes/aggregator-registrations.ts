/**
 * Coordinator invite endpoints in `@aggregator-dpg/api`.
 *
 *   GET  /v1/user/invite/read     check an invite link for its registration page
 *   POST /v1/user/invite/accept   register the invited coordinator
 *
 * Accept validates the body with Zod and with `registration.v1.json` (Ajv),
 * normalises the phone to E.164, checks email and phone uniqueness in the
 * database and Keycloak, then inserts the coordinator (`pending`) and its
 * consent row in one transaction and creates its Keycloak user. Extra schema
 * fields go into `profile`.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  RegistrationPayloadSchema,
  type ConsentRecord,
} from '@aggregator-dpg/shared-primitives/aggregator';
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
import type { RecordConsentHook } from '../services/user-store/interface.js';
import { getOrganisationStore } from '../services/organisation-store/index.js';
import { checkSubmitRate } from '../services/submit-rate.js';
import { loadConsentConfig } from '@aggregator-dpg/config-loader/fs';
import { getConsentLedger } from '../services/consent-ledger/index.js';
import { resolveActiveNetwork } from '@aggregator-dpg/network-config/paths';
import {
  assertContactFree,
  checkCoordinatorForm,
  createCoordinatorWithLogin,
  ownLocations,
  type CheckedCoordinatorForm,
} from '../services/registration/coordinator-create.js';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';
import { unwrapOrThrow } from '../errors/unwrap.js';

const CoordinatorInviteAcceptBodySchema = RegistrationPayloadSchema.extend({
  invite: z.string().min(1).max(4096),
});

/** `201` of an invite accept: the account is pending until the email code is entered. */
const InviteAcceptedResponseSchema = z.object({
  aggregator_id: z.string(),
  org_slug: z.string(),
  status: z.literal('pending'),
  message: z.string(),
  /** The invited email, passed to the sign-in page so the invitee is not asked for it. */
  login_hint: z.string(),
});

export async function registerAggregatorRegistrationRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/v1/user/invite/accept',
    {
      config: { rbac: { access: 'service' } },
      schema: {
        tags: ['aggregator-registrations'],
        summary: 'Register a coordinator from an invite',
        description:
          'Creates the invited coordinator as `pending` with a Keycloak user that can sign in but holds no access yet. The email must be the invited address. The account becomes active when the invitee signs in with an email code and calls `POST /v1/user/activate`; no owner approval. Reached with the web BFF service-account token.',
        body: CoordinatorInviteAcceptBodySchema,
        response: {
          201: InviteAcceptedResponseSchema,
          ...errorResponses(400, 401, 409, 410, 500, 503),
        },
      },
    },
    acceptCoordinatorInvite,
  );

  app.get(
    '/v1/user/invite/read',
    {
      config: { rbac: { access: 'service' } },
      schema: {
        tags: ['aggregator-registrations'],
        summary: 'Read a coordinator invite for its registration page',
        description:
          'Checks the invite link without using it up and returns the invited email and the org it is for. Reached with the web BFF service-account token.',
        querystring: InviteReadQuerySchema,
        response: {
          200: InviteReadResponseSchema,
          ...errorResponses(400, 401, 409, 410, 503),
        },
      },
    },
    inviteReadHandler('coordinator'),
  );
}

type RegistrationPayload = z.infer<typeof RegistrationPayloadSchema>;
type RequestLog = ReturnType<FastifyRequest['log']['child']>;

/**
 * Checks a coordinator form, normalises its phone, stamps its consent and applies the submit rate limit.
 *
 * @param body - The parsed form, validated against the registration JSON Schema.
 * @returns The checked form, with its consent.
 * @throws {HttpError} SCHEMA_VALIDATION, INVALID_PHONE or RATE_LIMITED.
 */
async function checkCoordinatorSubmission(
  req: FastifyRequest,
  reply: FastifyReply,
  body: RegistrationPayload,
): Promise<CheckedCoordinatorForm & { consent: ConsentRecord }> {
  const checked = unwrapOrThrow(await checkCoordinatorForm(body, { consentRequired: true }));
  const { consent } = checked;
  // Unreachable: a required consent is never null.
  if (!consent) throw httpError('SCHEMA_VALIDATION', { fields: { consent: 'required' } });

  const rl = await checkSubmitRate(`${req.ip}|${checked.contact.email}`);
  if (!rl.allowed) {
    void reply.header('Retry-After', String(rl.retryAfterSeconds));
    throw httpError('RATE_LIMITED', {
      detail: `Retry in ${rl.retryAfterSeconds}s.`,
      fields: { retry_after_seconds: rl.retryAfterSeconds },
    });
  }
  return { ...checked, consent };
}

/**
 * Registers a coordinator from an invite.
 *
 * The email must be the invited one. The coordinator is created `pending`
 * with a Keycloak user that is enabled, unverified and `decision_made = invited`;
 * it is activated by `POST /v1/user/activate` after an email sign-in. The
 * invite is claimed before anything is created and given back if the
 * registration does not complete.
 *
 * @throws {HttpError} On any refusal; the error code names the reason.
 */
async function acceptCoordinatorInvite(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const log = req.log.child({ operation: 'invite.user.accept' });
  const start = Date.now();
  await authenticateCaller(req);

  const { invite: token, ...body } = req.body as z.infer<typeof CoordinatorInviteAcceptBodySchema>;
  const { contact, phoneE164, consent, domains } = await checkCoordinatorSubmission(
    req,
    reply,
    body,
  );
  const invite = await usableInvite(token, 'coordinator');
  if (contact.email !== invite.email) throw httpError('INVITE_EMAIL_MISMATCH');
  await assertNotOrgOwner(contact.email);
  assertNoOrgDetails(body);
  const locations = unwrapOrThrow(ownLocations(body));
  unwrapOrThrow(await assertContactFree(contact.email, phoneE164));

  await claimInvite(invite.jti);
  let committed = false;
  try {
    const recordConsent = await aggregatorConsentWriter({ consent, log });
    const {
      userId: aggregatorId,
      orgSlug,
      kcUserId: keycloakUserId,
    } = unwrapOrThrow(
      await createCoordinatorWithLogin({
        body,
        contact,
        domains,
        orgId: invite.org.id,
        createdBy: 'self',
        consent,
        recordConsent,
        inviteId: invite.jti,
        locations,
        log,
      }),
    );
    committed = true;
    log.info(
      {
        status: 'success',
        latency_ms: Date.now() - start,
        aggregator_id: aggregatorId,
        org_slug: orgSlug,
        keycloak_user_id: keycloakUserId,
      },
      'invited coordinator registered; awaiting email verification',
    );
    return reply.status(201).send({
      aggregator_id: aggregatorId,
      org_slug: orgSlug,
      status: 'pending',
      message: 'Registration received. Sign in with the code we email you to finish.',
      login_hint: contact.email,
    });
  } finally {
    if (!committed) await releaseInvite(invite.jti, log);
  }
}

/**
 * Refuses an email that already owns an organisation.
 *
 * @throws {HttpError} OWNER_ALREADY_REGISTERED.
 */
async function assertNotOrgOwner(email: string): Promise<void> {
  const ownerMatch = await getOrganisationStore().findByOwnerEmail(email);
  if (ownerMatch.ok && ownerMatch.value) {
    throw httpError('OWNER_ALREADY_REGISTERED', { fields: { email } });
  }
}

/**
 * Refuses `url`, which belongs to the coordinator's org.
 *
 * `locations` is the coordinator's own address and is accepted; see {@link ownLocations}.
 *
 * @throws {HttpError} ORG_DETAILS_READ_ONLY.
 */
function assertNoOrgDetails(body: RegistrationPayload): void {
  if (body.url?.trim()) {
    throw httpError('ORG_DETAILS_READ_ONLY', { fields: { fields: ['url'] } });
  }
}

/**
 * Builds the consent-ledger write that `store.create` runs inside its transaction.
 *
 * The consent config is read now, before the transaction. A failed ledger
 * write throws, so the store rolls back and answers `CONSENT_WRITE_FAILED`.
 *
 * @param consent - The server-stamped registration consent (`valid_till` is stored).
 * @param log - Request-scoped child logger.
 * @returns The hook to pass as `recordConsent`.
 * @throws {HttpError} CONSENT_WRITE_FAILED when the consent config cannot be read.
 */
async function aggregatorConsentWriter({
  consent,
  log,
}: {
  consent: ConsentRecord;
  log: RequestLog;
}): Promise<RecordConsentHook> {
  const { network, brand } = resolveActiveNetwork();
  let termsVersion: number;
  let privacyVersion: number;
  try {
    const consentCfg = await loadConsentConfig(network, brand);
    termsVersion = consentCfg.audiences.aggregator.documents.terms.current_version;
    privacyVersion = consentCfg.audiences.aggregator.documents.privacy.current_version;
  } catch (e) {
    log.error(
      {
        operation: 'consentLedger.recordAggregatorConsent',
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

  return async (executor, aggregatorId) => {
    const result = await getConsentLedger()
      .withExecutor(executor)
      .recordRegistrationConsent({
        subjectType: 'user',
        subjectId: aggregatorId,
        network,
        brand: brand ?? null,
        termsVersion,
        privacyVersion,
        validTill: new Date(consent.valid_till),
      });
    if (!result.success) {
      log.error(
        {
          operation: 'consentLedger.recordAggregatorConsent',
          status: 'failure',
          error: result.error.message,
          error_type: result.error.name,
          aggregator_id: aggregatorId,
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
