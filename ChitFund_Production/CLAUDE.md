# ChitFund Production — Claude Context

## What this is
A TypeScript + Express + Drizzle ORM + PostgreSQL backend API for managing chit fund groups. A chit fund is a rotating savings scheme: members pool monthly contributions, one member wins the pot each month via a bid/auction.

## Stack
**Backend**
- Node.js + TypeScript (`tsx` for dev, `tsc` for build)
- Express 4, all routes under `/v1`
- Drizzle ORM with `postgres` driver
- Zod validation, JWT + bcrypt auth
- Vitest + Supertest for integration tests

**Frontend** (`client/`)
- React 19 + TypeScript, Vite, Tailwind CSS 4
- React Router v7
- `client/src/lib/api.ts` — all API calls go through here

## Project layout
```
src/                         — backend (Node/Express)
  index.ts          — server entry, starts HTTP + cron jobs
  app.ts            — Express app setup, mounts /v1
  config/           — db.ts (Drizzle instance), env.ts (validated env vars)
  db/schema/        — one file per table; index.ts re-exports all
  routes/           — one file per domain; index.ts mounts all under v1Router
  controllers/      — thin: parse req, call service, send response
  services/         — business logic; imports from db/schema/index.ts
  middleware/       — authenticate, requireAdmin, requireMember, validate, errorHandler, rateLimiter
  validators/       — Zod schemas, one file per domain
  utils/            — AppError, money (paise arithmetic), pagination, response helpers
  jobs/             — node-cron scheduled tasks
  types/            — express.d.ts augments req.user; index.ts shared types

client/                      — frontend (React + Vite + Tailwind)
  src/
    App.tsx         — router root
    main.tsx        — React entry
    pages/          — one file per page/screen
    components/     — shared UI components
    lib/
      api.ts        — typed fetch wrappers for all backend endpoints
      format.ts     — display formatting helpers (currency, dates)
    types/api.ts    — shared API response types
  vite.config.ts    — Vite config (proxies /v1 to backend in dev)

docs/               — versioned design docs (API, schema, requirements, wireframes)
tests/              — integration tests hit a real test DB (NODE_ENV=test)
drizzle/            — migration SQL files + meta snapshots
```

## Domain model (key tables)
| Table | Purpose |
|---|---|
| `users` | All users (admin + members) |
| `chit_groups` | A chit fund group |
| `memberships` | User ↔ group, with role (admin/member) and status |
| `monthly_cycles` | One row per month, pre-created as `Open` at group start |
| `payments` | One row per (cycle, member); status: Unpaid/Paid/Waived |
| `loans` | Member borrows from basket |
| `basket` | Group's basket (pool of bid savings + interest) |
| `transfers` | Basket disbursements |
| `notifications` | In-app notifications |
| `activity` | Activity feed |
| `audit_logs` | Append-only audit trail (old_values + new_values JSONB) |

## Critical business rules
- **All monetary values are stored in paise (integer)**; never use floats.
- **Cycles are pre-created as `Open`** when a group is formed. To find the current active cycle: join `monthly_cycles` with `payments` to find the cycle with pending payments — never use raw `max(month_number)`.
- `bid_amount` fields on a cycle are all-or-nothing: either all null (no winner yet) or all filled (DB check constraint `chk_bid_consistency`).
- `payments` has a `chk_paid_consistency` constraint: `paid_at` and `marked_by` must be set if and only if status is `Paid`.
- Admin commission is taken offline (cash); `admin_commission = pool_amount × rate` (NOT bid_amount × rate). `basket_credit = bid_amount − admin_commission`. `winner_takeaway = pool_amount − bid_amount`.

## Dev commands
```bash
npm run dev          # tsx watch — hot reload
npm run test:run     # run tests once (uses .env.test)
npm run db:generate  # generate migration from schema changes
npm run db:migrate   # apply pending migrations
npm run db:studio    # Drizzle Studio UI
npx tsc --noEmit     # type-check without building
```

## DB connection (local)
`postgresql://zoro@localhost:5432/chitfund` (test DB: `chitfund_test` via `.env.test`)

## Conventions
- Controllers are thin — no business logic; delegate everything to a service.
- Services import from `src/db/schema/index.ts` (never import individual schema files directly).
- Errors thrown via `AppError` (from `src/utils/AppError.ts`) — the global `errorHandler` catches them.
- Response shape standardised via `src/utils/response.ts` helpers.
- Validators live in `src/validators/` and are applied via `validate` middleware before controllers.

## Known risks & gaps (gap analysis 2026-05-29)

### Fixed
- **`payments.service.ts:137`** — Waived payment now clears `paid_amount = 0`. Previously, transitioning a Paid payment to Waived left the old `paid_amount` in place.

### Outstanding — Low
- **Double-submit race in `recordWinner` (`cycles.service.ts`)** — Only one admin per group, so a true two-user race is impossible. Risk is limited to double-click / network retry: both requests pre-compute `basket_balance_after` from the same stale snapshot; the `uniq_cycle_slot` DB constraint rejects the duplicate winner insert and rolls back the whole transaction, so the basket update is also rolled back. The balance itself is safe; the only leak is if a retry lands after the first fully commits and updates `total_credited` twice. Fix (low priority): use SQL-level atomic increments (`sql\`${baskets.current_balance} + ${delta}\``) instead of snapshot-based absolute sets, and re-query winner count inside the transaction for a clean 409 instead of a raw DB error.

### Outstanding — Medium
- **Notification failures silently swallowed** — `notify(...).catch(() => {})` fire-and-forget pattern means missed notifications are never logged. Add at minimum an error log inside the catch.
- **Interest rounding** — `Math.round(principal * rate / 100)` instead of `Math.floor`. Both are used; pick one and apply consistently to avoid sub-paise drift across many loans.

### Resolved — Not a bug
- **`total_needed = pool + adminCommission` in final cycle** — Intentional per requirements Locked Decision #21 and F-6a. In the final cycle there is no bid, so admin commission cannot be carved from a bid sacrifice; it is explicitly added to `total_needed` so members + basket collectively cover both the pool payout and the admin's fee for that month.
