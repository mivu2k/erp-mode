# ERP Platform

Modular, multi-branch ERP: Admin/Core, HRM (attendance kiosks, leave, tasks, payroll), Finance (double-entry, advances, expense claims), Inventory & Purchase, Repair/Service, Fleet, Gatepass & Demo, Report Builder.

## Run locally

```bash
cp .env.example .env
docker compose up -d mysql minio
pnpm install
pnpm exec prisma migrate deploy
pnpm db:seed                     # admin@erp.local / Admin@12345
pnpm --filter @erp/shared build
pnpm --filter api dev            # http://localhost:4000/api/docs (Swagger)
pnpm --filter web dev            # http://localhost:3000
```

Everything in Docker: `docker compose --profile full up --build`.

After seeding: **Admin › Settings** holds every business rule (system GL accounts, payroll rules, job-status transitions, discount limit, file limits). **Admin › Workflows** holds approval chains. Nothing is hard-coded.

## Tests

| Command | What |
|---|---|
| `pnpm -r test` | unit tests: money math, numbering, attendance, payroll, settlement, RBAC scopes, workflow matching, TOTP, crypto, CSV, reports |
| `pnpm test:api-e2e` | full business flow across all modules against a running API |
| `pnpm test:ui` | Playwright: login, generic form/list/grid/search, approval inbox, dark mode, permissions, reports |

## How it's built

```
apps/api      NestJS. engine/ = generic resource engine; modules/ = domain logic only
apps/web      Next.js. One generic list + record screen serves every module
apps/mobile   Capacitor shell around the web app
packages/shared  resource registry, permissions, Zod schemas, pure business math
packages/ui      design system: ThemeProvider, DataView, forms, badges, charts
prisma/schema    one .prisma file per module
```

**Adding a screen** = a Prisma model + one entry in `packages/shared/src/registry.ts`. That gives you CRUD API, validation, RBAC with data scopes, audit log, soft delete/restore, global search, list/grid/kanban UI, filters, saved views, CSV/XLSX/print export, A4/POS print, attachments, comments, custom fields, approval workflow and report-builder access. Domain behaviour is added with hooks (`hooks.on('module.resource', { beforeCreate, onApproved, … })`) or a small controller.

**Adding a module** = the above plus a `MODULES` entry; it appears in menus, the permission matrix and module toggles automatically.

See `docs/decisions.md` for the architectural decisions and known limits.
