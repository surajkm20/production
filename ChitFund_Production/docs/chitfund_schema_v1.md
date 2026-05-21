# ChitFund App — Database Schema (v1)

**Status:** Draft v12 (admin withdrawal refined — admin_withdrawal_used boolean on memberships tracks one-time special share use; explicit flag at record time)
**Database:** PostgreSQL 14+
**Last updated:** 2026-05-20

---

## Design principles

1. **Soft delete only** — we never hard-delete groups, members, payments, or loans. Use `status` columns or `deleted_at` timestamps. This is critical for cash-tracking apps where disputes can happen months later.
2. **Audit trail** — every payment edit creates an audit log row. The original is never lost.
3. **Money in paise (integer)** — never store money as `DECIMAL` or `FLOAT`. Use `BIGINT` representing paise (1 INR = 100 paise). Avoids floating-point rounding bugs.
4. **UUIDs for IDs** — safer than serial integers (no information leakage, easier to merge data later, harder to guess).
5. **Timestamps everywhere** — every table has `created_at`. Mutable tables also have `updated_at`.
6. **Ledger is append-only** — basket transactions are immutable. Corrections happen via reversing entries, not edits.

---

## ER diagram (logical)

```
users ──┬── memberships ──┬── chit_groups
        │                  │
        │                  ├── monthly_cycles
        │                  │
        │                  ├── basket (1:1)
        │                  │     └── basket_transactions
        │                  │     └── loans
        │                  │            └── loan_transactions
        │                  │
        │                  └── payments (linked to cycle + member)
        │
        └── otp_verifications
        └── audit_logs (polymorphic)
        └── notifications
        └── refresh_tokens
```

---

## Schema

### Extensions

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";       -- UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";         -- Crypto helpers if needed
```

---

### 1. `users`

```sql
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            VARCHAR(100) NOT NULL,
    mobile_number   VARCHAR(15) NOT NULL UNIQUE,        -- E.164 format, e.g. +919876543210
    username        VARCHAR(50) UNIQUE,                 -- optional alternate login
    password_hash   VARCHAR(255) NOT NULL,              -- bcrypt/argon2 hash
    mobile_verified BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ                         -- soft delete
);

CREATE INDEX idx_users_mobile ON users(mobile_number) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_username ON users(username) WHERE deleted_at IS NULL AND username IS NOT NULL;
```

**Notes:**
- Mobile is the primary identifier; username is optional (some users may never set one).
- `mobile_verified` flips to true after OTP success. Login is blocked until then (enforced in app code).
- Partial indexes ignore soft-deleted rows for faster lookups.

---

### 2. `otp_verifications`

```sql
CREATE TABLE otp_verifications (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    mobile_number   VARCHAR(15) NOT NULL,
    otp_hash        VARCHAR(255) NOT NULL,              -- never store plain OTP
    purpose         VARCHAR(20) NOT NULL,               -- 'signup' | 'login' | 'password_reset' | 'admin_transfer'
    expires_at      TIMESTAMPTZ NOT NULL,
    verified_at     TIMESTAMPTZ,
    attempts        SMALLINT NOT NULL DEFAULT 0,        -- rate-limit brute force
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_otp_mobile_purpose ON otp_verifications(mobile_number, purpose, created_at DESC);
```

**Notes:**
- Hashed OTPs (same as passwords). If the DB leaks, OTPs aren't usable.
- `attempts` lets us lock out after 5 wrong tries.
- Old rows can be purged by a daily cron after 24h.

---

### 3. `refresh_tokens`

```sql
CREATE TABLE refresh_tokens (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id),
    token_hash      VARCHAR(255) NOT NULL UNIQUE,
    device_info     VARCHAR(255),                       -- e.g. "Chrome on Pixel 7"
    expires_at      TIMESTAMPTZ NOT NULL,
    revoked_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at    TIMESTAMPTZ
);

