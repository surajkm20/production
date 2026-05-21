# ChitFund Management App — Requirements (v1)

**Status:** Draft v13 (admin withdrawal refined — explicit opt-in flag at record time; one-time use per group tracked via admin_withdrawal_used; admin can still win via regular bid)
**Owner:** Suraj
**Last updated:** 2026-05-20

---

## 1. Overview

A mobile-first app to centrally track chit fund groups, members, monthly contributions, and monthly winners. Payments happen physically in cash (offline) — the app's job is to be the **single source of truth** for who paid, when, and who took the chit that month.

### Platforms (v1)
- **Android** (published to Google Play Store)
- **Web** (responsive, works on desktop + any mobile browser)
- **iOS:** deferred — users can access via Safari/PWA in the meantime; full App Store listing in Phase 2.

### Tech approach (v1)
- Single codebase: **Progressive Web App (PWA)** built with **Next.js (React)**.
- Android Play Store version is a thin **TWA (Trusted Web Activity)** wrapper around the same PWA — no separate Android codebase.
- Future iOS release will wrap the same PWA using Capacitor (est. 1–2 weeks extra work, ~90% code reuse).

### Goals (v1)
- Replace WhatsApp/notebook tracking with one centralized app.
- Give admins a fast way to mark payments and see defaulters.
- Give members transparency: their own payment history + who took the chit each month.
- Trigger reminders so admins don't have to chase people manually.

### Non-goals (v1)
- No in-app payment gateway (UPI/cards). Cash-only tracking.
- No in-app bidding / auction logic. Winner is decided offline and entered by admin.
- No iOS App Store release (deferred — PWA still accessible on iPhone via Safari).
- No member self-reporting of payments — admin is the only one who marks payments.
- No multi-language support yet.
- No offline mode (online-required for v1).
- No cross-group analytics (only per-group analytics in v1).

---

## 2. User Roles

A single user account can simultaneously be:
- **Admin** of N chit fund groups.
- **Member** of N chit fund groups.
- An admin is *always also a member* of the group they manage (they contribute too).

There is no "super-admin" or platform-level admin in v1. Each group is independent.

### 2.1 Admin permissions (within their group)
- Create the chit fund group, set its terms (amount, duration, members count, start month).
- Add / edit / remove members.
- Mark a member's monthly payment as Paid / Unpaid, with date & time.
- Edit/correct a payment entry (with audit trail).
- Record the monthly winner (who took the chit that month).
- View defaulters list for any month.
- View full payment history of any member.
- Close the chit fund when the cycle ends.

### 2.2 Member permissions (within their group)
- View their own payment status & history.
- View who took the chit for each month (current + past).
- View list of all members in the group.
- View the group's overall schedule (which month they're in, how many remain).
- Cannot edit anything.

---

## 3. Authentication & Sessions

- **Login:** username OR mobile number + password.
- **Signup:** mobile number + name + password. Mobile number verified via **OTP (mandatory)**.
- **Session:** persistent login (token-based, e.g. JWT + refresh token). User stays logged in like standard apps (WhatsApp/Paytm-style) until they explicitly log out or the device is uninstalled.
- **Logout:** manual from settings.
- **Forgot password:** reset via OTP to registered mobile.
- **Email:** not supported in v1 (mobile-only identifier).

---

## 4. Core Concepts & Data Model (logical)

### 4.1 User
- user_id, name, mobile_number (unique), username (unique, optional), password_hash, mobile_verified (bool), created_at.

### 4.2 ChitFund Group
- group_id, name, pool_amount (e.g. ₹1,00,000 — full undiscounted pool), monthly_contribution (per share), total_months, total_shares, start_month, currency (INR), status (Active / Closed), created_by (admin user_id), created_at.
- **Settings:**
  - `monthly_interest_rate` — fixed monthly interest rate applied to all basket loans in this group (e.g. 5% means ₹5,000/month on ₹1L).
  - `admin_commission_rate` — percentage of the full pool amount that the admin retains as a foreman fee (e.g. 5% on a ₹1,00,000 pool = ₹5,000 to admin, regardless of the winning bid). Set at group creation; cannot be changed after cycle 1 starts. The commission is collected offline in cash and does not affect the basket.
  - `payment_due_day` — day of month (1–28) on which all payments are due every cycle. This covers both the monthly contribution and loan interest for members with active loans. Days 29–31 are not allowed (blocked at creation) to ensure the date is valid across all months including February.
