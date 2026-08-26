/**
 * AWS SES v2-backed mailer.
 *
 * Used in deployments where the operator prefers SES over generic SMTP.
 * Authentication uses the standard AWS SDK credential chain (env vars,
 * shared profile, IAM role on EC2/ECS/Lambda).
 */

import { createRequire } from 'node:module';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { MailerAdapter, type MailerResult, type SendInput, type SendOk } from './interface.js';

// MailComposer is nodemailer's MIME builder, reused here rather than
// hand-rolling multipart boundaries and header encoding. Required through
// createRequire for the same reason smtp.ts does it: nodemailer ships CJS.
const require = createRequire(import.meta.url);
type MailComposerCtor = new (options: Record<string, unknown>) => {
  compile(): { build(callback: (err: Error | null, message: Buffer) => void): void };
};
const MailComposer: MailComposerCtor = require('nodemailer/lib/mail-composer');

/**
 * Builds the RFC-5322 message for the raw SES path. Addresses go into the MIME
 * headers as well as SES's `Destination` so the recipient sees a normal
 * To/Cc/Reply-To, not a blind message.
 */
async function buildRawMime(input: {
  from: string;
  to: string[];
  cc: string[];
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  attachments?: Array<{ filename: string; contentType: string; content: Buffer }>;
}): Promise<Uint8Array> {
  const composer = new MailComposer({
    from: input.from,
    to: input.to,
    ...(input.cc.length ? { cc: input.cc } : {}),
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    subject: input.subject,
    html: input.html,
    text: input.text,
    attachments: input.attachments,
  });

  return new Promise<Uint8Array>((resolve, reject) => {
    composer.compile().build((err, message) => {
      if (err) reject(err);
      else resolve(new Uint8Array(message));
    });
  });
}

/**
 * Normalises a recipient value to a list of individual addresses. Accepts an
 * array, a single address, or a comma-separated string (each entry trimmed,
 * blanks dropped) — SES requires individual addresses, unlike SMTP.
 *
 * @param value - One address, a comma-separated string, or an array.
 * @returns The individual, trimmed, non-empty addresses.
 */
function toAddressList(value: string | string[]): string[] {
  return (Array.isArray(value) ? value : value.split(','))
    .map((address) => address.trim())
    .filter(Boolean);
}

export interface SesMailerOptions {
  region: string;
  from: string;
  /** Optional SES configuration set for tracking, suppression list, etc. */
  configurationSetName?: string;
  /** Inject a pre-built client (tests). */
  client?: SESv2Client;
}

export class SesMailer extends MailerAdapter {
  private readonly client: SESv2Client;
  private readonly from: string;
  private readonly configurationSetName: string | undefined;

  constructor(opts: SesMailerOptions) {
    super();
    this.client = opts.client ?? new SESv2Client({ region: opts.region });
    this.from = opts.from;
    this.configurationSetName = opts.configurationSetName;
  }

  async send(input: SendInput): Promise<MailerResult<SendOk>> {
    // SES expects an array of individual addresses; a comma-joined string
    // (how the support config surfaces multiple recipients) would otherwise
    // be treated as one invalid RFC-5321 address and rejected. Normalise
    // string | string[] to a trimmed list here so multi-recipient TO/CC work.
    const ccAddresses = input.cc ? toAddressList(input.cc) : [];
    const from = input.from ?? this.from;
    const toAddresses = toAddressList(input.to);

    // Inside the try, with the send: `buildRawMime` awaits MailComposer, which
    // can reject on pathological input. Outside, that rejection would escape
    // `send()` instead of becoming a MailerResult — breaking the "adapters
    // return Result, never throw across the boundary" rule, and surfacing as a
    // 500 INTERNAL instead of the 502 SUPPORT_SEND_FAILED the caller expects.
    try {
      // SES's Simple content has no attachment field at all, so an
      // attachment-bearing message must be sent as raw MIME (#551). Only that
      // case takes the raw path; everything else keeps the well-tested Simple
      // one, since raw MIME means we own header construction.
      const content = input.attachments?.length
        ? {
            Raw: { Data: await buildRawMime({ ...input, from, to: toAddresses, cc: ccAddresses }) },
          }
        : {
            Simple: {
              Subject: { Data: input.subject, Charset: 'UTF-8' },
              Body: {
                Html: { Data: input.html, Charset: 'UTF-8' },
                Text: { Data: input.text, Charset: 'UTF-8' },
              },
            },
          };

      const command = new SendEmailCommand({
        FromEmailAddress: from,
        // Kept for the raw path too: SES uses Destination as the envelope
        // recipients, and relying on the MIME headers alone would drop CCs on
        // some configurations.
        Destination: {
          ToAddresses: toAddresses,
          ...(ccAddresses.length ? { CcAddresses: ccAddresses } : {}),
        },
        ...(input.replyTo ? { ReplyToAddresses: [input.replyTo] } : {}),
        ...(this.configurationSetName ? { ConfigurationSetName: this.configurationSetName } : {}),
        Content: content,
      });

      const out = await this.client.send(command);
      return {
        ok: true,
        value: { messageId: out.MessageId ?? '' },
      };
    } catch (err) {
      const e = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
      let code: 'AUTH_FAILED' | 'INVALID_RECIPIENT' | 'TRANSPORT_FAILED' = 'TRANSPORT_FAILED';
      if (e.name === 'AccessDeniedException' || e.name === 'NotAuthorizedException') {
        code = 'AUTH_FAILED';
      } else if (e.name === 'MailFromDomainNotVerifiedException' || e.name === 'MessageRejected') {
        code = 'INVALID_RECIPIENT';
      }
      return {
        ok: false,
        error: { code, message: `SES ${e.name ?? 'error'}: ${e.message ?? 'send failed'}` },
      };
    }
  }
}