CREATE INDEX idx_refresh_user ON refresh_tokens(user_id) WHERE revoked_at IS NULL;
```

**Notes:**
- JWT access tokens are short-lived (15 min). Refresh tokens are long-lived (30 days) and stored hashed.
- `device_info` lets a user see "logged in on 3 devices" and revoke one.
- Logout = set `revoked_at`.

---

### 4. `chit_groups`

```sql
CREATE TABLE chit_groups (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name                 VARCHAR(100) NOT NULL,
    invitation_code      VARCHAR(10) NOT NULL UNIQUE,   -- short alphanumeric, e.g. "CF7K2X9P"
    pool_amount          BIGINT NOT NULL,               -- in paise. = monthly_contribution × total_shares
    monthly_contribution BIGINT NOT NULL,               -- in paise. Per-share contribution.
    total_months         SMALLINT NOT NULL,             -- = total_shares (one cycle per share)
    total_shares         SMALLINT NOT NULL,             -- total share slots in this group
    start_month          DATE NOT NULL,                 -- first day of the start month
    payment_due_day      SMALLINT NOT NULL DEFAULT 10,         -- day of month (1-28) when contributions + loan interest are due
    admin_commission_rate NUMERIC(4,2) NOT NULL DEFAULT 0.00,  -- % of full pool_amount retained by admin in cash (e.g. 5.00 = 5%)
    interest_rate_min    NUMERIC(4,2) NOT NULL DEFAULT 2.00,   -- 2.00 = 2%
    interest_rate_max    NUMERIC(4,2) NOT NULL DEFAULT 5.00,
    currency             CHAR(3) NOT NULL DEFAULT 'INR',
    status               VARCHAR(20) NOT NULL DEFAULT 'Active', -- 'Active' | 'Closed'
    created_by           UUID NOT NULL REFERENCES users(id),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at            TIMESTAMPTZ,

    CONSTRAINT chk_pool_matches
        CHECK (pool_amount = monthly_contribution * total_shares),
    CONSTRAINT chk_months_shares
        CHECK (total_months > 0 AND total_shares > 0 AND total_months = total_shares),
    CONSTRAINT chk_interest_range
        CHECK (interest_rate_min >= 0 AND interest_rate_max >= interest_rate_min),
    CONSTRAINT chk_commission_rate
        CHECK (admin_commission_rate >= 0 AND admin_commission_rate <= 100),
    CONSTRAINT chk_payment_due_day
        CHECK (payment_due_day >= 1 AND payment_due_day <= 28)
);

CREATE INDEX idx_groups_creator ON chit_groups(created_by);
CREATE INDEX idx_groups_status ON chit_groups(status);
CREATE INDEX idx_groups_invite ON chit_groups(invitation_code);
```

**Notes:**
- **Share model:** A chit has `total_shares` slots (= `total_months`, one cycle per share). Each share contributes `monthly_contribution` per month. **A single person can hold multiple shares**, so `total_shares ≥ unique_people_count`. Example: 10-share chit with 5 people where Ramesh holds 2, Priya holds 3, others hold 1 each.
- **Invariants:**
  - `pool_amount = monthly_contribution × total_shares`
  - `total_months = total_shares` (one cycle per share)
  - `SUM(memberships.share_count WHERE active) = total_shares` (enforced in app code, not DB, since memberships are added incrementally)
- Money in paise as `BIGINT`. ₹1 crore = 1,00,00,00,000 paise — well within `BIGINT` range.
- `payment_due_day` — day of month on which both the monthly contribution and loan interest are due for every cycle. Capped at 28 (DB constraint) so the date is valid even in February. Days 29–31 are rejected in app code before the row is inserted. Typical value is 10. When cycles are pre-created at group start, each cycle's `due_date` is computed as `payment_due_day` of that cycle's calendar month.
- `admin_commission_rate` — percentage of the full pool amount the admin retains in cash (e.g. 5.00 = 5%). Set at group creation. Locked once cycle 1 starts (enforced in app code). A 0.00 value means no commission. Admin commission per cycle = `pool_amount × admin_commission_rate/100` (offline cash). Basket credit = `bid_amount − admin_commission`.
- `invitation_code` — 8-character alphanumeric (uppercase + digits, avoiding ambiguous chars like O/0, I/1). Generated at group creation. Admin can share via WhatsApp/SMS; new members enter it to join. Admin can rotate the code if it leaks (handled in app logic).

---

### 5. `memberships`

```sql
CREATE TABLE memberships (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    group_id        UUID NOT NULL REFERENCES chit_groups(id),
    user_id         UUID NOT NULL REFERENCES users(id),
    role            VARCHAR(20) NOT NULL,               -- 'Admin' | 'Member'
    share_count              SMALLINT NOT NULL DEFAULT 1,     -- how many shares this person holds in the group
    wins_count               SMALLINT NOT NULL DEFAULT 0,     -- how many times this person has won so far
    admin_withdrawal_used    BOOLEAN NOT NULL DEFAULT FALSE,  -- true once admin uses their special share (one-time per group)
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status          VARCHAR(20) NOT NULL DEFAULT 'Active', -- 'Active' | 'Inactive'
    deactivated_at  TIMESTAMPTZ,
    notes           TEXT,                               -- e.g. reason for deactivation

    UNIQUE (group_id, user_id),                         -- one user can be in a group only once (with N shares)
    CONSTRAINT chk_role CHECK (role IN ('Admin', 'Member')),
    CONSTRAINT chk_membership_status CHECK (status IN ('Active', 'Inactive')),
    CONSTRAINT chk_share_count CHECK (share_count >= 1),
    CONSTRAINT chk_wins_le_shares CHECK (wins_count >= 0 AND wins_count <= share_count)
);

