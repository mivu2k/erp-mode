import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from './prisma.service';

/** Every tunable business value lives here (overridable per company in the Setting table). */
export const DEFAULT_SETTINGS = {
  /** System account ids used by automatic postings; filled by seed, editable in Admin. */
  'finance.accounts': {
    cash: '', advances: '', receivable: '', payable: '', inventory: '', cogs: '', laborIncome: '', partsIncome: '',
    salesTax: '', salesReturns: '', salaryExpense: '', salaryPayable: '', deductionsPayable: '', directorCapital: '',
  } as Record<string, string>,
  /** receiptThreshold: lines above this need a receipt before submitting; 0 = receipts always optional. */
  'finance.claims': { receiptThreshold: 0 },
  /** Invoices are due this many days after their date (credit terms) — drives the P&R timeline, aging and forecast. */
  'finance.terms': { invoiceDays: 15 },
  'hrm.payroll': { workingDays: 30, hoursPerDay: 8, overtimeMultiplier: 1.5, halfDayFactor: 0.5 },
  'hrm.kiosk': { rotatingQrSeconds: 30 },
  'inventory.allowNegative': false,
  /**
   * Company introduction used by Catalog brochures and presentations. Text fields are one entry per line:
   * highlights "Label: value", locations "Name | address | phone | email", certifications one per line.
   */
  'catalog.about': { intro: '', mission: '', highlights: '', certifications: '', locations: '', photo: '', customCss: '', customHtml: '' },
  /** Sale warranty for serialised units when the product doesn't set its own warranty months. */
  'serials': { defaultWarrantyMonths: 12 },
  'repair.discountLimit': 0,
  /** Allowed job status transitions. `*` = from any status. */
  'repair.transitions': {
    received: ['assigned', 'diagnosing', 'diagnosed', 'returned_unrepaired'],
    assigned: ['diagnosing', 'diagnosed', 'returned_unrepaired'],
    diagnosing: ['diagnosed', 'not_repairable', 'rma'],
    diagnosed: ['quotation_sent', 'approved', 'declined', 'not_repairable'],
    quotation_sent: ['approved', 'declined'],
    approved: ['parts_pending', 'in_repair'],
    parts_pending: ['in_repair', 'rma'],
    in_repair: ['qc', 'parts_pending', 'not_repairable'],
    qc: ['ready', 'in_repair'],
    ready: ['delivered'],
    rma: ['in_repair', 'ready', 'returned_unrepaired'],
    declined: ['returned_unrepaired', 'delivered'],
    not_repairable: ['returned_unrepaired', 'delivered'],
    returned_unrepaired: ['delivered'],
    delivered: ['closed'],
  } as Record<string, string[]>,
  'fleet.fuelHeadId': '',
  /** Upload limits; types are checked against the file's real bytes (image/jpeg|png|gif|webp, pdf, Office, csv/txt). */
  'files': { maxMb: 20, types: ['image/', 'application/pdf', 'application/vnd', 'application/msword', 'text/csv', 'text/plain'] },
  'auth': { maxFailed: 5, lockMinutes: 15 },
  /** SMS / WhatsApp gateway: POST {to, text} JSON with Bearer token to your provider or bridge. */
  'sms': { webhookUrl: '', token: '' },
  'smtp': { host: '', port: 587, secure: false, user: '', pass: '', from: 'ERP <no-reply@example.com>' },
  /** Background jobs: local hour (company timezone) for the nightly run and reminder thresholds. */
  'jobs': { nightlyHour: 1, expiryReminderDays: [30, 7, 1, 0], advanceAlertDays: 30, autoProcessAttendance: true },
};
export type SettingKey = keyof typeof DEFAULT_SETTINGS;

@Injectable()
export class SettingsService {
  // ponytail: per-process cache, 60s TTL; move to Redis when running >1 API instance and staleness matters
  private cache = new Map<string, { v: unknown; at: number }>();
  constructor(private prisma: PrismaService) {}

  async get<K extends SettingKey>(companyId: string, key: K): Promise<(typeof DEFAULT_SETTINGS)[K]> {
    const ck = `${companyId}:${key}`;
    const hit = this.cache.get(ck);
    if (hit && Date.now() - hit.at < 60_000) return hit.v as (typeof DEFAULT_SETTINGS)[K];
    const row = await this.prisma.setting.findUnique({ where: { companyId_key: { companyId, key } } });
    const def = DEFAULT_SETTINGS[key];
    const v = row ? (isObj(def) && isObj(row.value) ? { ...(def as object), ...row.value } : row.value) : def;
    this.cache.set(ck, { v, at: Date.now() });
    return v as (typeof DEFAULT_SETTINGS)[K];
  }

  async set(companyId: string, key: string, value: unknown) {
    const v = value as Prisma.InputJsonValue;
    await this.prisma.setting.upsert({ where: { companyId_key: { companyId, key } }, update: { value: v }, create: { companyId, key, value: v } });
    this.clear();
  }

  clear() {
    this.cache.clear();
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
