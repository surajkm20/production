---
name: migration-issues
description: "Known DB migration pitfalls in ChitFund — columns added to 0000 without a proper migration, test DB drift, and how to fix them"
metadata: 
  node_type: memory
  type: project
  originSessionId: 3839c8c5-02ba-489c-bbf1-5e2a9c08ea2a
---

# Migration Issues — ChitFund

## The core problem
Schema columns were added directly to `drizzle/0000_initial_schema.sql` AFTER the test DB was already set up with the original 0000. No new migration file was generated. This causes the test DB to silently drift from the real schema.

**Why:** `drizzle-kit generate` was not run when new columns were added — the 0000 file was edited manually. This is bad practice. Never edit an already-applied migration. Always run `npm run db:generate` to create a new migration file.

---

## Columns that were added directly to 0000 (not via a proper migration)

### `chit_groups.payment_due_day`
- Added to `0000_initial_schema.sql` without a migration
- Main DB has it (applied 0000 when it already had the column)
- Test DB did NOT have it (applied 0000 before the column was added)
- **Fix applied:** `ALTER TABLE chit_groups ADD COLUMN payment_due_day smallint NOT NULL DEFAULT 10;` + constraint

### `memberships.requested_share_count`
- Same problem — in 0000 but not in the test DB
- **Fix applied:** `ALTER TABLE memberships ADD COLUMN requested_share_count smallint;` + constraint

### `memberships` check constraint `chk_membership_status`
- Old version only allowed `('Active', 'Inactive')`
- New schema added `'Pending'`
- **Fix applied:** Drop and recreate the constraint:
  ```sql
  ALTER TABLE memberships DROP CONSTRAINT chk_membership_status;
  ALTER TABLE memberships ADD CONSTRAINT chk_membership_status
    CHECK (status IN ('Pending', 'Active', 'Inactive'));
  ```

---

## Tables missing entirely from test DB

### `group_activity`
- Defined in `src/db/schema/activity.ts`
- Never migrated to test DB
- **Fix applied:** Created manually via psql

### `pending_admin_transfers`
- Defined in `src/db/schema/transfers.ts`
- Never migrated to test DB
- **Fix applied:** Created manually via psql

---

## How to apply migrations to the test DB

`drizzle-kit migrate` reads `DATABASE_URL` from `.env` (not `.env.test`) even when `NODE_ENV=test`. To target the test DB:

```bash
# Apply a specific SQL migration directly
psql postgresql://zoro@localhost:5432/chitfund_test -f drizzle/0005_lethal_veda.sql

# Or inline SQL for a quick column add
psql postgresql://zoro@localhost:5432/chitfund_test -c "ALTER TABLE ..."
```

Do NOT use `npm run db:migrate` for the test DB — it will hit the main DB regardless.

---

## Rule going forward
**Never edit an existing migration file.** When adding a column or table:
1. Edit `src/db/schema/` only
2. Run `npm run db:generate` → creates a new `drizzle/000X_...sql` file
3. Run `npm run db:migrate` for the main DB
4. Run `psql ... -f drizzle/000X_...sql` for the test DB
5. Commit both the schema change and the new migration file

---

## Service bug found during migration fix

`src/services/basket.service.ts` — 4 places computed outstanding loan interest using INNER JOIN with `payments`:
```ts
.from(monthly_cycles)
.innerJoin(payments, eq(payments.cycle_id, monthly_cycles.id))
```
Since `createGroup` does not create payment rows (only `startGroup` does), INNER JOIN returned null → `currentMonth = 0` → `outstanding_interest = 0` → any `interest_paid > 0` threw 409.

**Fix:** Changed all 4 to LEFT JOIN so cycles without payment rows still contribute to `max_month`.

Also fixed: `loanFullyRepaid` logic was `principal_repaid > 0 && newOutstandingInterest === 0`. This prevented loan closure unless ALL outstanding interest was also paid in the same call. Changed to `principal_repaid > 0` — loan closes on full principal repayment regardless of remaining interest.