CREATE INDEX idx_memberships_user ON memberships(user_id);
CREATE INDEX idx_memberships_group ON memberships(group_id);

-- Enforce: exactly one active admin per group
CREATE UNIQUE INDEX idx_one_admin_per_group
    ON memberships(group_id)
    WHERE role = 'Admin' AND status = 'Active';
```

**Notes:**
- `share_count` lets one person hold multiple shares in the same group. They pay `monthly_contribution × share_count` per month and are eligible to win up to `share_count` times.
- `wins_count` tracks how many of their shares have already won. Eligibility to win requires both `wins_count < share_count` AND no active loan for this member in this group (enforced in app code at `recordWinner` / `declareSkipMonth`).
- `admin_withdrawal_used` — boolean, default `false`. Set to `true` when the admin uses their **special share** (admin withdrawal). The admin has exactly one special share counted within their `share_count`. When `is_admin_withdrawal=true` is sent to `record-winner`, this is checked and then flipped. Always `false` for non-admin members.
- The unique constraint on `(group_id, user_id)` means the same person is one row in this table even if they hold multiple shares — they're not duplicated.
- Sum of `share_count` across all Active memberships in a group should equal the group's `total_shares`. Enforced in app code (since memberships are added incrementally).

---

### 6. `monthly_cycles`

```sql
CREATE TABLE monthly_cycles (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    group_id             UUID NOT NULL REFERENCES chit_groups(id),
    month_number         SMALLINT NOT NULL,             -- 1..total_months
    month_label          VARCHAR(20) NOT NULL,          -- e.g. "Apr 2026"
    due_date             DATE NOT NULL,
    is_skip_month        BOOLEAN NOT NULL DEFAULT FALSE,
    winner_user_id       UUID REFERENCES users(id),
    bid_amount           BIGINT,                        -- paise. Amount the winner sacrificed (left behind). NULL until winner recorded.
    admin_commission     BIGINT,                        -- paise. = pool_amount × group.admin_commission_rate / 100. Retained by admin in cash (not a basket entry).
    basket_credit        BIGINT,                        -- paise. = bid_amount − admin_commission. Net amount credited to basket as CREDIT_DISCOUNT.
    winner_takeaway      BIGINT,                        -- paise. = pool_amount − bid_amount (what winner actually receives).
    status               VARCHAR(20) NOT NULL DEFAULT 'Open', -- 'Open' | 'Closed'
    opened_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at            TIMESTAMPTZ,
    notes                TEXT,

    UNIQUE (group_id, month_number),
    CONSTRAINT chk_cycle_status CHECK (status IN ('Open', 'Closed')),
    CONSTRAINT chk_bid_consistency CHECK (
        (winner_user_id IS NULL AND bid_amount IS NULL AND admin_commission IS NULL AND basket_credit IS NULL AND winner_takeaway IS NULL)
        OR
        (winner_user_id IS NOT NULL AND bid_amount IS NOT NULL AND admin_commission IS NOT NULL AND basket_credit IS NOT NULL AND winner_takeaway IS NOT NULL)
    )
);

