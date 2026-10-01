import { Injectable, Logger } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';
import { decrypt } from './crypto';
import { SettingsService } from './settings.service';

export interface Mail { to: string | string[]; subject: string; html: string; attachments?: { filename: string; content: Buffer; contentType?: string }[] }

/** SMTP per company (Settings › smtp). Without a host, mail is logged instead of sent (dev). */
@Injectable()
export class MailerService {
  private log = new Logger('Mailer');
  private transports = new Map<string, { key: string; t: Transporter }>();
  constructor(private settings: SettingsService) {}

  async send(companyId: string, m: Mail): Promise<boolean> {
    const cfg = await this.settings.get(companyId, 'smtp');
    if (!cfg.host) {
      this.log.log(`[no SMTP] to=${m.to} subject="${m.subject}"`);
      return false;
    }
    const key = JSON.stringify(cfg);
    let entry = this.transports.get(companyId);
    if (!entry || entry.key !== key) {
      entry = { key, t: nodemailer.createTransport({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.user ? { user: cfg.user, pass: cfg.pass ? decrypt(cfg.pass) : '' } : undefined }) };
      this.transports.set(companyId, entry);
    }
    await entry.t.sendMail({ from: cfg.from, ...m });
    return true;
  }
}
