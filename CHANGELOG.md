# Changelog

## 0.5.0 — advances, loans & payment approval
- Salary advances / loans are a separate screen (Finance › Salary Advances & Loans, LOAN-numbers, own approval chain: manager → HR → accounts); expense advances only show expense fields.
- Payment vouchers: disbursing an advance/loan and reimbursing/settling a claim now create a voucher that needs its own approval (Accounts; + Director from 50,000) before any posting. Rejected voucher returns the document to "approved". Vouchers show the claim settlement split and print with signature lines.
- Maker-checker: nobody can approve their own request (approval-manage override for admins).
- Login rate limit configurable (LOGIN_RATE_LIMIT, default 10/min/IP).

## 0.4.0 — comms-equipment workshop, payables & receivables
- Repair module retargeted to radios, cameras, gateways and military comms hardware: asset tag, firmware, frequency band, crypto-keys-zeroized flag, accessory chips, fault quick-picks, QC bench test (RF power, RX sensitivity, frequency error, VSWR, audio, firmware) — a unit cannot be marked Ready without a passing test; failed test returns it to repair. Scan by asset tag.
- Fleet maintenance jobs moved to their own screen (Fleet › Maintenance Jobs) via resource `scope`; they no longer appear in Repair.
- Payables & Receivables: manual dues (monthly repeat), ledger posting, partial payments, one timeline with invoices and vendor bills.
- Fix: module hooks ran twice (double journal postings for cash transfers, duplicate fuel claims/notifications).
- Prints: Yes/No, readable dates, comma lists, no zero/No noise; QC block on job slips.

## 0.3.0 — remaining brief items
- Dashboard builder: saved-report widgets (bar / table / KPI), drag to reorder, share with a role; first dashboard shows on Home.
- Calendar view in every DataView with a date field (tasks, jobs, leave, attendance, trips).
- Custom fields now appear as list columns, filters (JSON-path queries) and exports, not just forms.
- Stopwatch time tracking on repair jobs and tasks.
- Stock count (physical count posts only the difference).
- CSV exports stream page by page (no row limit).
- SMS/WhatsApp notifications via a configurable webhook (Settings › sms), per-user opt-in.
- English / Urdu UI switch with RTL layout, per-user language preference.
- `scripts/backup.sh` (mysqldump + MinIO mirror, retention) for host cron.

## 0.2.0 — jobs, email, PDF, realtime, workflow extras
- Background job runner (MySQL advisory locks, no Redis): email outbox, approval escalation, nightly run (attendance auto-processing, recurring tasks, overdue tasks, expiry/license/probation reminders, overdue gatepasses, aged advances, low stock, scheduled report emails). Admin › Background jobs page with "Run now".
- SMTP email per company (encrypted password), per-user email opt-out.
- Server-side PDF (headless Chromium) for every printable record, list export and report: `?format=pdf`.
- Live notifications via Server-Sent Events.
- Workflow: parallel "all must approve" steps, approval delegation (self-service), time-based escalation.
- Recurring tasks (daily/weekly/monthly) generate occurrences automatically.
- Removed Redis from docker-compose; API image ships Chromium.

## 0.1.0 — all phases, first cut
- **Foundation**: monorepo (pnpm + Turborepo), Docker Compose, multi-file Prisma schema (70 models), JWT + rotating refresh with reuse detection, TOTP 2FA, password reset, lockout, sessions/force-logout, RBAC with data scopes + field restrictions + module toggles, audit log with diffs, soft delete/restore, numbering sequences, global search + barcode/QR/serial scan, attachments (MinIO presigned), in-app notifications, CSV/XLSX/print exports, A4/POS/label/ID-card printing.
- **Core/Admin**: company, branding (live theme + documents), branches, departments, designations, cost centers, users, roles, permission matrix, clone role, module toggles, master data, workflows + approval inbox, settings, custom fields, templates, audit, admin dashboard.
- **HRM**: employees (auto ledger account, user linking, ID card), documents, lifecycle events, shifts, kiosk stations (pairing, device tokens, IP whitelist, NFC/QR/rotating QR, offline queue), mobile GPS punch, import, daily processing, corrections, leave types/balances/requests, tasks (kanban, performance), daily reports, salary structures, payroll (attendance, overtime, unpaid leave, advance installments) → approval → ledger → partial payments, bank sheet.
- **Finance**: chart of accounts, cash in/transfers, advances (expense/salary, installments), expense claims (direct / against advance with settlement), payments, statements (employee/customer/vendor), account ledger, trial balance, advance aging.
- **Inventory/Purchase**: products, warehouses, stock levels, movements, serials, weighted average cost, adjustments/transfers with approval, low stock, valuation, requisitions → PO → GRN (serials, job notification) → bills → payments, purchase returns, vendor performance.
- **Repair**: collective intake → job per device, encrypted device passwords, configurable status transitions, assignment, diagnosis → versioned quotations, discount approval, customer decision, part reservation/issue/return, invoices (labor/parts/tax + COGS), payments, delivery orders, credit notes/refunds, comebacks with warranty, public tracking page, dashboard.
- **Fleet**: vehicles, trips, fuel logs (auto expense claim), events, maintenance on the repair job engine, cost of ownership, dashboard.
- **Gatepass**: all types, approval, guard check-out/in, partial returns, demo tracking, convert demo to sale, overdue report, serial history.
- **Reports**: safe report builder (group/aggregate/calc/params), saved + shared reports, 13 prebuilt reports, exports.
- **Mobile**: Capacitor shell; **CI/CD**: GitHub Actions (validate, drift, typecheck, tests, build, e2e, images, staged deploy), Android build workflow.