CREATE INDEX idx_cycles_group ON monthly_cycles(group_id, month_number);
CREATE INDEX idx_cycles_status ON monthly_cycles(group_id, status);
```

**Notes:**
- **`due_date` derivation:** set at cycle pre-creation time as `payment_due_day` of that cycle's calendar month. Example: `payment_due_day = 10`, group starts May 2026 → cycle 1 due `2026-05-10`, cycle 2 due `2026-06-10`, etc. This is the hard deadline for the monthly contribution. Loan interest **accrues** on this date (added to `loans.total_interest_accrued`) but has no hard payment deadline — borrowers can pay cumulatively at any point.
- **Bidding model:** members bid the amount they're willing to sacrifice (leave behind). The **highest** bidder wins. Admin commission is carved out of the bid sacrifice (computed on pool_amount, collected offline in cash); the remainder goes to basket. The winner takes pool minus the full bid.
  - Example: Pool ₹1,00,000, commission rate 5%. Suresh bids ₹16,000 (sacrifice). Suresh wins → admin keeps ₹5,000 (5% × ₹1,00,000, offline cash), basket gets ₹11,000 (bid − commission), Suresh takes ₹84,000 (pool − bid).
- `bid_amount` = the winner's sacrifice (what they agreed to leave behind). **0 for admin withdrawal or skip month.**
- `admin_commission` = `pool_amount × admin_commission_rate / 100`. Stored for transparency; does NOT create a basket transaction (collected offline in cash). **0 for admin withdrawal or skip month.**
- `basket_credit` = `bid_amount − admin_commission`. The amount recorded as `CREDIT_DISCOUNT` in the basket ledger. **0 for admin withdrawal** (no basket transaction created) **and skip month** (basket is debited instead).
- `winner_takeaway` = `pool_amount − bid_amount` for regular cycles; equals `pool_amount` for admin withdrawal and skip months.
- **Admin withdrawal:** when the winner is the group admin, all four bid fields are stored as **0** (not NULL). The `chk_bid_consistency` constraint is satisfied because all five fields (including `winner_user_id`) are non-null. No `CREDIT_DISCOUNT` basket transaction is created.
- The `chk_bid_consistency` constraint says: either all five bid-related fields are NULL (not yet recorded) or all five are filled. No partial state. Zeros for admin withdrawal / skip month are valid "filled" values.
- Cycles are pre-created (one per `total_months`) when the group is created. Easier than creating on-the-fly.

---

### 7. `payments`

```sql
CREATE TABLE payments (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    cycle_id        UUID NOT NULL REFERENCES monthly_cycles(id),
    member_user_id  UUID NOT NULL REFERENCES users(id),
    expected_amount BIGINT NOT NULL,                    -- paise. = monthly_contribution × share_count for regular cycles; 0 for skip-month.
    paid_amount     BIGINT NOT NULL DEFAULT 0,          -- paise
    status          VARCHAR(20) NOT NULL DEFAULT 'Unpaid', -- 'Paid' | 'Unpaid' | 'Waived'
    paid_at         TIMESTAMPTZ,                        -- when admin marked it paid
    marked_by       UUID REFERENCES users(id),          -- which admin marked it
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (cycle_id, member_user_id),                  -- one payment row per member per cycle (multi-share folded into one row)
    CONSTRAINT chk_payment_status CHECK (status IN ('Paid', 'Unpaid', 'Waived')),
    CONSTRAINT chk_paid_consistency CHECK (
        (status = 'Paid' AND paid_at IS NOT NULL AND marked_by IS NOT NULL)
        OR
        (status IN ('Unpaid', 'Waived'))
    )
);

