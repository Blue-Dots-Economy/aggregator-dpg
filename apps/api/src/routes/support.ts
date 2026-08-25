/**
 * Contact-support endpoints (post-login).
 *
 *   GET  /v1/support/config → whether SUPPORT_EMAIL is set, plus the attachment
 *                             limits and accepted content types (#551).
 *   POST /v1/support        → emails the submission to SUPPORT_EMAIL, with any
 *                             attached image/video/audio files.
 *
 * Any authenticated coordinator may submit — approval status is
 * intentionally not required (an aggregator awaiting approval may still
 * need to contact support). Belongs to `@aggregator-dpg/api`.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, type AuthContext } from '../services/auth/access-token.js';
import { getMailer } from '@aggregator-dpg/mailer';
import {
  renderSupportRequest,
  generateSupportReference,
  getEmailBrand,
} from '../services/email-templates/index.js';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';
import { supportEmail, supportCc, supportPortalLink, supportAttachmentLimits } from '../config.js';
import { checkSupportRate } from '../services/support-rate.js';
import {
  SUPPORT_ALLOWED_CONTENT_TYPES,
  SUPPORT_ALLOWED_EXTENSIONS,
  supportBodyLimitBytes,
  validateSupportAttachments,
} from '../services/support-attachments.js';

const SupportRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    email: z.string().email().max(320).optional(),
    phone: z.string().min(3).max(20).optional(),
    type: z.enum(['complaint', 'support_request']),
    details: z.string().trim().min(1).max(5000),
    consent: z.literal(true),
    // Count/size/type limits are applied in the handler by
    // validateSupportAttachments so each rejection carries its own error code
    // and a detail naming the offending file (#551).
    attachments: z
      .array(
        z.object({
          filename: z.string().min(1).max(255),
          contentType: z.string().min(1).max(127),
          /** Base64, no `data:` prefix. */
          data: z.string().min(1),
        }),
      )
      .optional(),
  })
  .strict()
  // At least one contact channel is required so support can reply. A failed
  // refine surfaces as a 400 SCHEMA_VALIDATION envelope via the global error
  // handler (see app.ts), consistent with every other zod body rejection.
  .refine((body) => Boolean(body.email) || Boolean(body.phone), {
    message: 'Provide at least one of email or phone so support can reach you.',
    path: ['email'],
  });

/**
 * Registers the contact-support routes on the given Fastify instance.
 *
 * @param app - The Fastify instance to attach routes to.
 */
