# ChitFund — Glossary of Key Terms

**Last updated:** 2026-05-21

This document defines every domain-specific term used across the app, API, and codebase. All monetary examples use INR with a ₹1,00,000 pool.

---

## Core Concepts

### Chit Fund
A rotating savings scheme. A fixed group of members each contribute a fixed amount every month. Each month one member wins the entire pooled contribution. The cycle continues until every share has been won.

### Pool Amount (`pool_amount`)
The total value of one winning payout — equal to `total_shares × monthly_contribution`. This is the gross amount before any bid sacrifice.

> Example: 20 members × ₹5,000/month = ₹1,00,000 pool amount.

**Stored as integer paise. Never a float.**

### Monthly Contribution (`monthly_contribution`)
The fixed amount each single share-holder pays per cycle. A member with 2 shares pays `2 × monthly_contribution`.

### Total Shares (`total_shares`)
The total number of share slots in the group. Determines how many cycles the chit runs. One cycle is held per share — so a group with 20 shares runs for 20 months.

A single person can hold multiple shares (see [Share Count](#share-count-share_count)).

---

## Cycles

### Cycle (Monthly Cycle)
One month of the chit fund. Each cycle has a month number (1…N), a due date, and a status (`Open` or `Closed`). Cycles are pre-created for all months when the group is formed.

> The **current cycle** is the earliest `Open` cycle that still has unpaid payment rows — never derived from `max(month_number)` alone.

### Cycle Status
- **Open** — cycle is active; payments are being collected.
- **Closed** — winner has been recorded and the cycle is complete.

### Skip Month (`is_skip_month`)
A cycle in which members are **not** required to pay their contribution. Instead, the basket funds the winner's payout directly. Members' payment rows are auto-set to `Waived`. Admin can only declare a skip month if the basket balance is ≥ `pool_amount` and no member has been marked Paid for that cycle yet.

### Due Date (`due_date`)
The day of the month by which all payments (contributions + loan interest) are expected. Derived from the group's `payment_due_day`. Only days 1–28 are allowed to stay valid across February.

---

## Bidding & Winner

### Bid Amount (`bid_amount`)
The amount the winning member **agrees to sacrifice** (give up) from the pool. Members bid competitively; the highest bidder wins. The winner receives the pool minus their own bid.

> Example: Suresh bids ₹16,000 → he gets ₹84,000.

### Winning Bid
The bid_amount from whichever member placed the highest offer in the offline auction. Admin enters this value when recording the winner.

### Winner Takeaway (`winner_takeaway`)
What the winner actually receives in cash.

```
winner_takeaway = pool_amount − bid_amount
```

> Example: ₹1,00,000 − ₹16,000 = ₹84,000.

### Admin Commission (`admin_commission`)
The foreman fee retained by the admin offline in cash. Computed on the **full pool amount**, not on the bid.

```
admin_commission = pool_amount × admin_commission_rate
```

> Example: 5% × ₹1,00,000 = ₹5,000. This is collected offline and never enters the basket.

### Basket Credit (`basket_credit`)
The net amount credited to the group's basket after the admin takes their commission.

```
basket_credit = bid_amount − admin_commission
```

> Example: ₹16,000 − ₹5,000 = ₹11,000 goes to the basket.

### Three-Way Split (per regular cycle)
| Component | Formula | Example |
|---|---|---|
| Winner takeaway | `pool_amount − bid_amount` | ₹84,000 |
| Admin commission | `pool_amount × commission_rate` | ₹5,000 |
| Basket credit | `bid_amount − admin_commission` | ₹11,000 |
| **Total** | | **₹1,00,000** |

### Admin Withdrawal
A special one-time power the admin holds. When the admin selects themselves as winner **and** explicitly opts in at record time, they receive **100% of the pool** (`winner_takeaway = pool_amount`). No bid is entered, no commission is taken, nothing goes to the basket. Tracked via `admin_withdrawal_used` on the membership — can only happen once per group.

---

## Members & Shares

### Membership
A user's participation in a specific group. Holds their role (Admin/Member), share count, wins count, and status (Pending / Active / Removed).

### Share Count (`share_count`)
How many shares a member holds in the group. Affects how much they pay per cycle and how many times they can win.

- Pays `share_count × monthly_contribution` per month.
- Can win up to `share_count` times across the entire cycle.
- Receives a share-weighted portion of the basket on closure.

### Wins Count (`wins_count`)
How many times a member has won so far. A member is ineligible to win again once `wins_count >= share_count`.

When every active member's `wins_count` reaches their `share_count`, all shares are exhausted. Closing the cycle at that point triggers an **automatic group closure** (provided no active loans remain).

### X Chiti
A cycle mode where more than one winner is recorded in the same month, enabled when the basket has grown large enough to fund multiple payouts.

- `x_chiti = floor(total_basket / pool_amount) + 1`. Always ≥ 1.
  - `x_chiti = 1` → normal single-winner cycle (basket < pool_amount).
  - `x_chiti = 2` → Double Chiti (basket >= pool_amount).
  - `x_chiti = 3` → Triple Chiti (basket >= 2 × pool_amount), and so on.
- `total_basket = realized (basket balance) + unrealized (active loan principals + outstanding accrued interest)`.
- The X Chiti eligibility banner is shown on the Record Winner screen only when `x_chiti ≥ 2`.
- Each winner is recorded as a separate `cycle_winners` row with their own bid, commission, basket credit, and takeaway. A member can win at most once per cycle regardless of their share count.

### Eligible Winner
A member who can be selected as winner for the current cycle. Must satisfy:
1. `wins_count < share_count` (has at least one un-won share remaining), **AND**
2. No active loan in this group.

---

## Basket & Loans

### Basket
A communal kitty that accumulates bid savings over the life of the group. Runs as a ledger — every credit and debit is recorded as a basket transaction. One basket per group.

### Basket Balance (`current_balance`)
The current net cash available in the basket. Increases with bid credits and loan interest; decreases with loans disbursed and skip-month payouts.

### Basket Transaction Types
| Type | Direction | When |
|---|---|---|
| `CREDIT_DISCOUNT` | Credit | Regular cycle closes — `basket_credit` added |
| `DEBIT_SKIP_MONTH` | Debit | Basket funds the winner of a skip-month cycle |
| `LOAN_DISBURSED` | Debit | Admin gives a loan to a member |
| `LOAN_REPAID` | Credit | Borrower repays principal |
| `INTEREST_ACCRUED` | Credit | Monthly interest earned on an active loan |
| `CLOSURE_SPLIT` | Debit | Final distribution to members on chit closure |
| `ADJUSTMENT` | Credit or Debit | Manual correction by admin (requires a reason note) |

### Loan
A cash advance from the basket to a member. Carries a monthly simple interest rate inherited from the group. The first month's interest is deducted upfront — borrower receives `principal − (principal × monthly_interest_rate)`.

**Rules:**
- Member must have at least one un-won share (`wins_count < share_count`) to borrow.
- Principal can only be repaid in full (no partial repayments).
- Member with an active loan is excluded from the eligible-winners list.
- All loans must be fully repaid before the group can be closed.

### Outstanding Interest
`total_interest_accrued − total_interest_paid`. Borrowers can let this accumulate and pay cumulatively — there is no hard monthly deadline for interest payments.

### Max Loan Cap
```
min(basket_balance, (share_count − wins_count) × (pool_amount / total_shares))
```

### Closure Split
When the chit closes, the remaining basket balance is distributed to all members proportional to their share count:
```
member_share = (basket_balance × member.share_count) / total_shares
```
Recorded as `CLOSURE_SPLIT` ledger entries.

Group closure happens either manually (admin calls close-group) or **automatically** when closing a cycle exhausts all member shares and no active loans remain.

---

## Payments

### Payment
One row per member per cycle tracking whether they paid their contribution. Status: `Unpaid`, `Paid`, or `Waived` (skip-month cycles only).

### Expected Amount (`expected_amount`)
What a member owes for a given cycle: `monthly_contribution × share_count`. Zero for skip-month cycles.

### Waived
Payment status set automatically for all members on a skip-month cycle — no contribution is due.

---

## Roles & Admin

### Admin
The person who created and manages a group. Single admin per group in v1. Always also a regular contributing member.

### Admin Commission Rate (`admin_commission_rate`)
The percentage of `pool_amount` the admin retains as a foreman fee each regular cycle. Set at group creation; cannot be changed after cycle 1 starts.

### Payment Due Day (`payment_due_day`)
The day of month (1–28) on which all member payments (contributions + loan interest) are due every cycle.

---

## Monetary Conventions

- **All monetary values are stored in integer paise** (₹1 = 100 paise). Floats are never used.
- Display formatting converts paise to rupees: `₹1,00,000` = `10000000` paise in the DB.
- The API sends and receives all money fields as integers in paise.