CREATE INDEX idx_payments_cycle ON payments(cycle_id);
CREATE INDEX idx_payments_member ON payments(member_user_id);
CREATE INDEX idx_payments_status ON payments(cycle_id, status);
```

**Notes:**
- One payment row **per person per cycle**, not per share. A 2-share holder appears as a single row with `expected_amount = monthly_contribution × 2`.
- For skip-months, all rows start with `expected_amount = 0` and `status = 'Waived'`.
- `paid_amount` allows partial payments in the future (not in v1 UI, but the column is here so we don't need migration later).

---

### 8. `baskets`

```sql
CREATE TABLE baskets (
    id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    group_id              UUID NOT NULL UNIQUE REFERENCES chit_groups(id),
    current_balance       BIGINT NOT NULL DEFAULT 0,    -- paise. Computed from ledger but cached here.
    total_credited        BIGINT NOT NULL DEFAULT 0,
    total_debited         BIGINT NOT NULL DEFAULT 0,
    total_lent_out        BIGINT NOT NULL DEFAULT 0,
    total_interest_earned BIGINT NOT NULL DEFAULT 0,
    last_recomputed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_baskets_group ON baskets(group_id);
```

**Notes:**
- One basket per group, created when the group is created.
- `current_balance` is **derived** from the ledger but cached here for fast reads. We periodically recompute from the ledger as a safety net.
- The numbers should always equal `SUM(credits) - SUM(debits)` from `basket_transactions`.

---

### 9. `basket_transactions` (the immutable ledger)

```sql
CREATE TABLE basket_transactions (
    id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    basket_id             UUID NOT NULL REFERENCES baskets(id),
    cycle_id              UUID REFERENCES monthly_cycles(id),  -- nullable: loans/closure not tied to a cycle
    txn_type              VARCHAR(30) NOT NULL,
    amount                BIGINT NOT NULL,                     -- paise. Always positive; direction inferred from type.
    direction             CHAR(1) NOT NULL,                    -- 'C' (credit) | 'D' (debit)
    counterparty_user_id  UUID REFERENCES users(id),           -- borrower / winner / member
    related_loan_id       UUID,                                -- nullable; FK added below to break circular dep
    notes                 TEXT,
    created_by            UUID NOT NULL REFERENCES users(id),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_txn_type CHECK (txn_type IN (
        'CREDIT_DISCOUNT',      -- discount from a regular cycle
        'DEBIT_SKIP_MONTH',     -- basket pays winner of skip-month
        'LOAN_DISBURSED',       -- loan given out (debit)
        'LOAN_REPAID',          -- principal repaid (credit)
        'INTEREST_ACCRUED',     -- interest earned (credit)
        'CLOSURE_SPLIT',        -- final split per member at closure (debit)
        'ADJUSTMENT'            -- manual correction with notes
    )),
    CONSTRAINT chk_direction CHECK (direction IN ('C', 'D')),
    CONSTRAINT chk_amount_positive CHECK (amount > 0)
);

CREATE INDEX idx_txns_basket ON basket_transactions(basket_id, created_at DESC);
CREATE INDEX idx_txns_cycle ON basket_transactions(cycle_id);
CREATE INDEX idx_txns_loan ON basket_transactions(related_loan_id);
CREATE INDEX idx_txns_user ON basket_transactions(counterparty_user_id);
```

**Notes:**
- **Append-only.** Never `UPDATE` or `DELETE` rows here. Use the `ADJUSTMENT` type for corrections.
- `direction` makes ledger reads clean: `SUM(amount) WHERE direction='C' - SUM(amount) WHERE direction='D'`.
- The `created_by` is the admin who triggered the transaction.
- **`ADJUSTMENT` rules** (also see requirements F-18a):
  - Admin role only.
  - The `notes` field is **mandatory and non-empty** — enforced in app code, not at the DB level (DB allows null notes for other txn types).
  - Direction is set explicitly by the admin (credit = `'C'`, debit = `'D'`).
  - Debit `ADJUSTMENT` is rejected if it would push `current_balance` below zero.
  - On insert, the app fires a `BASKET_ADJUSTED` notification to all members of the group (via the `notifications` table).

---

### 10. `loans`

```sql
CREATE TABLE loans (
    id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    basket_id              UUID NOT NULL REFERENCES baskets(id),
    borrower_user_id       UUID NOT NULL REFERENCES users(id),
    principal              BIGINT NOT NULL,                   -- paise
    interest_rate          NUMERIC(4,2) NOT NULL,             -- e.g. 3.50 for 3.5%
    outstanding_principal  BIGINT NOT NULL,
    total_interest_accrued BIGINT NOT NULL DEFAULT 0,  -- cumulative interest added by monthly accrual jobs
    total_interest_paid    BIGINT NOT NULL DEFAULT 0,  -- cumulative interest payments received
    disbursed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expected_close_date    DATE,
    closed_at              TIMESTAMPTZ,
    status                 VARCHAR(20) NOT NULL DEFAULT 'Active', -- 'Active' | 'Repaid' | 'WrittenOff'
    notes                  TEXT,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_loan_status CHECK (status IN ('Active', 'Repaid', 'WrittenOff')),
    CONSTRAINT chk_principal_positive CHECK (principal > 0),
    CONSTRAINT chk_interest_rate CHECK (interest_rate >= 0 AND interest_rate <= 100),
    CONSTRAINT chk_outstanding_le_principal CHECK (outstanding_principal <= principal AND outstanding_principal >= 0)
);

CREATE INDEX idx_loans_borrower ON loans(borrower_user_id);
CREATE INDEX idx_loans_basket ON loans(basket_id);
CREATE INDEX idx_loans_status ON loans(basket_id, status);

-- Now add the FK from basket_transactions back to loans
ALTER TABLE basket_transactions
    ADD CONSTRAINT fk_txns_loan
    FOREIGN KEY (related_loan_id) REFERENCES loans(id);
```

**Notes:**
- Interest rate stored at the per-loan level (within the group's `[min, max]` range), since each loan can negotiate independently.
- `outstanding_principal` is denormalized for speed; the source of truth is the ledger.
- `total_interest_accrued` increments each cycle when the monthly accrual job runs (`principal × interest_rate`). Also incremented at disbursement for the upfront first-month deduction.
- `outstanding_interest` is always **derived**, not stored: `total_interest_accrued − total_interest_paid`. This is the cumulative amount the borrower still owes. There is no hard monthly deadline to pay it — borrowers can pay any amount up to this value at any time.
- Before closing a group: both `outstanding_principal = 0` AND `outstanding_interest = 0` are required.

---

### 11. `loan_transactions`

```sql
CREATE TABLE loan_transactions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    loan_id         UUID NOT NULL REFERENCES loans(id),
    txn_type        VARCHAR(20) NOT NULL,                  -- 'PRINCIPAL_REPAID' | 'INTEREST_PAID' | 'ACCRUAL'
    amount          BIGINT NOT NULL,                       -- paise
    txn_date        DATE NOT NULL,                         -- when borrower actually paid
    notes           TEXT,
    created_by      UUID NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_loan_txn_type CHECK (txn_type IN ('PRINCIPAL_REPAID', 'INTEREST_PAID', 'ACCRUAL')),
    CONSTRAINT chk_loan_txn_amount CHECK (amount > 0)
);

