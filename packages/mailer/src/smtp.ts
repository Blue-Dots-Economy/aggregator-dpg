/**
 * SMTP-backed mailer using nodemailer.
 *
 * Works with MailHog in dev and any standard SMTP server in production.
 * Each adapter instance holds one pooled nodemailer transport.
 */

import { createRequire } from 'node:module';
import type { Transporter, SendMailOptions } from 'nodemailer';
import { MailerAdapter, type MailerResult, type SendInput, type SendOk } from './interface.js';
import { numberProp, stringProp } from './thrown.js';

const require = createRequire(import.meta.url);
type NodemailerCreateTransport = (opts: unknown) => Transporter;
const createTransport: NodemailerCreateTransport =
  require('nodemailer').default?.createTransport ?? require('nodemailer').createTransport;

export interface SmtpMailerOptions {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  from: string;
  /** Use STARTTLS or TLS. Default `false` (MailHog has no TLS). */
  secure?: boolean;
}

export class SmtpMailer extends MailerAdapter {
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(opts: SmtpMailerOptions) {
    super();
    this.from = opts.from;
    this.transporter = createTransport({
      host: opts.host,
      port: opts.port,
      secure: opts.secure ?? false,
      ...(opts.user && opts.pass ? { auth: { user: opts.user, pass: opts.pass } } : {}),
      // Small pool so concurrent sends reuse connections.
      pool: true,
      maxConnections: 3,
    });
  }

  async send(input: SendInput): Promise<MailerResult<SendOk>> {
    const message: SendMailOptions = {
      from: input.from ?? this.from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      ...(input.cc ? { cc: input.cc } : {}),
      // nodemailer accepts SendAttachment as is.
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    };
    try {
      const info = await this.transporter.sendMail(message);
      return { ok: true, value: { messageId: info.messageId } };
    } catch (err) {
      const code = mapSmtpError(err);
      return {
        ok: false,
        error: { code, message: stringProp(err, 'message') ?? 'smtp send failed' },
      };
    }
  }

  /** Closes the underlying transport. Call from process shutdown. */
  async close(): Promise<void> {
    this.transporter.close();
  }
}

function mapSmtpError(err: unknown): 'AUTH_FAILED' | 'INVALID_RECIPIENT' | 'TRANSPORT_FAILED' {
  if (stringProp(err, 'code') === 'EAUTH') return 'AUTH_FAILED';
  const responseCode = numberProp(err, 'responseCode');
  if (responseCode === 550 || responseCode === 553) return 'INVALID_RECIPIENT';
  return 'TRANSPORT_FAILED';
}