- **Invariant:** total_shares × monthly_contribution should equal pool_amount. Validate on creation.
- **Multi-share model:** a chit has `total_shares` slots (one cycle per share). A single person can hold multiple shares — see §4.3. So `total_shares ≥ unique_person_count`.

### 4.3 Membership
- membership_id, group_id, user_id, role (Admin / Member), share_count (how many shares this person holds), requested_share_count (the share count the member asked for when submitting a join request; null for admin-added members), wins_count (default 0; how many times this person has won so far), joined_at, status (Pending / Active / Removed).
- **Status meanings:**
  - `Pending` — member submitted a join request via invitation code; awaiting admin approval. Not counted toward `shares_filled`; not eligible for any group actions until approved.
  - `Active` — full member; counted toward `shares_filled`.
  - `Removed` — soft-deleted; kept in history.
- A user can have multiple memberships across groups, but only one membership row per group (with N shares folded into that one row).
- **Eligibility to win:** `wins_count < share_count` AND no active loan in this group. A 2-share holder can win twice; once they hit 2 wins, or while they have an active loan, they're removed from the eligible-winners dropdown.
- **Multi-share semantics:**
  - A person with N shares pays `monthly_contribution × N` per month.
  - A person with N shares can win up to N times across the cycle.
  - On closure, basket leftover is split proportional to share_count.

### 4.4 Monthly Cycle
- cycle_id, group_id, month_number (1..N), month_label (e.g. "Apr 2026"), due_date, status (Open / Closed).
- **`due_date` derivation:** auto-computed when cycles are pre-created at group start. Formula: `due_date = payment_due_day` of that cycle's calendar month. Example: group with `payment_due_day = 10` starting May 2026 → cycle 1 due date is May 10, cycle 2 is Jun 10, etc.
- **Cycle type:** `is_skip_month` (bool) — if true, this month's pool is covered by the basket and members do not pay.
- **Bidding fields (entered by admin after offline auction; NULL for skip-month cycles):**
  - winner_user_id (nullable until decided).
  - bid_amount (the amount the winner agrees to sacrifice/leave behind. Example: highest bidder Suresh agrees to give up ₹16,000 → bid_amount = ₹16,000.)
  - admin_commission (auto-computed = pool_amount × group.admin_commission_rate; cash retained by admin offline. Example: 5% × ₹1,00,000 = ₹5,000.)
  - basket_credit (auto-computed = bid_amount − admin_commission; the net amount credited to the basket after admin takes their cut. Example: ₹16,000 − ₹5,000 = ₹11,000.)
  - winner_takeaway (auto-computed = pool_amount − bid_amount; what the winner actually receives. Example: ₹1,00,000 − ₹16,000 = ₹84,000.)
- **Bidding model:** Ascending bid — members bid the amount they're willing to sacrifice (leave behind). **Highest bidder wins.** Admin commission is carved out of the bid sacrifice (computed on pool_amount, collected offline in cash); the remainder goes to basket. The winner always takes pool minus the full bid.
- **Basket impact:**
  - On a regular month (non-admin winner): `basket_credit` (= bid_amount − admin_commission) is credited to the basket. The admin_commission is computed on pool_amount and retained by the admin in cash — it is not a basket transaction.
  - On an admin withdrawal month: all bid fields are stored as 0; winner_takeaway = pool_amount (admin takes everything). No basket transaction is created — nothing goes to basket, no commission is taken.
  - On a skip month: `pool_amount` is debited from the basket and paid to the winner.