CREATE INDEX idx_loan_txns_loan ON loan_transactions(loan_id, txn_date);
```

**Notes:**
- Why a separate table from `basket_transactions`? Because loans have their own internal logic (principal vs interest split, accruals). The basket ledger is the public ledger; loan txns are loan-internal accounting. Each principal repayment in `loan_transactions` should generate a corresponding `LOAN_REPAID` row in `basket_transactions`.

---

### 12. `audit_logs`

```sql
CREATE TABLE audit_logs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_type     VARCHAR(30) NOT NULL,    -- 'payment' | 'cycle' | 'membership' | 'loan' | 'group'
    entity_id       UUID NOT NULL,
    action          VARCHAR(20) NOT NULL,    -- 'CREATE' | 'UPDATE' | 'SOFT_DELETE'
    changed_by      UUID NOT NULL REFERENCES users(id),
    old_values      JSONB,                   -- snapshot before change
    new_values      JSONB,                   -- snapshot after change
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id, created_at DESC);
CREATE INDEX idx_audit_user ON audit_logs(changed_by, created_at DESC);
```

**Notes:**
- Polymorphic table — one log table covers all auditable entities.
- `JSONB` lets us store the full row snapshot without changing schema when we add columns.
- App-level: every `UPDATE` on payments/cycles/loans should write an `audit_logs` row in the same transaction.

---

### 13. `notifications`

```sql
CREATE TABLE notifications (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id),
    group_id        UUID REFERENCES chit_groups(id),
    type            VARCHAR(40) NOT NULL,    -- 'PAYMENT_DUE' | 'PAYMENT_RECEIVED' | 'WINNER_ANNOUNCED' | 'LOAN_DISBURSED' | 'LOAN_INTEREST_DUE' | 'SKIP_MONTH_DECLARED' | 'DEFAULTER_REMINDER' | 'BASKET_ADJUSTED'
    title           VARCHAR(200) NOT NULL,
    body            TEXT NOT NULL,
    data            JSONB,                   -- deep-link payload, e.g. {"screen":"cycle","cycle_id":"..."}
    read_at         TIMESTAMPTZ,
    sent_via_push   BOOLEAN NOT NULL DEFAULT FALSE,
    sent_via_sms    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notif_user_unread ON notifications(user_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX idx_notif_user_all ON notifications(user_id, created_at DESC);
```

**Notes:**
- In-app inbox + push delivery flags. SMS only for critical events (defaulter reminders, OTP).
- Partial index on unread for fast badge counts.
- `type` values and their triggers (v1 implemented types **bolded**):
  - **`PAYMENT_DUE`** — fired by a daily cron job (09:00 IST) when `due_date = today + 3 days`; sent to members with `Unpaid` payments for that cycle. Skip-month cycles excluded.
  - **`PAYMENT_RECEIVED`** — fired when admin marks a payment `Paid` via PATCH `/payments/:id`.
  - **`WINNER_ANNOUNCED`** — fired when admin records a cycle winner; sent to all active group members.
  - **`LOAN_DISBURSED`** — fired when admin disburses a loan; sent to the borrower only. *(Added in schema v9.)*
  - `LOAN_INTEREST_DUE` — reserved for future F-31 (borrower interest reminder); not implemented in v1.
  - **`SKIP_MONTH_DECLARED`** — fired when admin declares a skip month; sent to all active group members.
  - **`DEFAULTER_REMINDER`** — fired manually by admin via POST `…/remind-defaulters`.
  - **`BASKET_ADJUSTED`** — fired when admin records a basket adjustment; sent to all active group members.
- `group_id` is set on all group-scoped notifications; the API response also surfaces `group_name` (joined at query time) so the frontend can display it without an extra call.

---

### 14. `notification_preferences`

```sql
CREATE TABLE notification_preferences (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id),
    group_id        UUID REFERENCES chit_groups(id),    -- NULL = global preference
    muted           BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (user_id, group_id)
);
```

**Notes:**
- Stores mute preferences per user. `group_id = NULL` means the global preference.
- **v1 scope:** only the global mute (`group_id = NULL`) is surfaced in the UI. Per-group mute rows can exist in the table but the profile screen only exposes the global toggle. Per-group mute UI is deferred to v2 (F-32).
- The `UNIQUE (user_id, group_id)` constraint correctly handles `NULL` group_id as a single global row per user (PostgreSQL treats each NULL as distinct in unique indexes, but app code uses upsert with `ON CONFLICT` targeting the pair explicitly).

---

### 15. `push_subscriptions`

```sql
CREATE TABLE push_subscriptions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id),
    endpoint        TEXT NOT NULL,           -- web-push endpoint URL
    p256dh_key      TEXT NOT NULL,
    auth_key        TEXT NOT NULL,
    device_info     VARCHAR(255),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at    TIMESTAMPTZ,

    UNIQUE (user_id, endpoint)
);

