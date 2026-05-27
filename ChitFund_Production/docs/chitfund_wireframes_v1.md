# ChitFund App — UI Wireframes (v1)

**Status:** Draft v12 (admin withdrawal refined — Screen 5 shows toggle for withdrawal vs regular bid when admin is selected; one-time-use guard shown; Screen 11 distinct outcome card)
**Scope:** 11 screens that anchor the API design
**Last updated:** 2026-05-20

---

## How to read this doc

This document describes the screens that hypothetical clients (PWA / Android / future iOS) will render against the API. **The backend project does not implement any of this** — but each screen tells you what data the corresponding endpoints must return and what user actions they must support.

For each screen:
- **Purpose** — why this screen exists and who sees it.
- **Layout** — the visible structure top-to-bottom.
- **Data needed** — fields the API must expose.
- **Actions** — what the user can do, mapped to API endpoints.
- **Authorization** — who can access this screen.

When designing an endpoint, search this doc for the screen that consumes it. If a screen needs data your endpoint doesn't return in one call, your endpoint is the problem (N+1 fetches make UI slow).

---

## Screen 1: Home / Group list

**Purpose:** First screen after login. Shows all groups the user belongs to (admin or member), plus a quick summary of pending dues across all groups.

**Authorization:** Any authenticated user.

**Layout, top to bottom:**
1. **Header bar** — user avatar with initials, name, mobile number, notification bell (with red dot if unread), settings cog.
2. **Two summary tiles** — "Active groups" count and "Pending dues" total in INR. The dues number is shown in red as a nudge.
3. **Search bar** — filters group list by group name.
4. **Filter pills** — `All / Admin / Member` with counts. Default is `All`. Used to scope which groups are shown.
5. **Sort button** — top-right of pills row.
6. **Group rows** — each row shows:
   - Group name + role badge (purple "Admin" or neutral "Member").
   - Status pill on the right: `2 due` (red — admin sees defaulter count), `Pay by 28` (amber — member sees due date), `Paid` (green — current month settled), or `Not yet started` (gray).
   - Subtitle: "Month X of N · ₹Y/share · Z people · W shares".
7. **Closed groups** — listed at the bottom in a dimmed "CLOSED" subsection with the close date.
8. **Bottom action buttons** — `+ Create group` and `Join with code`.
9. **Bottom nav bar** — Home / Activity / Profile.

**Data needed (one API call should return all of this):**
```
For each group the user belongs to:
- group_id, name, status (Active|Closed)
- role of current user (Admin|Member)
- share_count of current user
- monthly_contribution, total_shares, total_months
- current cycle: { month_number, status, due_date }
- current_user_payment_status_this_month (Paid|Unpaid|Waived|N/A)
- defaulters_count_this_month (admin only — show 0/null for members)
- closed_at (if closed)

Plus per-user aggregates:
- total_pending_dues (sum of unpaid expected_amount across all groups)
- active_groups_count
```

**Actions:**
- Tap a group row → opens that group's dashboard (screen 2 or 3 based on role).
- Tap notification bell → notifications inbox.
- Tap settings cog → user settings.
- Tap "Create group" → screen 7.
- Tap "Join with code" → join modal (enter `invitation_code` → calls `POST /groups/join`).
- Tap filter pill → filters group list client-side (no API call).
- Type in search bar → filters group list client-side.

**API endpoints used:**
- `GET /groups?role=...&status=...&q=...` — primary data source.
- `GET /me/notifications?unread=true` — for the unread count on the bell.

---

## Screen 2: Group dashboard (Admin view)

**Purpose:** Admin's command center for one group. Shows the current month's status and the most-frequent admin actions.

**Authorization:** User must be the admin of this group.

**Layout, top to bottom:**
1. **Header bar** — back arrow, info icon (group settings), three-dot menu (rename, transfer admin, close group, rotate invitation code).
2. **Group header block** — group name + Admin badge. Subtitle: "5 people · 10 shares · ₹10,000/share · Pool ₹1,00,000". Progress bar showing month X of N.
3. **Current month panel** (gray background, sets it apart):
   - Heading: "Current month — Apr 2026".
   - Status pill: `Open · Due Apr 28` or `Closed`.
   - Four metric tiles in a 2×2 grid:
     - **Collected:** "₹80,000" + "3 of 5 paid".
     - **Pending:** "₹20,000" in red + "2 defaulters".
     - **Winner:** if recorded, shows winner's name + bid; if not, shows "Not recorded · Tap to add ↗".
     - **Basket:** current balance + "+₹X earned" (interest from active loans).
4. **Quick actions** — 2×2 grid of buttons:
   - Mark payments (→ screen 4)
   - Record winner (→ screen 5)
   - Remind defaulters (sends notifications via API)
   - Basket & loans (→ screen 6)
5. **Recent activity** — last 5 events with timestamps. "Ramesh paid ₹20,000 · Today 2:14 PM". Tap "View all" → full audit log.
6. **Bottom strip** — secondary navigation: Members / History / Analytics / Reports.

**Data needed:**
```
Group object:
- group_id, name, status
- people_count, total_shares, monthly_contribution, pool_amount
- current_month_number, total_months
- current_cycle: {
    cycle_id, month_number, month_label, due_date, status,
    is_skip_month, winner_user_id (or null),
    bid_amount (or null), winner_takeaway (or null),
    collected_amount, pending_amount,
    paid_count, total_member_count, defaulters_count
  }
- basket: { current_balance, total_interest_earned }

Recent activity (last 5 events, from GET /groups/:group_id/activity?limit=5):
- id, event_type, actor_id, actor_name
- summary (assembled by API from event_type + data + actor_name)
- data (structured payload — amounts in paise, e.g. { month_label, bid_amount })
- created_at
```

**Actions:**
- Mark payments → screen 4.
- Record winner → screen 5.
- Remind defaulters → `POST /groups/:id/cycles/:cycle_id/remind-defaulters`.
- Tap Winner tile (if not recorded) → screen 5.
- Tap Basket tile → screen 6.
- Three-dot menu items → various group-level endpoints.
- Bottom nav → secondary screens.

