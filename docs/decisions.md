# Architecture Decisions

## ADR-001 Password hashing with Node `scrypt`
Stdlib, no native build (bcrypt/argon2 need node-gyp). Format `scrypt$salt$hash` allows migration.

## ADR-002 Refresh tokens
Opaque 48-byte tokens stored as SHA-256. Each login starts a family; refresh rotates within it. A reused (revoked) token revokes the family. Web: httpOnly `SameSite=strict` cookie scoped to `/api/auth`, served same-origin through the Next.js rewrite (CSRF-safe without a token). Mobile: body.

## ADR-003 RBAC evaluated per request
Guard loads role permissions (widest scope per key wins) and disabled modules. Role changes apply immediately. `scopeWhere()` narrows every query to own/department/branch/all. If a model lacks the branch/department column, scope degrades to the owner rule and never widens. Ceiling: 4 small queries per request. Add a Redis cache keyed by user when needed.

## ADR-004 Generic resource engine driven by Prisma DMMF + a registry
Field types, required fields and validation (Zod) are derived from the Prisma schema at runtime. `registry.ts` adds only presentation and policy. One engine gives every module CRUD, scoping, cross-tenant FK checks, numbering, audit diffs, search indexing, exports, printing and workflow. Domain logic lives in hooks and small controllers. Trade-off: less explicit per-module OpenAPI schemas (Swagger lists the generic routes).

## ADR-005 Money in DECIMAL(18,2), maths in integer minor units
All calculations (`packages/shared/src/calc.ts`) convert to paisa integers. The ledger refuses unbalanced journals to the paisa.

## ADR-006 Double-entry ledger as the single financial truth
Every money movement (cash in, advances, claims, payroll, GRN, invoices, payments, refunds, stock adjustments, COGS) posts a balanced journal. System accounts are configurable in `finance.accounts`. Each employee/director gets a personal sub-ledger account on creation. Employee, customer and vendor statements are queries over journal lines.

## ADR-007 Inventory: weighted average, per-level row locks
`SELECT … FOR UPDATE` on StockLevel serializes concurrent moves. Serialized items move one serial at a time. Negative stock is blocked unless enabled in settings. FIFO is a later option.

## ADR-008 Workflow engine
Definitions per resource with conditions (amount range, branch, department, field equals) and sequential steps (role, user, reporting manager, department head). No match means auto-approve. `onApproved` hooks run in the same transaction.
- **Parallel sign-off:** `mode: 'all'` on a step requires every approver of the step. A delegate's approval counts for the person they cover.
- **Delegation:** users set `delegateToId` / `delegateUntil` on their account page. Delegates see and act on the delegator's approvals.
- **Escalation:** `escalateAfterHours` + `escalateToRoleId`. Once overdue, that role is notified (by the 15-minute job) and can decide the step alone.

## ADR-009 One print template for every document
HTML with branding, QR (bwip-js) and barcode, sized A4 / 80mm / 58mm via CSS `@page`. Admins can override per resource with a Template (`{{field}}` placeholders). `?format=pdf` renders the same HTML to PDF with headless Chromium (playwright-core, `CHROME_PATH`), one shared browser. Without `CHROME_PATH` the API answers 503 and users fall back to Print → Save as PDF.

## ADR-010 Reports: whitelisted, parameterized, no raw SQL
Report builder runs Prisma `findMany`/`groupBy` over registry resources only. Field restrictions and data scopes apply. Calculated columns are limited to `a op b`. Hard 5,000-row limit and 10,000 for list exports; beyond that needs async export jobs.

## ADR-011 Frontend: native platform over libraries
`<dialog>`, `<details>` menus, `BarcodeDetector` (camera scan), Web NFC (Android), USB scanners as keyboard wedge, native date inputs. shadcn/Radix, TanStack Table, React Hook Form, next-intl and @zxing are not used. The generic DataView/FormGrid replace per-screen tables and forms. Tokens use shadcn names, so shadcn components can be dropped in later. RTL via logical CSS properties. i18n: a small `I18nProvider` in `@erp/ui` translates UI chrome (English/Urdu) and sets `dir`/`lang`. Record data and field labels stay as entered. Add languages by adding a dictionary.

## ADR-012 Background jobs on MySQL, not BullMQ/Redis
Every API instance ticks every 60s. `GET_LOCK` (held on a pinned transaction connection) makes sure one instance runs each job, and last-run state lives in `Setting` rows. Every job is idempotent. Jobs:
- **outbox**, every minute: notifications are emailed, retried up to 5 times.
- **escalation**, every 15 minutes.
- **nightly**, per company after `jobs.nightlyHour` local time: attendance for yesterday, recurring and overdue tasks, document/license/probation expiry reminders, overdue gatepasses, aged advances, low stock, scheduled report emails (Excel, run as the report owner so their data scope applies).

Admin › Background jobs shows status and can run a job now. This removes Redis from the stack. Switch to BullMQ if jobs need fan-out, priorities or run longer than minutes.

**Email:** nodemailer with per-company SMTP (`Settings › smtp`, password AES-encrypted at rest and masked in the API). **Realtime:** in-app notifications push over Server-Sent Events (`/notifications/stream`), which also works through the Next.js proxy. The web app falls back to a 5-minute poll.

**SMS/WhatsApp:** the same outbox POSTs `{to, text}` to `Settings › sms.webhookUrl` (Bearer token) for users who opted in. Point it at your provider or a small bridge.
**Exports:** CSV streams page by page with no row limit. XLSX/PDF are built in memory, capped at 10k rows.
**Backups:** `scripts/backup.sh` from host cron.
**Still not built:** native mobile push (needs FCM/APNs credentials; plug into the outbox like SMS).

## ADR-013 Multi-file Prisma schema
`prisma/schema/*.prisma`, one file per module. Migrations live in `prisma/schema/migrations`.