CREATE INDEX idx_push_user ON push_subscriptions(user_id);
```

**Notes:**
- Web Push API requirement — we store the endpoint + keys per device per user.

---

### 16. `sms_logs` (minimal)

```sql
CREATE TABLE sms_logs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    mobile_number   VARCHAR(15) NOT NULL,
    purpose         VARCHAR(30) NOT NULL,    -- 'OTP' | 'DEFAULTER_REMINDER' | 'INVITE'
    provider        VARCHAR(20) NOT NULL,    -- 'MSG91' | 'TWILIO'
    provider_msg_id VARCHAR(100),            -- ID returned by provider for tracking
    status          VARCHAR(20) NOT NULL DEFAULT 'Sent', -- 'Sent' | 'Delivered' | 'Failed'
    error_message   TEXT,
    sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    delivered_at    TIMESTAMPTZ,

    CONSTRAINT chk_sms_status CHECK (status IN ('Sent', 'Delivered', 'Failed'))
);

CREATE INDEX idx_sms_mobile ON sms_logs(mobile_number, sent_at DESC);
CREATE INDEX idx_sms_status ON sms_logs(status, sent_at DESC) WHERE status = 'Failed';
```

**Notes:**
- Minimal: who got what SMS, when, did it deliver. No body content stored (privacy + storage).
- Partial index on failures helps debug delivery issues quickly.
- Not storing the actual SMS content — only the purpose + provider message ID. If we need to inspect content we go to the provider's dashboard.

---

## Triggers (recommended, not strictly required for v1)

```sql
-- Auto-update updated_at on every row update
CREATE OR REPLACE FUNCTION trg_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE TRIGGER trg_groups_updated_at BEFORE UPDATE ON chit_groups
    FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE TRIGGER trg_payments_updated_at BEFORE UPDATE ON payments
    FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE TRIGGER trg_loans_updated_at BEFORE UPDATE ON loans
    FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