**API endpoints used:**
- `GET /groups/:group_id` — main detail.
- `GET /groups/:group_id/activity?limit=5` — recent activity feed.

---

## Screen 3: Group dashboard (Member view)

**Purpose:** What a non-admin member sees for the same group. Read-only summary of "did my payment land, who won, and what's my position?"

**Authorization:** User must be a member (not the admin) of this group.

**Layout, top to bottom:**
1. **Header bar** — back, info icon (no three-dot menu — members can't modify).
2. **Group header** — name + Member badge. Subtitle includes "Admin: <admin name>" so members know who to contact about cash payments.
3. **"Your status this month" panel** (white card on gray surface):
   - Heading: month name (e.g., "Apr 2026").
   - Status pill: Pending / Paid / Waived.
   - Big amount: "₹10,000 to pay" (or ₹0 if waived).
   - Info banner: "Pay <admin name> in cash. They'll mark you as paid."
4. **"This month's winner" panel** (purple-tinted card):
   - Avatar + name + "Won bid ₹X" + "₹Y to admin · ₹Z to basket" (three-way breakdown always shown).
   - If winner not yet recorded: "Winner not yet recorded — admin will update soon."
5. **"Group basket" panel:**
   - Big number: current basket balance.
   - "+₹X grown" indicator.
   - Right-aligned: "Your share if closed today: ₹Y" (computed: `basket_balance × your_share_count / total_shares`).
6. **"Your payment history" panel** — last 3 cycles with month, amount, status pill. Skip months show "Waived" with ₹0.
7. **Recent activity** — last 5 group events with timestamps. Same feed as the admin sees — full transparency. "Suresh won Apr 2026 · bid ₹15,000 · Today 2:17 PM". Tap "View all" → full activity log.
8. **Bottom strip** — Members / All winners / My loans (if any).

**Data needed:**
```
Group object (subset visible to members):
- group_id, name
- people_count, total_shares, monthly_contribution
- admin: { user_id, name }
- my_membership: { share_count, wins_count }
- current_cycle: { month_number, month_label, due_date, status, is_skip_month,
    my_payment: { expected_amount, paid_amount, status, paid_at },
    winner: { user_id, name } or null,
    bid_amount or null,
    admin_commission or null,
    basket_credit or null
  }
- basket: { current_balance, my_projected_closure_split }
- my_payment_history (last 3 by default): list of { cycle_month_label, expected_amount, status, paid_at, is_skip_month }
- my_active_loans_count (for showing "My loans" tab)

Recent activity (last 5 events, same shape as admin — see Screen 2):
- id, event_type, actor_id, actor_name, summary, data, created_at
```

**Actions:**
- Tap "All winners" → full winners ledger screen.
- Tap "Members" → member list (read-only).
- Tap "My loans" (if count > 0) → loan detail.
- Tap "View all" on payment history → full payment history.
- Tap "View all" on recent activity → full activity log.

**API endpoints used:**
- `GET /groups/:group_id` — same endpoint as admin, returns member-scoped fields automatically.
- `GET /groups/:group_id/members/:user_id/payments?limit=3` — recent payment history.
- `GET /groups/:group_id/activity?limit=5` — recent activity feed (same endpoint as admin).

---

## Screen 4: Mark payments

**Purpose:** Admin marks who has paid for the current month. Most-frequented admin screen.

**Authorization:** Admin only.

**Layout, top to bottom:**
1. **Header bar** — back arrow, "Mark payments", group name on right.
2. **Cycle selector** — `‹ Mar` | "Apr 2026" | `May ›`. Forward arrow disabled if current month is the latest open cycle. Status pill: `Open` or `Closed`.
3. **Two summary tiles** — Collected vs total, "8 of 10 paid" indicator.
4. **Progress bar** — green fill showing collection progress.
5. **Filter pills** — `All / Unpaid / Paid` with counts. Plus "Mark all paid ↗" shortcut on the right.
6. **Member rows** — each row:
   - Initials avatar (green tint if paid, red tint if unpaid).
   - Name + "(you)" suffix if it's the admin themselves.
   - Subtitle: "Today, 2:14 PM" (paid timestamp) or "Overdue · last paid Mar 26".
   - Status pill: Paid / Unpaid.
   - Toggle switch on far right.
   - Unpaid rows have a light red row background.
7. **Bottom action bar** — "Remind N unpaid" + "Done".

**Data needed:**
```
List of all members for the selected cycle:
- payment_id, member_user_id, member_name
- share_count
- expected_amount (= monthly_contribution × share_count)
- paid_amount, status, paid_at, marked_by_name
- last_paid_cycle_month_label (for "Overdue" subtitle when unpaid)

Cycle metadata:
- cycle_id, month_number, month_label, due_date, status
- collected_amount, pending_amount, paid_count, total_count

Available cycles: list of past + current cycle_ids and labels for the selector.
```

**Actions:**
- Toggle a row → `PATCH /groups/:group_id/payments/:payment_id` with `{status: 'Paid'}` or `{status: 'Unpaid'}`. Optimistic UI update + 5-second undo snackbar.
- Long-press a row → opens detail sheet for backdating, partial amounts, notes. Calls same PATCH with more fields.
- "Mark all paid" → confirmation dialog → `POST /groups/:group_id/cycles/:cycle_id/payments/bulk` with `{payment_ids: 'all_unpaid', status: 'Paid', paid_at: now}`.
- Cycle selector arrows → reload screen with different `cycle_id`.
- "Remind N unpaid" → `POST /groups/:group_id/cycles/:cycle_id/remind-defaulters`.

**API endpoints used:**
- `GET /groups/:group_id/cycles/:cycle_id/payments` — list.
- `PATCH /groups/:group_id/payments/:payment_id` — toggle one.
- `POST /groups/:group_id/cycles/:cycle_id/payments/bulk` — mark many.
- `POST /groups/:group_id/cycles/:cycle_id/remind-defaulters` — send reminders.

---

## Screen 5: Record winner / Declare skip month

**Purpose:** Admin records the outcome of the monthly chit auction. Two paths: "Regular month" (member wins, bid goes to basket) or "Skip month" (basket pays the pool, members owe nothing).

**Authorization:** Admin only.

**Layout, top to bottom:**
1. **Header bar** — back, "Record month outcome", cycle label (e.g., "Apr 2026") on right.
2. **(When eligible) Double Chiti eligibility banner** — amber/gold card shown at the top when `double_chiti ≥ 2`. Example: `"SunRise group is eligible for Double Chiti"`. Sub-text: `"Total basket ₹2,04,200 · Pool ₹1,00,000 · 2 winners this cycle"`. Hidden when `double_chiti < 2`.
3. **Outcome toggle** — two cards side-by-side: "Regular month" (default selected) vs "Skip month". Selecting "Skip month" reshapes the form below.
4. **(Regular month — Double Chiti eligible) Winner slots** — when `double_chiti ≥ 2`, the form shows X numbered bid-entry blocks stacked vertically, e.g. "Winner 1", "Winner 2". Each block has its own winner picker + bid amount input + math preview. Admin can fill them in any order. Blocks not yet filled show dimmed placeholder text. When `double_chiti = 1`, only a single block (no numbering) is shown — the original UX.
5. **Winner picker (per block)** — dropdown labeled "Winner (eligible members)". Shows only members where `wins_count < share_count` AND not already picked in another block this cycle. Subtitle: "7 of 10 still eligible · 3 already won". Each option shows the person's avatar, name, and remaining wins. The admin's own name appears with a "(you)" suffix.
6. **(When admin selects themselves) Admin withdrawal toggle (per block)** — a toggle labeled "Use special share (admin withdrawal)". When ON: bid input is hidden and the withdrawal math preview is shown. Disabled with a note if already used.
7. **(Regular month — withdrawal OFF) Winning bid amount (per block)** — currency input. Helper text: "The amount the winner is leaving for the basket. Highest bid won."
8. **Math preview panel (per block)** (purple-tinted, live-updates as admin types):
   - **Regular member winner OR admin winning via normal bid:**
     - Pool amount: ₹1,00,000.
     - Winning bid (sacrifice): ₹16,000 (from input).
     - Admin commission (5% of pool): ₹5,000 — "Admin keeps this in cash".
     - Goes to basket: ₹11,000 (bid − commission).
     - Suresh takes home: ₹84,000 (pool − bid).
     - Basket after this winner: shows running basket balance after each block.
     - All three split lines always shown even when `admin_commission_rate = 0`.
   - **Admin withdrawal (toggle ON):** "Admin withdrawal — full pool (special share)". Admin takes ₹1,00,000. Commission: ₹0 · Basket: ₹0.
9. **(Skip month only) Skip-month math preview** — "Basket has ₹38,000. Need ₹1,00,000." Red banner if insufficient; "Pool ₹1,00,000 debited from basket" if sufficient.
10. **Notes field** — optional, per block. Placeholder: "e.g. bid happened on Apr 26, 7 PM. Runner-up: Ramesh ₹14,000".
11. **Warning banner** — "Saving will mark [winners] as having won and notify all members."
12. **Action bar** — Cancel / Save winner(s) (filled primary). The Save button is disabled until at least one block is fully filled (winner + bid).

**Data needed:**
```
For the cycle being recorded:
- cycle_id, month_label, pool_amount

Eligible winners list:
- For each membership: { user_id, name, share_count, wins_count, is_eligible, role, admin_withdrawal_used }

Double Chiti eligibility:
- GET /groups/:group_id/chiti-eligibility → { double_chiti, label, eligible, total_basket, realized, unrealized }

Basket state:
- current_balance (for skip-month gating and running basket preview)
```

**Actions:**
- Toggle between Regular / Skip month → reshapes form.
- Type bid amount in any block → math preview for that block updates client-side. Running basket balance updates across all blocks.
- Save (Regular bid, any winner including admin without toggle) → `POST .../record-winner` once per filled block, sequentially.
- Save (Admin withdrawal, toggle ON) → same endpoint with `{winner_user_id: <admin-id>, bid_amount: 0, is_admin_withdrawal: true, notes}`.
- Save (Skip) → `POST /groups/:group_id/cycles/:cycle_id/declare-skip-month` with `{winner_user_id, notes}`.
- After all saves → redirect to admin dashboard.

**API endpoints used:**
- `GET /groups/:group_id/chiti-eligibility` — Double Chiti banner + slot count.
- `GET /groups/:group_id/members?eligible_to_win=true` — winner picker options.
- `GET /groups/:group_id/basket` — for skip-month gating.
- `POST .../record-winner` (called once per winner slot) or `POST .../declare-skip-month`.

---

## Screen 6: Basket & loans

**Purpose:** Group's communal-kitty view. Headline numbers + active loans + recent ledger. Admins also act on the basket here (new loan, repayment, adjustment, declare skip month).

**Authorization:** Any group member. Admin sees operational fields and action buttons; members see a personal projected share and read-only loans/ledger filtered to themselves.

**Layout — admin view, top to bottom:**

1. **Header bar** — back arrow, "Basket & loans", group name on right.

2. **Headline balance card** (purple panel — Tier 1):
   - **Big number:** current basket balance.
   - **Three sub-stats** below the big number, in a row: `Total credited` / `Total debited` / `Lent out`. Lets admin verify that `current_balance = total_credited − total_debited`.

3. **Secondary metrics row** (Tier 2 — three small tiles):
   - **Interest earned:** total_interest_earned (lifetime).
   - **Skip months used:** "1 of 10" (skip_months_used / total_months).
   - **Active loans:** active_loans_count (e.g., "2 loans").

4. **Quick actions row** — four buttons: `New loan` / `Record repayment` / `Skip month` / `Adjust basket`.

5. **Tab pills** — `Active loans / Ledger / Closed loans`.

6. **Loan rows** (Active loans tab):
   - Each row: avatar + borrower name + status badge (Active / WrittenOff).
   - Subtitle: "₹15,000 at 3% · disbursed Mar 18".
   - Three sub-tiles: **Outstanding principal** / **Interest outstanding** (cumulative unpaid interest = accrued − paid; shown in amber if > 0) / **Expected close date**. There is no "overdue" state for interest — borrowers can pay interest cumulatively at any time, so "Interest outstanding: ₹X" is informational, not a deadline alert.

7. **Recent ledger entries** (Ledger tab) — 3 most recent transactions with directional icons (green credit, amber debit), description, amount, date. "View full ledger" link.
   - **Deep-link filter support:** when entered with a `cycle_id` parameter (from Screen 11's "View ledger entry" link), the Ledger tab is auto-selected and entries are filtered to that cycle. A small chip "Filtered to <month_label>" with a clear button is shown above the list so the user knows the filter is active and can dismiss it.

**Layout — member view, top to bottom:**

Same overall structure, with these differences:

1. **Headline balance card** — shows two numbers stacked:
   - **Current basket balance** (group-level value, same as admin sees).
   - **Your share if closed today** — the member's projected closure-split share (`current_balance × your share_count / total_shares`). This is the personally meaningful number.
   - The three operational sub-stats (`Total credited / Total debited / Lent out`) are **hidden** on the member view.

2. **Secondary metrics row** — two tiles only:
   - **Interest earned:** group-level total_interest_earned. Same number admin sees — it's a group property, not a per-member allocation.
   - **Skip months used:** same as admin.
   - The `Active loans` tile is hidden (members shouldn't see how many loans exist across the group).

3. **No Quick actions row.**

4. **Tab pills** — `My loans / Ledger`. The "Closed loans" tab is dropped for members (they only see their own; closed = repaid, which is Loan history, not a separate tab in this view).

5. **Loan rows** show only loans where `borrower_user_id = current_user.id`.

6. **Ledger entries** filtered to entries that involve the current user (their own loans, basket adjustments affecting them, their closure split).

**Why this split:**
- Admin needs to *operate* the basket — they see the operational numbers (credited/debited/lent out) and counts (active loans) needed to run the group.
- Members need to *trust* the basket — they see the headline balance, their personal projected share, group interest earned, and skip-month count. Enough to verify the basket is doing real work; not so much that they see other members' loan amounts or operational internals.

**Data needed:**
```
Basket overview (admin response):
- basket_id, current_balance
- total_credited, total_debited, total_lent_out, total_interest_earned
- active_loans_count
- skip_months_used
- last_recomputed_at

Basket overview (member response):
- basket_id, current_balance
- total_interest_earned
- skip_months_used
- my_share_if_closed_today  // computed: current_balance × member.share_count / total_shares
- last_recomputed_at

Active loans (admin: all; member: only their own):
- loan_id, borrower_user_id, borrower_name
- principal, outstanding_principal, interest_rate
- total_interest_accrued, total_interest_paid, outstanding_interest  // outstanding_interest = accrued − paid
- disbursed_at, expected_close_date, status, next_cycle_due_date

Ledger entries (paginated, filter by type and/or cycle_id; member response is auto-scoped):
- txn_id, txn_type, direction, amount, cycle_month_label, counterparty_name, notes, created_at
```

**Actions (admin only):**
- New loan → opens modal with member dropdown + amount + interest rate. `POST /groups/:group_id/loans`.
- Record repayment → loan picker. Admin enters `interest_paid` (any amount up to `outstanding_interest` — can be partial or full cumulative payoff) and/or `principal_repaid` (full outstanding only). `POST /groups/:group_id/loans/:loan_id/repay`.
- Skip month → routes to Screen 5 with skip-month tab pre-selected.
- Adjust basket → opens modal: direction (C/D), amount, mandatory notes. `POST /groups/:group_id/basket/adjustments`. Triggers BASKET_ADJUSTED notification.
- Tap a loan row → loan detail screen.

**Actions (member):**
- Tap a loan row → own loan detail screen (read-only).
- Filter chip clear (when deep-linked from Screen 11) → removes the cycle_id filter on the Ledger tab.

**API endpoints used:**
- `GET /groups/:group_id/basket` — overview (response shape varies by role).
- `GET /groups/:group_id/loans?status=active` — loans list (server filters by current user for members).
- `GET /groups/:group_id/basket/transactions[?cycle_id=...]` — ledger.
- `POST /groups/:group_id/loans` — new loan (admin).
- `POST /groups/:group_id/loans/:loan_id/repay` — record repayment (admin).
- `POST /groups/:group_id/basket/adjustments` — manual adjustment (admin).

**Things deliberately NOT shown (logged here so we don't re-invent them):**
- *Per-member interest allocation.* Interest earned belongs to the basket, not individuals. Showing a "your share of interest" number would imply interest has been distributed when it hasn't. Members get their share at chit closure, via the closure-split.
- *Top contributors / leaderboard.* Surfacing who paid late socially is a cultural risk; we don't gamify defaulting.
- *Basket health score / trend chart.* Defer to Phase 2 analytics — adds chart complexity for a number that's already visible from period-over-period basket reads.

---

## Screen 7: Create group

**Purpose:** First step for an admin starting a new chit. Sets the group's parameters (which become locked once cycle 1 starts).

**Authorization:** Any authenticated user.

**Layout, top to bottom:**
1. **Header bar** — close (X), "Create new group".
2. **Group name** — text input.
3. **Contribution per share, per month** — currency input. Helper: "A person who holds 2 shares would pay ₹20,000 every month."
4. **Total shares in the chit** — number stepper (− N +). Info banner explains: "10 shares = 10 monthly cycles. You can have fewer than 10 people if some hold multiple shares (e.g. 5 people with 2 shares each)."
5. **Your shares in this chit** — number stepper (− N +). Min 1, max `total_shares`. Defaults to 1. Updates dynamically — if the admin later reduces total shares below the selected value, this clamps down automatically. Helper: "You'll pay ₹[contribution × N]/mo." (live, updates as either stepper changes).
6. **Start month** — month picker. Helper: "Chit will run May 2026 — Feb 2027".
7. **Admin commission rate** — percentage input. Default 0%. Helper: "Your cut from each month's pool. Example: 5% on a ₹1,00,000 pool = ₹5,000 to you, regardless of the winning bid. Visible to all members. Locked once cycle 1 starts."
8. **Loan interest range** — two number inputs (Min % / Max %). Defaults 2% and 5%. Helper: "Per-loan rate is set when you disburse a loan, within this range."
9. **Group summary panel** (purple, live-updating preview):
   - Pool per month: ₹1,00,000 (computed = contribution × shares).
   - Total cycles: 10 months.
   - "Your share (N shares): ₹[contribution × N]/mo" — N is the value from stepper 5, updates live.
   - Invitation code: "CF7K2X9P" (auto-generated post-create, in monospace font).
10. **Warning banner** — "After cycle 1 starts, contribution, total shares, and admin commission are locked. You can still rename the group anytime."
11. **Action bar** — Cancel / Create group (filled primary).

**Data needed:** None on entry. After create, response provides:
```
- group_id, name, invitation_code
- pool_amount, monthly_contribution, total_shares, total_months
- start_month
- admin_commission_rate
- interest_rate_min, interest_rate_max
- creator_membership_id (the admin's auto-created membership)
- admin_share_count (the share count the admin selected; default 1)
```

**Actions:**
- Type in inputs → live update of the summary panel.
- Adjust total shares stepper → clamp admin share count if it now exceeds total shares.
- Cancel → back to home.
- Create group → `POST /groups` with full payload including `admin_share_count`. On success, redirects to screen 8 (Add members) so admin can fill remaining shares.

**API endpoints used:**
- `POST /groups`.

---

## Screen 8: Add members

**Purpose:** After creating a group, admin invites people to fill the shares. Same screen is reachable later from the group's secondary nav (Members tab).

**Authorization:** Admin only.

**Layout, top to bottom:**
1. **Header bar** — back, "Members", group name on right.
2. **Shares filled panel** (purple, anchor):
   - "Shares filled — 7 of 10".
   - Progress bar.
   - Subtitle: "4 people · 3 shares left to fill".
3. **Search bar** — filters member list by name.
4. **Member rows:**
   - Initials avatar (maroon tint).
   - Name + "(you)" suffix if it's the admin.
   - Admin badge if applicable.
   - Subtitle: mobile number + "joined Apr 15" OR "Invited · waiting to join" (italics, dimmed) for pending invitees.
   - Share counter pill on the right: `− N +`. Stepper to adjust share count before cycle starts. Applies to all active members including the admin's own row. Disabled (grayed) for pending invitees and after cycle 1 starts.
5. **Pending join requests section** (admin view only, only shown when group is not yet locked and there is at least one pending request):
   - Section heading: "Pending requests (N)".
   - Each pending row:
     - Initials avatar (amber tint — visually distinct from active members).
     - Name + mobile number.
     - Subtitle: "Requested: N shares".
     - Two action buttons on the right: "Approve" (filled primary) and "Reject" (outlined).
   - **Approve flow (inline — no modal):** tapping "Approve" expands an action panel below that row with a share count stepper pre-filled with `requested_share_count` (admin can adjust; min 1, max remaining unfilled shares) plus "Cancel" and "Confirm approve" buttons. On confirm → calls approve endpoint → row moves out of pending list and the newly activated member appears in the active member list above. If the API returns a capacity error, an inline error message is shown and the row stays open.
   - **Reject flow (inline — no modal):** tapping "Reject" replaces the action buttons with "Reject this request?" text and two inline buttons — "Keep" (reverts) and "Yes, reject". On confirm → calls reject endpoint → row is removed from the pending list.
6. **"Add a new person" card** — two buttons: "By mobile" (opens modal) and "Share invite" (opens system share sheet). Hidden after cycle 1 starts.
7. **Invitation code panel** (purple) — always visible at bottom: shows the 8-char code in monospace + a Copy button.
8. **Action bar** — Save & close / Start cycle 1 (filled primary, **disabled until shares_filled === total_shares**).

**Data needed:**
```
Group state:
- group_id, name, total_shares, shares_filled, people_count
- invitation_code

Member list (Active members only):
- For each membership: {
    membership_id, user_id, name, mobile_number,
    role, share_count, wins_count, status,
    joined_at,
    is_invited (true if user has no account yet — placeholder)
  }

Pending join requests (admin only, loaded in parallel with member list):
- For each pending membership: {
    membership_id, user_id, name, mobile_number,
    requested_share_count,
    joined_at  (request submitted_at)
  }
```

**Actions:**
- Adjust share count via stepper (active member row, including admin's own row) → `PATCH /groups/:group_id/members/:membership_id` with `{share_count: N}`.
- Tap "By mobile" → modal: name + mobile + share_count. Submits → `POST /groups/:group_id/members`. Backend either adds existing user directly or sends SMS invite + creates placeholder membership.
- Tap "Share invite" → opens native share sheet with link "Join <group name> with code <code> at chitfund.app".
- Tap "Copy" on code panel → copies to clipboard.
- Approve a pending request (with optional share count change) → `POST /groups/:group_id/join-requests/:membership_id/approve` with `{share_count: N}`. On success the pending row is removed and the newly active member is appended to the active list without a full reload.
- Reject a pending request → `POST /groups/:group_id/join-requests/:membership_id/reject`. On success the pending row is removed.
- Tap "Start cycle 1" (only enabled when shares are full) → `POST /groups/:group_id/start`.

**API endpoints used:**
- `GET /groups/:group_id/members` — active member list.
- `GET /groups/:group_id/join-requests` — pending requests (admin only).
- `POST /groups/:group_id/members` — add new by mobile.
- `PATCH /groups/:group_id/members/:membership_id` — adjust share count.
- `DELETE /groups/:group_id/members/:membership_id` — remove (soft).
- `POST /groups/:group_id/join-requests/:membership_id/approve` — approve request.
- `POST /groups/:group_id/join-requests/:membership_id/reject` — reject request.
- `POST /groups/:group_id/start` — begin cycle 1.

---

## Screen 9: Profile

**Purpose:** User's own account screen. Identity, password change, app preferences, active sessions, and sign-out.

**Authorization:** Any authenticated user. Shows only the current user's own data — never anyone else's.

**Layout, top to bottom:**

1. **Header bar** — back arrow, "Profile". No actions on the right.

2. **Identity card** (white card with 0.5px border):
   - Large avatar (initials, ~64px circle).
   - Name in 18px font, weight 500.
   - Mobile number in 13px secondary text.
   - Username in 13px secondary text (or "No username set" link to add one).
   - "Member since Apr 2026" small caption underneath.
   - On the far right, a small "Edit" button (pencil icon) → opens edit modal for name + username.

3. **Section: Account** (heading in 11px uppercase muted text):
   - **Row: Change password** — chevron on right. Tap → opens modal: current password + new password + confirm new password fields. Submits → `POST /me/change-password`.

4. **Section: Notifications**:
   - **Row: Notification preferences** — chevron on right. Tap → secondary screen listing every group the user belongs to + a global "All groups" toggle at top. Each row has a mute toggle. State stored via `PUT /me/notification-preferences`.

5. **Section: Security**:
   - **Row: Active sessions** — chevron on right. Subtitle: "3 devices". Tap → secondary screen listing each refresh token / device with `device_info` ("Chrome on Pixel 7"), `last_used_at`, and a "Sign out" action per row (current device marked clearly, can't be revoked from here — must use sign-out button below).

6. **Spacer** — vertical gap (visual separation before the destructive action).

7. **Sign out button** — full-width red-tinted button with "Sign out" label. **Single tap → confirmation modal:**
   - Modal title: "Sign out?"
   - Modal body: "You'll need your password to sign in again on this device."
   - Two buttons: "Cancel" (neutral) and "Sign out" (red, destructive).
   - On confirm → `POST /auth/logout` with the current refresh token → clear local tokens → redirect to login screen.

8. **Footer** — small text at the bottom: "Chit Fund · v1.0.0" — useful for support ("which version are you on?").

**Data needed:**
```
GET /me response:
- user_id, name, mobile_number, username, mobile_verified
- created_at (for "Member since")

GET /me/sessions (loaded lazily when user taps "Active sessions"):
- list of { id, device_info, created_at, last_used_at, is_current }

GET /me/notification-preferences (loaded lazily):
- list of { group_id (or null for global), muted }
```

**Actions:**

- Tap **Edit** (on identity card) → modal with name + username inputs → `PATCH /me`.
- Tap **Change password** → modal → `POST /me/change-password`.
- Tap **Notification preferences** → secondary screen → toggles call `PUT /me/notification-preferences` per change.
- Tap **Active sessions** → secondary screen → "Sign out" on a row → `DELETE /me/sessions/:id`.
- Tap **Sign out** (main button) → confirmation modal → on confirm → `POST /auth/logout` → on success, client clears its access + refresh tokens from storage → redirect to login.

**API endpoints used:**
- `GET /me` — identity card.
- `PATCH /me` — edit name / username.
- `POST /me/change-password` — change password.
- `GET /me/sessions` — active sessions screen.
- `DELETE /me/sessions/:id` — revoke a specific session.
- `GET /me/notification-preferences` — load mute state.
- `PUT /me/notification-preferences` — update mute state.
- `POST /auth/logout` — sign out current device.

**Backend notes (not visible to user, but worth knowing):**

- **Sign out is single-device.** It revokes only the refresh token tied to the current session — other devices stay logged in. There's no "sign out everywhere" in v1; it's a Phase 2 feature if needed.
- **Confirmation modal is mandatory.** Single-tap sign-out is a footgun (accidental log-outs, especially on touch screens). Two taps with explicit confirm is the pattern.
- **After logout API call succeeds:** the access token (JWT) is still technically valid until its 15-min expiry — JWTs can't be revoked mid-flight. The client must delete it from local storage. The refresh token is the one we revoke server-side, so the user can't get a new access token. This is normal JWT behavior and acceptable for v1.
- **Edge case:** if the user is on a slow network and the logout API call fails, we still clear local tokens and redirect to login — better to err on the side of "user thinks they signed out and they did" than "user thinks they're out but their session is still active."

---

## Screen 10: History (cycle list)

**Purpose:** Reverse-chronological list of every cycle in the group. Lets the user see the full arc of the chit at a glance and drill into any month for detail.

**Authorization:** Any member of the group (admin or regular). Role affects nothing in v1 — the same data is shown to both.

**Reached from:** Bottom strip of group dashboard (admin view, screen 2) and equivalent secondary nav on member view (screen 3).

**Layout, top to bottom:**

1. **Header bar** — back arrow, "History", group name on right.

2. **Group context strip** (gray surface):
   - Single line: "Sunrise Chits 2026 · Month 4 of 10".
   - Sub-line: progress bar showing where in the cycle we are.

3. **Filter pills** (single horizontal row, combinable): `All / Regular / Skip / Open / Closed`. Counts shown in each pill.
   - **Default:** `All` is selected.
   - **Behavior:** `All` is mutually exclusive with the others — selecting any specific pill turns `All` off (and re-tapping `All` clears all other selections). The other four pills are **independently toggleable**, and when multiple are on the results match all of them (**AND**).
   - **Examples:** `Regular + Closed` → past regular cycles only. `Skip + Open` → an in-progress skip month (rare, but possible). `Regular + Skip` → all non-pending cycles regardless of type.
   - **Why combinable, not segmented:** at 10–24 cycles both axes (type and status) are useful; two filter rows would consume vertical space for a need most users don't have. Single row covers casual (one tap) and power (multi-select) use without UI overhead.

4. **Cycle rows** — most recent first. Each row:
   - **Left:** month label in 14px (e.g., "Apr 2026"), and a small status chip below: `Closed` (green), `Open` (amber), `Skip` (blue), or `Pending` (gray).
   - **Center:** winner info — avatar + name + small "Won bid ₹X" or "Skip month" or "No winner yet". Pending cycles show "Opens <due_date>".
   - **Right:** collected amount + payment ratio (e.g., "₹1,00,000 · 5/5 paid" in green if all paid, in red if any unpaid). Pending cycles show "—" (em-dash) instead of payment numbers.
   - **Tappability:**
     - `Closed`, `Open`, `Skip` rows: tappable → opens Screen 11 (Cycle detail).
     - `Pending` rows: **not tappable.** Render dimmed (~60% opacity), no chevron, no press feedback. Tap input is suppressed because Screen 11 has no useful content for a cycle that hasn't opened yet (no winner, no payments, no basket impact). If a v2 user need emerges (admins wanting to preview upcoming months), revisit and add a Pending-cycle preview state.

5. **Empty state** (if no closed cycles yet) — illustration + text: "No history yet. Once members start paying and a winner is recorded, history will appear here."

**Data needed:**
```
List of cycles for the group, ordered by month_number DESC:
- For each cycle:
  - cycle_id, month_number, month_label
  - status: 'Open' | 'Closed' | 'Pending'
  - is_skip_month
  - winner: { user_id, name } or null
  - bid_amount or null
  - admin_commission or null
  - basket_credit or null
  - winner_takeaway or null
  - collected_amount, expected_amount
  - paid_count, total_member_count
  - due_date

Plus group context:
- group_id, name, current_month_number, total_months
```

**Actions:**
- Tap a non-pending row (Closed / Open / Skip) → Screen 11 (Cycle detail).
- Tap a pending row → no-op (rows render but tap input is suppressed).
- Tap filter pill → client-side filter, no API call.

**API endpoints used:**
- `GET /groups/:group_id/cycles` — primary data source (already specced in api.md). The endpoint should return the fields above without N+1 follow-ups.

**Backend notes:**
- The aggregates `collected_amount`, `paid_count`, `total_member_count` should be computed in a single SQL query joining `monthly_cycles` to `payments` with `GROUP BY cycle_id`. Don't make the client compute them.
- Closed cycles immutable, so this query is highly cacheable. Open cycle changes frequently.
- Pending cycles (those past `current_month_number`) can be either pre-created in the DB at group creation or generated on-the-fly. Schema currently pre-creates them — the response just reflects the state.

---

## Screen 11: Cycle detail

**Purpose:** Drill-down view for a single cycle. Shows the full payment breakdown, winner info, basket impact, and any audit notes for that month.

**Authorization:** Any member of the group. Admins see "Edit" affordances on certain rows; members see read-only.

**Reached from:** Tapping a row in screen 10. Also reachable from the "Mark payments" cycle selector for past cycles.

**Layout, top to bottom:**

1. **Header bar** — back arrow, month label (e.g., "Apr 2026"), status chip on right (`Closed` / `Open` / `Skip`).

2. **Outcome card** (purple-tinted if winner recorded, gray if pending):
   - **Regular cycle — member winner:**
     - Heading: "Winner".
     - Avatar + name in large text.
     - Three metric tiles below: "Sacrificed ₹16,000", "Took home ₹84,000", and a split breakdown tile showing "Admin ₹5,000 (pool × 5%) · Basket ₹11,000".
     - Subtitle: "Recorded by <admin name> on Apr 26, 7:42 PM".
   - **Regular cycle — admin withdrawal** (`bid_amount = 0` and winner is the admin):
     - Heading: "Admin withdrawal".
     - Avatar + admin name + "(Admin)" badge.
     - Single metric tile: "Took home ₹1,00,000 (full pool)".
     - Sub-line: "Commission ₹0 · Basket ₹0".
     - Subtitle: "Recorded by <admin name> on Apr 26, 7:42 PM".
   - **Skip month:**
     - Heading: "Skip month".
     - Avatar + name + "Took ₹1,00,000 from basket".
     - Subtitle: "Declared by <admin name> on Apr 1".
   - **Pending (no winner yet):**
     - "Winner not yet recorded" placeholder text.
     - If admin viewing and cycle is current → "Tap to record →" link to screen 5.

3. **Basket impact card:**
   - **Regular (member winner):** "Basket: ₹38,000 → ₹49,000 (+₹11,000 this month)" — uses `basket_credit` (= bid_amount − admin_commission).
   - **Admin withdrawal:** "Basket: ₹38,000 → ₹38,000 (no change — admin took full pool)" — basket is unchanged; no ledger entry exists so the "View ledger entry →" link is hidden.
   - **Skip:** "Basket: ₹1,38,000 → ₹38,000 (−₹1,00,000 this month)".
   - Small "View ledger entry →" link → deep-links into **Screen 6 (Basket & loans)**, switches to the Ledger tab, and applies a `cycle_id=<this>` filter so only entries from this cycle are shown.

4. **Payments section** — heading "Payments (5/5 paid)" or "(3/5 paid)":
   - List of all members for this cycle. Each row:
     - Avatar + name + share_count badge if > 1 (e.g., "Priya S · 3 shares").
     - Status pill on the right side, with content next to it:
       - **Paid** (green pill): "₹30,000 · Apr 5, 2:14 PM" (paid_amount + paid_at).
       - **Unpaid** (red pill): "₹30,000 expected" (expected_amount, no timestamp).
       - **Waived** (blue pill, only on skip months): "—" (em-dash). No amount, no timestamp — the pill carries the meaning, and `expected_amount = 0` for waived rows.
   - Admin viewing a current/open cycle: rows tappable → opens long-press payment editor (same as screen 4). Waived rows are not tappable (nothing to edit on a skip month).
   - Admin viewing a closed cycle within the edit window (`is_editable: true`): rows tappable → audit log for that payment with an "Edit" button visible.
   - Admin viewing a closed cycle past the edit window (`is_editable: false`): rows tappable → audit log only, no "Edit" affordance.
   - Member viewing: rows are display-only.

5. **Notes section** (only shown if cycle has admin notes):
   - Block of italicized text in a subtle gray card.
   - Example: "Bid happened Apr 26, 7 PM. Ramesh bid ₹14,000 (runner-up)."

6. **Audit log expandable** — heading "Activity (3 events)" with chevron:
   - When expanded: list of edits for this cycle. Each entry: "Suresh K marked Priya as paid · Apr 5, 2:14 PM", "Suresh K corrected bid amount from ₹15,000 to ₹16,000 · Apr 27, 9:01 AM".
   - Collapsed by default. Useful for disputes, not for daily browsing.

**Data needed:**
```
Cycle full detail (one endpoint call):
- cycle_id, month_number, month_label, due_date, status, is_skip_month, opened_at, closed_at, notes
- winner: { user_id, name, avatar_initials } or null
- bid_amount, admin_commission, basket_credit, winner_takeaway
- recorded_by: { user_id, name } or null
- recorded_at
- is_editable: boolean
    // Computed server-side. True if cycle.status='Closed' AND now() < closed_at + 24h,
    // OR if cycle.status='Open'. Authoritative source — clients must not derive this
    // from closed_at locally (clock drift would let users see edit UI past the window).

Basket impact:
- balance_before, balance_after, delta
- related_txn_id (link to ledger)

Payments (one row per member):
- For each member: {
    payment_id, user_id, name,
    share_count,
    expected_amount, paid_amount,
    status, paid_at, marked_by_name, notes
  }
- Aggregate counts: paid_count, total_count, collected_amount

Audit log entries (loaded lazily when section expanded):
- For each event: { entity_type, action, changed_by_name, old_values, new_values, created_at }
```

**Actions:**

- Tap "View ledger entry" → deep-links to Screen 6 (Basket & loans), Ledger tab, with filter `cycle_id=<this>` applied.
- Tap a payment row (admin, open cycle) → payment edit sheet (long-press flow from screen 4).
- Tap a payment row (admin, closed cycle within 24h) → "Edit" affordance.
- Tap "Tap to record →" (admin, pending) → screen 5.
- Expand "Activity" section → loads audit log lazily.

**API endpoints used:**
- `GET /groups/:group_id/cycles/:cycle_id` — primary detail (extends list shape, see api.md §6).
- `GET /groups/:group_id/cycles/:cycle_id/payments` — payment breakdown.
- `GET /groups/:group_id/cycles/:cycle_id/audit-log` — when activity expanded. *Note: not in current api.md — may need adding when we get to audit log endpoints. Defer until then.*

**Backend notes:**

- The cycle detail endpoint should return enough data that the screen renders fully without N+1 calls. Specifically: the payments list should come back in the same response, not require a separate fetch. Performance matters because users will land on this screen frequently.
- The audit log lazy-load is intentional — it's bulky and rarely viewed. Don't include it in the main detail response.
- For a skip month cycle, payments still exist in the DB (one per member with `expected_amount = 0` and `status = 'Waived'`). Display them in the section but with the special "Waived" pill.
- Closed cycles are immutable except for the 24h post-record edit window. The `is_editable` flag in the response (see Data needed) is the authoritative signal for the admin's UI to show edit affordances.

---

## Cross-cutting UI patterns (informational only)

These appear across multiple screens. Backend doesn't implement them — listed so you understand what API contracts they imply.

### 1. Optimistic UI on toggles
Mark-payment toggles update visually immediately, then call the API. If the API fails, the UI reverts. This means PATCH endpoints should be fast (< 200ms p99) and idempotent.

### 2. Pull-to-refresh
List screens (home, members, payments) support pull-to-refresh. Just re-calls the GET. No special endpoint needed.

### 3. Status pill color conventions
- **Green** (`success`) — paid, completed, on track.
- **Amber** (`warning`) — pending, due soon.
- **Red** (`danger`) — overdue, defaulter, blocked.
- **Purple** (`info`) — admin role, winner highlights.
- **Gray** (`neutral`) — closed, inactive, default state.

### 4. Money display
All currency in INR with ₹ prefix. Backend returns paise (BIGINT), client formats for display. **Never** display raw paise to users.

### 5. Empty states
Every list screen should have a thoughtful empty state:
- Home with no groups: "You're not in any chit groups yet. Create one or join with an invite code."
- Mark payments before cycle started: "Cycle 1 hasn't started yet. Add all members first."
- Basket with zero balance: "The basket is empty — it'll grow as winners take their bids."

### 6. Error states
- Network errors: "Couldn't connect. Tap to retry."
- API errors: show backend's `error.message` field.
- 401 errors: redirect to login.
- 403 errors: "You don't have permission for this action."

### 7. Destructive action confirmations

Any action that **can't be undone with one tap** must show a confirmation modal first. This applies to:
- Sign out
- Remove a member
- Close a group
- Write off a loan
- Cancel a recorded winner (within edit window)
- Revoke an active session

The modal pattern is consistent: title states the action, body explains the consequence, two buttons (neutral Cancel + destructive Confirm in red).

Backend should not enforce this — confirmation is purely a client-side UX guard. The endpoint accepts the request unconditionally, the client just makes sure the user really meant it.

---

## What this document is NOT

- Not a Figma file. No pixel measurements.
- Not a CSS spec. No exact colors or fonts.
- Not a visual design — only structural and behavioral.
- Not implementation guidance for the frontend (that's the frontend team's job, in v2).

It exists so the **backend** can confidently build endpoints that satisfy what each screen needs.

---

*If a future feature requires data not described here, update this doc first, then update the API spec, then build.*