export async function registerSupportRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/v1/support/config',
    {
      schema: {
        tags: ['support'],
        summary: 'Whether the contact-support form is enabled',
        description:
          'Reports whether SUPPORT_EMAIL is configured on this instance, plus the attachment limits and accepted content types. The web app hides the "Contact support" entry point when disabled, and validates files against these limits before uploading them.',
        security: [{ bearerAuth: [] }],
        response: {
          200: z.object({
            enabled: z.boolean(),
            maxTotalBytes: z.number().int().positive(),
            maxFiles: z.number().int().positive(),
            allowedTypes: z.array(z.string()),
            /** Picker hint only — validation is MIME-based. */
            allowedExtensions: z.array(z.string()),
          }),
          ...errorResponses(401),
        },
      },
    },
    async (req, reply) => {
      await requireAuth(req);
      // Limits are served rather than duplicated in the web bundle, so the
      // form's validation cannot disagree with this API's.
      const limits = supportAttachmentLimits();
      return reply.send({
        enabled: Boolean(supportEmail()),
        maxTotalBytes: limits.maxTotalBytes,
        maxFiles: limits.maxFiles,
        allowedTypes: [...SUPPORT_ALLOWED_CONTENT_TYPES],
        allowedExtensions: [...SUPPORT_ALLOWED_EXTENSIONS],
      });
    },
  );

  app.post(
    '/v1/support',
    {
      schema: {
        tags: ['support'],
        summary: 'Send a contact-support message',
        description:
          'Emails the submitted complaint/support request to SUPPORT_EMAIL (and SUPPORT_CC_EMAIL when set), with Reply-To set to the submitter email so support can reply directly. Each submission carries a SUP-YYYYMMDD-XXXXXX reference.',
        security: [{ bearerAuth: [] }],
        body: SupportRequestSchema,
        response: {
          201: z.object({ ok: z.boolean(), reference: z.string() }),
          ...errorResponses(400, 401, 429, 502, 503),
        },
      },
      // Fastify's 1MB default would reject any attachment submission (base64
      // inflates a 5MB file to ~6.7MB). Derived from the configured budget so
      // raising the cap cannot turn into a silent 413; other routes keep 1MB.
      bodyLimit: supportBodyLimitBytes(supportAttachmentLimits().maxTotalBytes),
    },
    async (req, reply) => {
      const auth = await requireAuth(req);
      const log = req.log.child({ operation: 'support.submit', actor: auth.userId });
      const start = Date.now();

      const recipient = supportEmail();
      if (!recipient) {
        throw httpError('SUPPORT_NOT_CONFIGURED');
      }

      // Validated by the route's `body` zod schema. Use the SUBMITTED
      // name/email/phone — the web form prefills them from the session but
      // lets the coordinator correct them before sending.
      const { name, email, phone, type, details, attachments } = req.body as z.infer<
        typeof SupportRequestSchema
      >;

      // Per-coordinator cap, counted BEFORE the body is validated, deliberately.
      // Fastify (and the BFF proxy ahead of it) has already buffered and parsed
      // the payload by the time this runs, so a rejected submission has cost the
      // same as an accepted one — if only accepted ones counted, a caller could
      // post oversized rubbish (a fourth file, a disallowed content type) without
      // limit and never spend a slot. The web form validates the same rules before
      // submitting, so a legitimate coordinator does not reach here with an
      // invalid body.
      //
      // Still after the 503: an instance with no support address should not burn
      // anyone's quota. The limiter fails open on a Redis error — an outage must
      // not silence a complaint.
      const rate = await checkSupportRate(auth.userId);
      if (!rate.allowed) {
        throw httpError('RATE_LIMITED', {
          detail: 'Too many support submissions; please try again later.',
          fields: { retryAfterSeconds: rate.retryAfterSeconds },
        });
      }

      const checked = validateSupportAttachments(attachments, supportAttachmentLimits());
      if (!checked.ok) {
        throw httpError(checked.error, { detail: checked.detail });
      }

      const reference = generateSupportReference();
      const rendered = renderSupportRequest({
        type,
        name,
        email: email ?? null,
        phone: phone ?? null,
        details,
        reference,
        link: supportPortalLink(),
        // Brand short-name seeded from config-loader at server boot
        // (setEmailBrand); falls back to the generic default under test.
        teamName: getEmailBrand().short_name,
        submittedAt: new Date(),
        attachments: checked.attachments.map(({ filename, bytes }) => ({ filename, bytes })),
      });

      const cc = supportCc();
      const sent = await getMailer().send({
        to: recipient,
        ...(cc ? { cc } : {}),
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        ...(email ? { replyTo: email } : {}),
        ...(checked.attachments.length
          ? {
              attachments: checked.attachments.map(({ filename, contentType, content }) => ({
                filename,
                contentType,
                content,
              })),
            }
          : {}),
      });

      if (!sent.ok) {
        log.error({
          status: 'failure',
          latency_ms: Date.now() - start,
          error: sent.error.message,
          error_type: sent.error.code,
          reference,
        });
        throw httpError('SUPPORT_SEND_FAILED', { cause: new Error(sent.error.message) });
      }

      log.info({
        status: 'success',
        latency_ms: Date.now() - start,
        aggregator_id: auth.aggregatorId,
        reference,
        attachment_count: checked.attachments.length,
        attachment_bytes: checked.attachments.reduce((sum, a) => sum + a.bytes, 0),
      });
      return reply.code(201).send({ ok: true, reference });
    },
  );
}

/** Unwrap the auth context or throw the catalogue error. Mirrors the local helper in other route modules (e.g. `dashboard.ts`, `aggregator-profile.ts`). */
async function requireAuth(req: FastifyRequest): Promise<AuthContext> {
  const result = await authenticate(req);
  if (result.ok) return result.context;
  const code = result.error.code === 'MISSING_AGGREGATOR_ID' ? 'FORBIDDEN' : 'UNAUTHORIZED';
  throw httpError(code, {
    detail: result.error.message,
    fields: { reason: result.error.code },
  });
}