```

---

## Worked example (sanity check)

Group: 10 shares total, ₹10,000/month per share, 10 monthly cycles. Pool = ₹1,00,000/month. Stored as paise: pool = 10,000,000.

**5 people in this group:**

| Person | Shares | Monthly contribution |
|---|---|---|
| Ramesh (admin) | 2 | ₹20,000 |
| Suresh | 1 | ₹10,000 |
| Priya | 3 | ₹30,000 |
| Anand | 2 | ₹20,000 |
| Deepa | 2 | ₹20,000 |
| **Total** | **10** | **₹1,00,000** |

5 people, 10 shares, sum of share_counts = total_shares ✓

**Assume admin_commission_rate = 5%.**

**Month 1:** Highest bid is Ramesh at ₹10,000. Ramesh wins.
- `admin_commission` = 5% × ₹1,00,000 (pool) = ₹5,000 (admin keeps offline in cash).
- `basket_credit` = ₹10,000 − ₹5,000 = ₹5,000.
- Ramesh receives ₹1,00,000 − ₹10,000 = ₹90,000 (`winner_takeaway`).
- `payments`: 5 rows for cycle 1 (one per person), expected_amount based on share_count:
  - Ramesh row: expected ₹20,000
  - Suresh: ₹10,000
  - Priya: ₹30,000
  - Anand: ₹20,000
  - Deepa: ₹20,000
- Admin marks all `Paid`.
- `memberships`: Ramesh's `wins_count` increments from 0 to 1 (he still has 1 share remaining; he can win once more).
- `basket_transactions`: 1 row, `CREDIT_DISCOUNT` for 500,000 paise (₹5,000 — bid minus commission).
- `baskets.current_balance`: ₹5,000.

**Month 2:** Ramesh is *still eligible* (wins_count=1 < share_count=2). He bids ₹8,000, but Priya outbids at ₹12,000. Priya wins.
- `admin_commission` = 5% × ₹1,00,000 = ₹5,000. `basket_credit` = ₹12,000 − ₹5,000 = ₹7,000.
- Priya receives ₹1,00,000 − ₹12,000 = ₹88,000.
- Priya's `wins_count`: 0 → 1 (still has 2 shares left, eligible).
- Basket: ₹5,000 + ₹7,000 = ₹12,000.

**Month 3:** Priya bids ₹15,000 and wins again.
- `admin_commission` = 5% × ₹1,00,000 = ₹5,000. `basket_credit` = ₹15,000 − ₹5,000 = ₹10,000.
- Priya receives ₹1,00,000 − ₹15,000 = ₹85,000.
- Priya's `wins_count`: 1 → 2 (still has 1 share left).
- Basket: ₹12,000 + ₹10,000 = ₹22,000.

**Month 5:** Skip month! Pool is ₹1,00,000. Basket ≥ pool? Suppose basket = ₹1,10,000. Yes.
- All payments for cycle 5 → `Waived`, `expected_amount = 0`. Nobody pays anything — Ramesh saves ₹20,000, Priya saves ₹30,000, etc. (proportional benefit happens automatically because each person's contribution is share-weighted.)
- `basket_transactions`: 1 `DEBIT_SKIP_MONTH` for ₹1,00,000.
- The cycle's winner is still recorded (whoever takes the chit that month, eligibility-checked normally).

**Month 10 (closure):** Suppose basket leftover is ₹15,000.
- Closure split is **proportional to share_count**:
  - Ramesh (2 shares): ₹15,000 × 2/10 = ₹3,000
  - Suresh (1 share): ₹15,000 × 1/10 = ₹1,500
  - Priya (3 shares): ₹15,000 × 3/10 = ₹4,500
  - Anand (2 shares): ₹3,000
  - Deepa (2 shares): ₹3,000
- Sum: ₹15,000 ✓ — matches the basket balance.
- 5 `CLOSURE_SPLIT` ledger rows, one per person.

This walks through validates: pool/contribution math, `share_count` semantics, `wins_count` eligibility, ascending-bid basket arithmetic (including commission split), skip-month gate, proportional closure split. ✅

---

## Schema Decisions (locked)

| # | Question | Decision |
|---|---|---|
| 1 | Invitation code on groups | **Yes** — added `invitation_code` (8-char unique) |
| 2 | Multi-tenancy partitioning | Deferred to Phase 2 (single shared DB for v1) |
| 3 | SMS delivery status logging | **Yes** — added minimal `sms_logs` table |

---

*Next step after schema sign-off: screen wireframes (SVG) → API endpoints.*