### 4.5 Payment
- payment_id, cycle_id, member_user_id, expected_amount (= monthly_contribution × member's share_count for regular cycles; 0 for skip-month cycles), paid_amount, status (Paid / Unpaid / Waived), paid_at (timestamp), marked_by (admin user_id), notes (optional), created_at, updated_at.
- **Waived** status = this cycle is a skip-month; no payment needed from members.
- One payment row per member per cycle, regardless of share_count (shares are folded into expected_amount).
- **Audit log** for every edit (who changed what, when, old → new value).

### 4.6 Basket (communal kitty)
- basket_id (one per group), group_id, current_balance, total_accumulated, total_lent_out, total_interest_earned, last_updated_at.
- Runs like a ledger — every dividend-lend, loan disbursement, loan repayment, interest accrual, and month-skip expense hits this balance.

### 4.7 Basket Transaction (ledger entries)
- txn_id, basket_id, cycle_id (nullable), type, amount, counterparty_user_id (nullable — who borrowed or benefited), notes, created_at, created_by.
- **Transaction types:**
  - `CREDIT_DISCOUNT` — basket credit from a regular cycle (= bid_amount − admin_commission). Admin commission is computed on pool_amount and collected offline — it never enters the basket.
  - `DEBIT_SKIP_MONTH` — basket pays the winner of a skip-month cycle.
  - `LOAN_DISBURSED` — loan given out to a member (debit).
  - `LOAN_REPAID` — principal repayment from a borrower (credit).
  - `INTEREST_ACCRUED` — monthly interest earned on an active loan (credit).
  - `CLOSURE_SPLIT` — final distribution when the chit closes — remaining balance split among all members proportional to `share_count` (debit).
- Immutable. Corrections are made by adding a reversing entry, not by editing.

### 4.8 Loan
- loan_id, basket_id, borrower_user_id, principal, monthly_interest_rate (inherited from group at disbursement time, stored on the loan for immutability), disbursed_at, status (Active / Repaid), total_interest_accrued, total_interest_paid, expected_close_date.
- `outstanding_interest` is always derived: `total_interest_accrued − total_interest_paid`.
- Monthly interest accrual: each cycle adds `principal × monthly_interest_rate` to `total_interest_accrued` (e.g. 2% on ₹1,00,000 = ₹2,000 per cycle).
- **Upfront deduction:** when a loan is disbursed, the first month's interest is deducted immediately. Borrower receives `principal − monthly_interest`; the deducted amount is credited to the basket as `INTEREST_ACCRUED` and added to `total_interest_accrued`.
- **Repayment rule:** monthly interest payments are pure interest — they do not reduce the principal. The loan can only be closed by repaying the **full principal** in one lump sum. Partial principal repayments are not allowed.
- **Eligibility to borrow:** member must have `wins_count < share_count` (at least one un-won share remaining) — hard block. If the member already has an active loan in this group, the disbursement proceeds but the API returns a warning in the response (`warnings` array).
- **Max loan cap:** `min(basket_balance, (share_count − wins_count) × (pool_amount / total_shares))`. The per-share value used is always the fixed total share value (`pool_amount / total_shares`), regardless of how many months remain in the cycle.
- **Bidding exclusion:** a member with an active loan is excluded from the eligible-winners dropdown until the loan is fully repaid.
- **Rule:** all loans must be fully repaid before the chit cycle can be closed.

---

## 5. Functional Requirements

### 5.1 Group management (Admin)
- **F-1** Admin can create a new chit fund group with: name, total amount, monthly contribution, number of members, number of months, start month, payment due day (1–28), and **admin commission rate** (percentage of winning bid retained by admin; e.g. 5%). Days 29–31 are rejected with a validation error. At creation the admin also selects their own share count — minimum 1, maximum `total_shares`. Defaults to 1 if not specified.
- **F-2** Admin can invite members via mobile number. If the user exists, they're added directly; if not, they get an SMS invite to download the app.
- **F-2a** **Member self-join via invitation code.** A user who has the group's invitation code can submit a **join request** that includes their requested share count (minimum 1; cannot exceed the remaining unfilled shares). The request is created in `Pending` status and does not count toward `shares_filled` until approved. The admin sees all pending requests and can:
  - **Approve** — accept the requested share count as-is, activating the membership.
  - **Approve with change** — override the share count (any value ≥ 1 and within remaining capacity) and activate.
  - **Reject** — decline the request; the user is notified and their pending row is removed.
  - Only one pending request per user per group is allowed at a time. A user who is already `Active` in the group cannot submit a new request.
  - The admin receives a push notification when a new join request arrives.
  - Once cycle 1 has started the group is locked — join requests via invitation code are blocked. Admin can still add members directly (F-2) with the force-add confirmation flow.
- **F-3** Admin can remove a member (only allowed before the cycle starts, OR with a special "force remove" flag that's logged). Removing mid-cycle needs a confirmation flow.
- **F-4** Admin can edit group name and non-financial settings. Financial settings (amount, member count) are locked once cycle 1 starts.
- **F-5** Admin can close the group when all cycles are complete (no open cycles, no outstanding loans). **Auto-close:** when closing a cycle causes every active member's `wins_count` to equal their `share_count` (all shares exhausted) AND no active loans remain, the group is automatically closed as part of the same `POST .../close` call — no separate group-close action is needed. If loans are still outstanding when all shares are exhausted, the admin must repay them and then close the group manually.

### 5.2 Payment tracking (Admin)
- **F-6** For each open monthly cycle, admin sees a list of all members with a Paid / Unpaid toggle.
- **F-7** Marking Paid auto-stamps the current date & time (admin can override the date if collected earlier).
- **F-8** Admin can add a free-text note per payment (e.g. "paid in two installments", "received via Ramesh").
- **F-9** Admin can edit/undo a payment entry. Every edit is logged in an audit trail.
- **F-10** Admin records the winner for the month from a dropdown of **eligible members** — those where `wins_count < share_count` AND who have no active loan in this group. If the admin selects themselves as the winner, the **admin withdrawal** flow is triggered (see F-11a).

### 5.3 Bidding, Basket & Loans (Admin)
- **F-11** When recording a winner for a regular cycle, admin enters the **winning bid amount** (the amount the winner agrees to sacrifice). App auto-computes and displays the three-way split:
  - **Admin commission** = pool_amount × admin_commission_rate (admin retains this offline in cash; based on full pool, not the bid).
  - **Basket credit** = bid_amount − admin_commission (net amount credited to basket after admin's cut).
  - **Winner takeaway** = pool_amount − bid_amount (what the winner actually receives).
  Admin confirms and the basket_credit is recorded as a `CREDIT_DISCOUNT` ledger entry.
- **F-11a** **Admin withdrawal (special share).** The admin holds ONE special share within their regular `share_count`. When the admin selects themselves as winner AND explicitly opts into the withdrawal:
  - The admin toggles "Admin withdrawal" at record time — the bid amount input is hidden.
  - The admin receives **100% of the pool** (`winner_takeaway = pool_amount`). No bid sacrifice, no commission, nothing to basket.
  - `bid_amount`, `admin_commission`, and `basket_credit` are stored as 0; no basket transaction is created.
  - **One-time use:** the special share can only be used once per group. Tracked via `admin_withdrawal_used` on the admin's membership row. If already used, the withdrawal option is blocked with `WITHDRAWAL_ALREADY_USED`.
  - If the admin wins without selecting withdrawal (regular bid), the normal three-way split applies and the special share remains available for a later cycle.
  - Notification sent to all members: "Admin withdrew the full pool of ₹X."
- **F-11b** **X Chiti eligibility (display).** `X = floor(total_basket / pool_amount) + 1`. When X ≥ 2 (i.e., `total_basket >= pool_amount`), the group is eligible for X Chiti. The Record Winner screen displays an eligibility banner: `"<GroupName> is eligible for Double/Triple/Quadruple Chiti"` (X=2/3/4 respectively). The banner is hidden when X < 2 (i.e., normal single-winner cycle).
  - `total_basket = realized + unrealized`
  - `realized = baskets.current_balance` (actual cash in basket)
  - `unrealized = SUM(active loan principals) + SUM(outstanding accrued interest per active loan)` — money the basket is owed but hasn't received yet
  - `x_chiti` is always ≥ 1; a value of 1 means a regular single-winner cycle. Threshold examples: basket = 0 → x=1; basket = pool → x=2; basket = 2×pool → x=3.
  - Exposed via `GET /groups/:group_id/chiti-eligibility` (admin + member).
- **F-11c** **Multiple winners per cycle (X Chiti recording).** For eligible cycles (X ≥ 2), admin can record up to X winners in the same cycle. Each winner is recorded separately via `POST .../record-winner` (same endpoint, same request shape). Rules:
  - Each winner has their own `bid_amount`, `admin_commission`, `basket_credit`, `winner_takeaway` computed independently using the same formulas as a regular single winner.
  - A user can win at most once per cycle (`ALREADY_WON_THIS_CYCLE` error if attempted twice).
  - Total recorded winners per cycle is capped at `x_chiti` at the time of recording; further calls beyond that return `CHITI_SLOTS_FULL`.
  - Each winner occupies one "winner slot" numbered sequentially (`winner_number` 1, 2, 3…).
  - The Record Winner screen shows X separate bid-entry blocks — one per slot — when the group is eligible. Admin fills in each winner and their bid independently.
  - Winners list on the cycle detail and history screens shows all X winners (not just one).
- **F-12** Admin can declare a cycle a **Skip Month** (before the cycle opens or while it's open, as long as no payments have been collected). In a skip-month cycle:
  - Members are not required to pay their contribution (their payment is auto-set to `Waived`).
  - The full pool amount is debited from the basket and paid to the winner.
  - The admin must confirm the basket has sufficient balance before declaring a skip month.
- **F-13** Admin can disburse a loan from the basket to an eligible member. Hard requirement: member must have `wins_count < share_count` (at least one un-won share) — blocked otherwise. If the member already has an active loan, disbursement proceeds but the response includes a warning. Maximum loan amount is `min(basket_balance, (share_count − wins_count) × (pool_amount / total_shares))` — admin can enter any amount up to this cap. Loan fields: principal (≤ cap), expected close date. Interest rate is taken from the group's `monthly_interest_rate`. App deducts the first month's interest upfront — borrower receives `principal − (principal × monthly_interest_rate)`. App enforces the cap before allowing disbursement.
- **F-14** Admin records interest payments and principal repayments against the borrower. Both flow back into the basket.
  - **Interest payment:** admin enters any amount up to the borrower's current `outstanding_interest`. Payment is applied to the cumulative outstanding balance — there is no concept of paying "this month's interest" specifically. The app shows the outstanding balance so admin knows the maximum receivable amount.
  - **Principal repayment:** full principal only (no partial), as per §4.8.
- **F-15** App auto-calculates monthly simple interest accrual for all active loans.
- **F-15a** Each cycle, `principal × monthly_interest_rate` is added to the borrower's `total_interest_accrued`. **There is no hard requirement to pay interest every month** — the borrower can let it accumulate and pay cumulatively at any point. Example: ₹1,00,000 at 2% accrues ₹2,000/cycle. The borrower can pay ₹2,000 in month 1, or skip month 1 and pay ₹4,000 in month 2, or wait until month 4 and pay ₹8,000 cumulative.
  - For each open cycle, admin sees two figures for a member with an active loan: (1) their contribution due (hard obligation), and (2) their current `outstanding_interest` balance (informational — no hard block). Admin records them separately: contribution via the payments flow, interest via the loan repay flow.
- **F-16** A member is excluded from the "eligible winners" dropdown if `wins_count >= share_count` OR they have an active loan in this group.
- **F-17** The chit cycle cannot be closed while any basket loan has outstanding principal.
- **F-18** On chit closure, the app auto-computes the per-member closure-split as `(basket_balance × member.share_count) / total_shares` and presents a final closure-split statement. Admin confirms and the split is recorded as `CLOSURE_SPLIT` ledger entries (one per member). Splits are share-weighted, not equal per person.
- **F-18a** **Admin basket adjustment.** Admin can add a manual `ADJUSTMENT` ledger entry (credit or debit) for unusual situations (cash discrepancy, written-off loan recovery, recording an offline correction, etc.). Rules:
  - Admin role only.
  - A non-empty `notes` field is **mandatory** explaining the reason.
  - Recorded in the basket ledger with `txn_type='ADJUSTMENT'` and the admin's user_id as `created_by`.
  - Triggers a notification to **all group members** (`type='BASKET_ADJUSTED'`) with the admin's name, the amount, the direction (credit/debit), and the reason.
  - Cannot result in a negative basket balance (debits are blocked if `amount > current_balance`).

### 5.4 Member view
- **F-19** Member sees a dashboard per group: current month, their payment status, next due date, whether the month is a skip-month (no payment needed).
- **F-20** Member sees their own full payment history (table: month, expected amount, paid amount, status, paid date).
- **F-21** Member sees the winners list across all months for the group. Each row shows: month, winner name, bid amount (sacrifice), admin commission (pool × commission rate), basket credit (bid − commission), and winner takeaway (pool − bid). All figures are always visible so every member can verify the split for each cycle.
- **F-22** Member sees the full member list of the group (read-only), with the admin badge visible.
- **F-23** Member sees the basket balance (current value) and any loans they personally have taken (borrower view only — not other members' loans).

### 5.5 Defaulter view (Admin)
- **F-24** Admin can view a "Defaulters" screen showing all members who haven't paid for the selected month (or across multiple months). Skip-month cycles are excluded.
- **F-25** From the defaulters screen, admin can trigger a reminder notification (push + optionally SMS) to a single member or all defaulters.

### 5.6 Notifications (priority feature)
- **F-26** Auto-reminder (`type=PAYMENT_DUE`) to members with unpaid payments **3 days before the cycle's `due_date`**. Implemented as a **scheduled daily cron job** (runs at 09:00 IST) — NOT sent immediately when a cycle opens or closes. Skip-month cycles are excluded (no payment needed, nothing to remind about).
- **F-27** Auto-reminder to defaulters on due date and +3 days, +7 days after.
- **F-28** Notification (`type=WINNER_ANNOUNCED`) to all active members when admin records the month's winner. Includes winner name, bid amount, and basket credit.
- **F-29** Notification (`type=SKIP_MONTH_DECLARED`) to all active members when a skip-month is declared.
- **F-30** Notification (`type=PAYMENT_RECEIVED`) to a member when admin marks their payment as Paid.
- **F-30a** Notification (`type=LOAN_DISBURSED`) to a member when admin disburses a loan to them. Includes principal and actual amount disbursed (after first-month interest deduction).
- **F-31** Reminder to borrowers sent 3 days before the cycle's `due_date` (same cron as F-26) and again on the due date itself if they have any `outstanding_interest > 0`. The notification shows the **cumulative outstanding interest** (not just that cycle's accrual) so the borrower knows exactly how much they owe in total. No hard block — this is informational.
- **F-31a** Notification (`type=BASKET_ADJUSTED`) to all active members when admin records a basket `ADJUSTMENT` (per F-18a). Includes amount, direction (credit/debit), and reason (notes field).
- **F-32** User can mute all notifications globally from their profile settings. **Per-group mute is deferred to v2.** The global mute preference is checked before every notification delivery.

### 5.7 Reports & exports (priority feature)
- **F-33** Export a group's full payment ledger as PDF and Excel (admin only).
- **F-34** Export a single member's payment history as PDF (member or admin).
- **F-35** Export the basket ledger and loan register as PDF/Excel (admin only).
- **F-36** Monthly summary report: collected amount, defaulters list, winner, bid amount, admin commission, basket credit, cycle type (regular/skip).
- **F-37** Closure report: final basket balance, per-member closure split, all loans reconciled.

### 5.8 Per-group Analytics (new priority feature)
- **F-38 Total collected vs total disbursed:** running totals showing money collected from members, money paid to winners, current basket balance, total loans outstanding, total interest earned.
- **F-39 Winners ledger:** table per group showing for each closed month — month, winner, bid amount, admin commission, basket credit, cycle type (regular/skip).
- **F-40 Member balance sheet:** for each member, show total contributed, total paid out as winner, any active loans, projected closure split share, net position.
- **F-41 Bid trend:** simple chart showing winning bid amount (and implied discount) per month across the cycle.
- **F-42 Basket growth:** simple chart showing basket balance month over month.

### 5.9 Multi-group experience
- **F-43** Home screen lists all groups the user belongs to, with a badge for pending payments or unread notifications.
- **F-44** Easy switcher between groups.

---

## 6. Non-Functional Requirements

- **Centralized:** all data lives in one backend database. No purely local storage of source-of-truth data.
- **Reliability:** payment edits must be transactional and audited. No silent overwrites.
- **Security:**
  - Passwords hashed (bcrypt/argon2).
  - All API calls over HTTPS.
  - JWT-based auth with refresh tokens.
  - Authorization checks on every endpoint (a member of group A cannot read group B).
- **Performance:** dashboard should load in < 2s on a typical 4G connection for groups with up to 50 members and 24 months of history.
- **Scalability target (v1):** 1,000 groups, 20,000 users, 5 years of payment history.
- **Data integrity:** soft-delete only — no hard deletes of payments, members, or groups (compliance + dispute resolution).
- **Backups:** daily automated DB backups, 30-day retention minimum.

---

## 7. Edge Cases to Handle

- **Member dropout mid-cycle:** admin marks member as "Inactive" — they remain in history but don't appear in new cycles. Their unpaid dues are flagged separately. If they had won already, their winning record stays. They also remain eligible for the final closure-split share proportional to their participation. *(Refund/settlement handled offline between admin and member.)*
- **Admin handover:** support "Transfer admin" with confirmation OTP from both the current admin and the incoming admin (the new admin must already be a member of the group).
- **Uninstall / reinstall:** user data and memberships persist server-side; reinstall + login restores everything.
- **Mistaken payment entry:** fixable via edit, but the original entry is preserved in the audit log.
- **Late-added member:** admin manually backfills their status for prior months as Paid/Unpaid/N-A.
- **Skip month requested with insufficient basket:** blocked. Admin must wait until the basket has at least `pool_amount` before declaring a skip month.
- **Skip month after payments already collected:** blocked. Admin can only declare a skip month before any member has been marked Paid for that cycle.
- **Loan default:** if a borrower fails to repay, admin can extend the loan (with confirmation) or mark it as written off. Written-off loans reduce basket balance permanently and are flagged in the analytics and the closure-split calculation.
- **Chit closure with outstanding loans:** blocked. Admin must collect all outstanding loans before the group can be marked Closed.
- **Chit closure split rounding:** final basket balance may not divide evenly among members — residual paisa is added to the last member or rounded per standard rules (documented in closure report).
- **Winner doesn't pay back future contributions:** winner is still a regular member and owes contributions for all remaining cycles. Failure is treated same as any other defaulter.
- **Invalid payment due day (29–31):** group creation is blocked if `payment_due_day` is 29, 30, or 31. Admin must choose a day between 1 and 28. The typical default is 10.
- **Join request exceeds remaining capacity:** blocked at submission time. The user sees how many shares are still unfilled and must request ≤ that number.
- **Admin approves with a share count override that exceeds remaining capacity:** blocked with a `SHARES_EXCEEDED` error; admin must enter a valid count.
- **Duplicate join request:** if a user already has a `Pending` row for a group, submitting another join request for the same group is rejected. They must wait for the admin to act on the existing request.
- **Join request after cycle 1 starts:** blocked entirely. The invitation code path is locked once the group is active; admin must use the direct-add flow (F-2) if a new member is needed mid-cycle.

---

## 8. Locked Decisions

| # | Decision | Value |
|---|---|---|
| 1 | Admins per group | Single admin only (no co-admins in v1) |
| 2 | Currency | INR |
| 3 | Email identifier | Not supported (mobile-only) |
| 4 | OTP for signup | **Mandatory** |
| 5 | Member self-report of payment | Not supported (admin-only) |
| 6 | Dropout policy | Mark Inactive, keep history, offline settlement |
| 7 | Admin visible to members | Yes (admin badge shown) |
| 8 | Admin commission | Set at group creation as `admin_commission_rate` (% of **full pool_amount**, not the winning bid). Admin retains this portion offline in cash. Cannot change after cycle 1 starts. |
| 9 | Basket credit from bid | `bid_amount − admin_commission` is credited to the basket as `CREDIT_DISCOUNT`. Admin commission (pool × rate) is collected offline and never enters the basket. |
| 10 | Skip-month trigger | Admin decides freely; no threshold logic — app only enforces sufficient basket balance |
| 11 | Basket loan interest | Simple interest, 2–5% **per month**; first month's interest deducted upfront at disbursement |
| 12 | Loan close rule | All loans must be repaid before chit can close: **full principal** (no partial repayments) AND **all outstanding interest cleared** (`outstanding_interest = 0`). Interest payments are flexible — no hard monthly enforcement; borrower can pay cumulatively at any time. |
| 13 | End-of-cycle basket | Remaining balance split **proportional to share_count** among all members |
| 14 | Cross-group analytics | Deferred to Phase 2 |
| 15 | Bidding model | **Ascending bid** — highest bid wins; bid amount = amount sacrificed; admin commission = pool × rate (offline cash); basket credit = bid − commission; winner takes (pool − bid) |
| 16 | Multi-share model | A person can hold N shares in a group. Pays N × contribution. Eligible to win N times. Closure split is proportional to shares. |
| 17 | Payment due day | Day of month (1–28) set at group creation. Days 29–31 blocked. Applies uniformly to contributions AND loan interest every cycle. Default suggestion: 10. |
| 18 | Admin share count at creation | Admin selects their own share count at group creation (min 1, max total_shares). Defaults to 1. Adjustable via the members screen before cycle 1 starts. |
| 19 | Member self-join flow | Via invitation code: member submits a join request with a requested share count → admin approves / approves-with-change / rejects. No immediate self-add. Code is locked once cycle 1 starts. |
| 20 | Admin withdrawal | Admin has ONE special share (counted within their regular share_count). Withdrawal is an explicit opt-in flag at record time (`is_admin_withdrawal: true`). One-time use per group, tracked via `admin_withdrawal_used` on the membership. Admin can still win other shares via normal bid. |

---

## 9. Out of Scope (deferred to later phases)

- **iOS App Store release** (Phase 2) — PWA already accessible on iPhone via Safari in v1.
- In-app payment gateway / UPI integration (Phase 2 or 3).
- In-app bidding / auction (Phase 3).
- Multi-language support (Phase 2).
- Offline mode with sync (Phase 3).
- WhatsApp integration for reminders (Phase 2).
- Analytics dashboard for admins across multiple groups.

---

## 10. Success Criteria for v1

- An admin can run a real chit group end-to-end without using a notebook or WhatsApp for tracking.
- A member can answer "did my payment get recorded?" and "who took the chit this month?" without messaging the admin.
- Zero disputes caused by lost or unclear payment records.

---

## 11. Proposed Tech Stack (v1)

| Layer | Choice | Why |
|---|---|---|
| Frontend | Next.js (React) as PWA | One codebase for Android + Web; matches your React learning path |
| Backend | Next.js API routes OR Node.js + Express | Same repo option keeps v1 simple; can split later |
| Database | PostgreSQL | Relational data, strong audit trail support |
| DB hosting | Supabase or Neon (free tier) | Zero cost until real usage |
| Auth | JWT + refresh tokens | Standard, stateless, works on web + Android |
| OTP / SMS | MSG91 or Twilio | MSG91 is cheaper for Indian SMS |
| Push notifications | Web Push API | Free, works on Android Chrome + installed PWAs |
| Web hosting | Vercel (free tier) | Native Next.js deployment |
| Play Store wrapper | Bubblewrap CLI (TWA) | Generates the Android project in minutes |
| Future iOS | Capacitor (Phase 2) | Wraps the same PWA into an iOS app |

**Estimated monthly cost for v1:** ₹0 until you cross free-tier limits (roughly ~500 active users). SMS costs are per-message (~₹0.15–0.20 per OTP via MSG91).

---

---

## 12. TODO / Deferred Concepts

### TD-1 Penalty interest on unpaid dues

If a member has not paid their monthly contribution or loan interest by the cycle's `due_date`, a penalty interest is charged on the overdue amount.

**Concept outline (not designed yet):**
- Penalty rate = `monthly_interest_rate` of the group (same rate, no separate config for now).
- Applies to: **unpaid contribution only** (loan interest already accrues naturally via the cumulative model — a separate penalty on top of cumulative interest is TBD).
- Baseline for "overdue": contribution not marked Paid after the cycle's `due_date`. For loan interest, the baseline is `outstanding_interest > 0` for a configurable number of months — exact threshold TBD.
- Penalty money flows into the basket (same as regular loan interest).
- Admin records the penalty payment; it is separate from the original due amount.
- Needs decisions on: when accrual starts (immediately after due date? after a grace period?), how it surfaces in the UI and reports.

**This feature is deferred. Do not implement until the concept is fully specced.**

---

*Next step after sign-off: data model + API design + screen wireframes.*
