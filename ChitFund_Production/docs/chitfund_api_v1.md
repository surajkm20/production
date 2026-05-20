# ChitFund App — API Specification (v1)

**Status:** Draft v9 (commission model corrected — admin_commission = pool_amount × rate; basket_credit = bid_amount; winner_takeaway = pool − bid − commission; all examples updated)
**Style:** REST over HTTPS
**Base URL:** `https://api.chitfund.app/v1`
**Auth:** JWT (access token in `Authorization: Bearer <token>` header)
**Last updated:** 2026-05-20

---

## Table of contents

1. [Conventions](#1-conventions)
2. [Auth](#2-auth) — signup, OTP, login, refresh, logout
3. [Users & profile](#3-users--profile)
4. [Groups](#4-groups) — create, list, detail, update, close
5. [Memberships](#5-memberships) — add, list, update shares, remove, transfer admin
6. [Cycles & winners](#6-cycles--winners) — list, record winner, skip month
7. [Payments](#7-payments) — list, mark paid, edit, history
8. [Basket & loans](#8-basket--loans)
9. [Notifications](#9-notifications)
10. [Reports](#10-reports)
11. [Analytics](#11-analytics)
12. [Errors](#12-errors)

---

## 1. Conventions

### Request/response format
- All requests and responses use `application/json` (except file downloads in §10).
- All money values are sent as **integer paise** (₹1 = 100 paise). Never floats.
- Timestamps are **ISO 8601 in UTC** (e.g., `2026-04-23T14:30:00Z`).
- Dates (no time) use `YYYY-MM-DD`.
- All IDs are UUIDs.

### Pagination (list endpoints)
List endpoints accept:
- `limit` (default 20, max 100)
- `cursor` (opaque string from previous response)

Response shape:
```json
{
  "data": [ ... ],
  "next_cursor": "eyJpZCI6Ii4uLiJ9",
  "has_more": true
}
```

### Auth header
All endpoints except those marked **[public]** require:
```
Authorization: Bearer <access_token>
```

### Standard response envelope
Success:
```json
{ "data": { ... } }
```
Error: see [§12 Errors](#12-errors).

### Idempotency
Mutating endpoints (POST/PUT/PATCH/DELETE) accept an optional header:
```
Idempotency-Key: <uuid>
```
Replays of the same key within 24h return the original response without re-executing.

---

## 2. Auth

### POST `/auth/signup` **[public]**
Initiate signup. Sends OTP to mobile.

**Request**
```json
{
  "name": "Suraj K",
  "mobile_number": "+919876543210",
  "password": "min-8-chars",
  "username": "suraj_k"
}
```
- `username` is optional.

**Response 201**
```json
{
  "data": {
    "user_id": "uuid",
    "otp_sent": true,
    "otp_expires_at": "2026-04-23T14:35:00Z"
  }
}
```

**Errors:** `MOBILE_TAKEN`, `USERNAME_TAKEN`, `WEAK_PASSWORD`, `INVALID_MOBILE`.

---

### POST `/auth/verify-otp` **[public]**
Verify OTP for signup, login, password reset, or admin transfer.

**Request**
```json
{
  "mobile_number": "+919876543210",
  "otp": "482910",
  "purpose": "signup"
}
```
- `purpose`: `signup` | `login` | `password_reset` | `admin_transfer`.

**Response 200** (signup case)
```json
{
  "data": {
    "user_id": "uuid",
    "access_token": "jwt...",
    "refresh_token": "rt...",
    "expires_in": 900
  }
}
```

**Errors:** `OTP_INVALID`, `OTP_EXPIRED`, `OTP_MAX_ATTEMPTS`.

---

### POST `/auth/resend-otp` **[public]**
Resend OTP. Rate-limited to 1 per 30s, 5 per hour.

**Request**
```json
{
  "mobile_number": "+919876543210",
  "purpose": "signup"
}
```

**Response 200**
```json
{
  "data": {
    "otp_sent": true,
    "otp_expires_at": "2026-04-23T14:40:00Z",
    "next_resend_at": "2026-04-23T14:36:00Z"
  }
}
```

**Errors:** `OTP_RATE_LIMITED`.

---

### POST `/auth/login` **[public]**
Login with mobile/username + password.

**Request**
```json
{
  "identifier": "+919876543210",
  "password": "..."
}
```
- `identifier` accepts mobile or username.

**Response 200**
```json
{
  "data": {
    "user_id": "uuid",
    "access_token": "jwt...",
    "refresh_token": "rt...",
    "expires_in": 900
  }
}
```

**Errors:** `INVALID_CREDENTIALS`, `MOBILE_NOT_VERIFIED`, `ACCOUNT_LOCKED`.

---

### POST `/auth/refresh` **[public]**
Exchange refresh token for new access token.

**Request**
```json
{ "refresh_token": "rt..." }
```

**Response 200**
```json
{
  "data": {
    "access_token": "jwt...",
    "expires_in": 900
  }
}
```

**Errors:** `REFRESH_TOKEN_INVALID`, `REFRESH_TOKEN_REVOKED`.

---

### POST `/auth/logout`
Revoke the current refresh token.

**Request**
```json
{ "refresh_token": "rt..." }
```

**Response 204** (no body)

---

### POST `/auth/forgot-password` **[public]**
Initiate password reset. Sends OTP.

**Request**
```json
{ "mobile_number": "+919876543210" }
```

**Response 200**
```json
{ "data": { "otp_sent": true, "otp_expires_at": "..." } }
```

---

### POST `/auth/reset-password` **[public]**
Complete password reset. Requires OTP verified via `/auth/verify-otp` with `purpose=password_reset` first.

**Request**
```json
{
  "mobile_number": "+919876543210",
  "otp": "482910",
  "new_password": "min-8-chars"
}
```

**Response 200**
```json
{ "data": { "success": true } }
```

---

## 3. Users & profile

### GET `/me`
Get current user's profile.

**Response 200**
```json
{
  "data": {
    "user_id": "uuid",
    "name": "Suraj K",
    "mobile_number": "+919876543210",
    "username": "suraj_k",
    "mobile_verified": true,
    "created_at": "2026-04-01T08:00:00Z"
  }
}
```

---

### PATCH `/me`
Update profile.

**Request**
```json
{ "name": "Suraj Kumar", "username": "suraj_kumar" }
```
- All fields optional. Mobile cannot be changed without re-verification (separate flow, deferred).

**Response 200** — same shape as GET `/me`.

**Errors:** `USERNAME_TAKEN`.

---

### POST `/me/change-password`
Change password (authenticated).

**Request**
```json
{ "current_password": "...", "new_password": "..." }
```

**Response 204**

**Errors:** `INVALID_CREDENTIALS`, `WEAK_PASSWORD`.

---

### GET `/me/sessions`
List active refresh tokens (devices).

**Response 200**
```json
{
  "data": [
    {
      "id": "uuid",
      "device_info": "Chrome on Pixel 7",
      "created_at": "...",
      "last_used_at": "...",
      "current": true
    }
  ]
}
```

---

### DELETE `/me/sessions/:id`
Revoke a specific session.

**Response 204**

---

## 4. Groups

### POST `/groups`
Create a new group. The caller becomes admin and gets a membership with `share_count = 1` (adjustable later).

**Request**
```json
{
  "name": "Sunrise Chits 2026",
  "monthly_contribution": 1000000,
  "total_shares": 10,
  "start_month": "2026-05-01",
  "payment_due_day": 10,
  "admin_commission_rate": 5.00,
  "interest_rate_min": 2.00,
  "interest_rate_max": 5.00
}
```
- `monthly_contribution` and amounts are in paise.
- `total_shares` = `total_months`.
- `payment_due_day` must be between 1 and 28 (inclusive). Days 29–31 are rejected. This day is used to auto-compute `due_date` for every cycle in this group.
- `admin_commission_rate` — percentage of the full pool amount the admin retains in cash (e.g. `5.00` = 5%). Defaults to `0.00` if omitted. Locked once cycle 1 starts.

**Response 201**
```json
{
  "data": {
    "group_id": "uuid",
    "name": "Sunrise Chits 2026",
    "invitation_code": "CF7K2X9P",
    "pool_amount": 10000000,
    "monthly_contribution": 1000000,
    "total_shares": 10,
    "total_months": 10,
    "start_month": "2026-05-01",
    "payment_due_day": 10,
    "admin_commission_rate": 5.00,
    "status": "Active",
    "cycle_status": "PendingStart",
    "created_at": "..."
  }
}
```
- `cycle_status` is a virtual field: `PendingStart` until cycle 1 begins, then `InProgress`, then `Closed`.

**Errors:** `INVALID_AMOUNT`, `INVALID_SHARE_COUNT`, `INVALID_START_MONTH`, `INVALID_PAYMENT_DUE_DAY`, `INVALID_COMMISSION_RATE`.

---

### GET `/groups`
List groups the user belongs to.

**Query params:**
- `role`: `admin` | `member` | `all` (default `all`)
- `status`: `active` | `closed` | `all` (default `active`)
- `q`: search by name (case-insensitive substring)
- `limit`, `cursor` (pagination)

**Response 200**
```json
{
  "data": [
    {
      "group_id": "uuid",
      "name": "Sunrise Chits 2026",
      "role": "Admin",
      "share_count": 2,
      "wins_count": 0,
      "monthly_contribution": 1000000,
      "total_shares": 10,
      "current_month_number": 4,
      "current_cycle_status": "Open",
      "user_payment_status_this_month": "Paid",
      "defaulters_count": 2,
      "status": "Active"
    }
  ],
  "next_cursor": null,
  "has_more": false
}
```
- Optimized for the home screen — has everything needed without follow-up calls.

---

### GET `/groups/:group_id`
Get full group detail.

**Response 200**
```json
{
  "data": {
    "group_id": "uuid",
    "name": "Sunrise Chits 2026",
    "invitation_code": "CF7K2X9P",
    "pool_amount": 10000000,
    "monthly_contribution": 1000000,
    "total_shares": 10,
    "total_months": 10,
    "shares_filled": 10,
    "people_count": 5,
    "start_month": "2026-05-01",
    "payment_due_day": 10,
    "admin_commission_rate": 5.00,
    "interest_rate_min": 2.00,
    "interest_rate_max": 5.00,
    "status": "Active",
    "current_cycle": {
      "cycle_id": "uuid",
      "month_number": 4,
      "month_label": "Apr 2026",
      "due_date": "2026-04-28",
      "status": "Open",
      "is_skip_month": false,
      "winner_user_id": null,
      "bid_amount": null,
      "admin_commission": null,
      "basket_credit": null,
      "winner_takeaway": null
    },
    "basket": {
      "current_balance": 3800000,
      "total_credited": 6800000,
      "total_debited": 3000000,
      "total_lent_out": 1500000
    },
    "my_membership": {
      "role": "Admin",
      "share_count": 2,
      "wins_count": 0
    },
    "created_at": "..."
  }
}
```

**Errors:** `GROUP_NOT_FOUND`, `NOT_A_MEMBER`.

---

### PATCH `/groups/:group_id` **[admin]**
Update mutable fields. Restrictions per locked decision: contribution and total_shares lock once cycle 1 starts.

**Request**
```json
{ "name": "Sunrise Savings 2026" }
```
- Allowed always: `name`, `interest_rate_min`, `interest_rate_max`.
- Allowed only before cycle 1 starts: `monthly_contribution`, `total_shares`, `start_month`, `admin_commission_rate`.

**Response 200** — same as GET `/groups/:group_id`.

**Errors:** `FIELD_LOCKED`, `INVALID_AMOUNT`.

---

### POST `/groups/:group_id/start` **[admin]**
Start cycle 1. Requires `shares_filled == total_shares`.

**Response 200**
```json
{
  "data": {
    "current_cycle": {
      "cycle_id": "uuid",
      "month_number": 1,
      "status": "Open",
      "due_date": "2026-05-28"
    }
  }
}
```

**Errors:** `SHARES_NOT_FILLED`, `ALREADY_STARTED`.

---

### POST `/groups/:group_id/close` **[admin]**
Close the group. Requires all cycles closed, all loans fully repaid (outstanding principal = 0 AND outstanding interest = 0 for every loan). Triggers closure split.

**Response 200**
```json
{
  "data": {
    "status": "Closed",
    "closed_at": "...",
    "closure_split": [
      { "user_id": "uuid", "name": "Suraj K", "share_count": 2, "amount": 300000 },
      { "user_id": "uuid", "name": "Priya S",  "share_count": 3, "amount": 450000 }
    ],
    "total_distributed": 1500000
  }
}
```

**Errors:** `LOANS_OUTSTANDING`, `CYCLES_PENDING`.

---

### POST `/groups/:group_id/rotate-invitation-code` **[admin]**
Generate a new invitation code; old one becomes invalid.

**Response 200**
```json
{ "data": { "invitation_code": "XW9P2K3M" } }
```

---

### POST `/groups/join` **[any logged-in user]**
Join a group via invitation code.

**Request**
```json
{ "invitation_code": "CF7K2X9P", "share_count": 1 }
```
- `share_count` is what the joiner is requesting; admin must approve in v2 if we add approval. **For v1, joining via code is direct — admin sets the share count themselves on the Add Member screen.** So `share_count` is ignored here and defaults to 1 — admin can adjust.

**Response 201**
```json
{
  "data": {
    "membership_id": "uuid",
    "group_id": "uuid",
    "role": "Member",
    "share_count": 1
  }
}
```

**Errors:** `INVITATION_INVALID`, `ALREADY_MEMBER`, `GROUP_FULL`, `GROUP_CLOSED`.

---

## 5. Memberships

### GET `/groups/:group_id/members`
List all members of a group.

**Query params:**
- `status`: `active` | `inactive` | `all` (default `active`)
- `q`: search by name

**Response 200**
```json
{
  "data": [
    {
      "membership_id": "uuid",
      "user_id": "uuid",
      "name": "Ramesh K",
      "mobile_number": "+919988776655",
      "role": "Member",
      "share_count": 2,
      "wins_count": 1,
      "is_eligible_to_win": true,
      "joined_at": "...",
      "status": "Active"
    }
  ]
}
```
- `is_eligible_to_win` = `wins_count < share_count && status == 'Active' && no active loan in this group`. Computed for convenience.

---

### POST `/groups/:group_id/members` **[admin]**
Add a member by mobile number. If the user exists, adds directly; if not, creates an "Invited" placeholder and sends SMS invite.

**Request**
```json
{
  "name": "Anand M",
  "mobile_number": "+919812345678",
  "share_count": 1
}
```

**Response 201**
```json
{
  "data": {
    "membership_id": "uuid",
    "user_id": "uuid-or-placeholder",
    "status": "Active",
    "invitation_sent": false
  }
}
```
- If `invitation_sent: true`, the user doesn't have an account yet — an SMS was sent with a deep link.

**Errors:** `INVALID_MOBILE`, `SHARES_EXCEEDED` (would push total over `total_shares`), `ALREADY_MEMBER`, `GROUP_LOCKED`.

---

### PATCH `/groups/:group_id/members/:membership_id` **[admin]**
Update a member's share count. Locked after cycle 1 starts.

**Request**
```json
{ "share_count": 3 }
```

**Response 200** — same as GET membership.

**Errors:** `FIELD_LOCKED`, `SHARES_EXCEEDED`, `WINS_EXCEED_SHARES` (can't reduce below `wins_count`).

---

### DELETE `/groups/:group_id/members/:membership_id` **[admin]**
Soft-delete (mark as Inactive). Allowed any time; if the cycle has started, requires confirmation flag.

**Request**
```json
{ "reason": "Member moved cities", "confirm_active_cycle": true }
```

**Response 200**
```json
{
  "data": {
    "membership_id": "uuid",
    "status": "Inactive",
    "deactivated_at": "..."
  }
}
```

**Errors:** `CONFIRMATION_REQUIRED`, `LAST_ADMIN`.

---

### POST `/groups/:group_id/members/:membership_id/transfer-admin` **[admin]**
Initiate admin transfer to this member. Both old and new admin must confirm via OTP.

**Request**
```json
{}
```

**Response 200**
```json
{
  "data": {
    "transfer_id": "uuid",
    "expires_at": "..."
  }
}
```
Triggers OTP to both parties; completion via:

### POST `/groups/:group_id/transfer-admin/:transfer_id/confirm`
**Request**
```json
{ "otp": "482910" }
```

When both have confirmed, the role swap completes atomically.

**Response 200** — group detail with updated admin.

---

### POST `/groups/:group_id/members/:membership_id/remind` **[admin]**
Send a custom payment reminder to a single member.

**Request**
```json
{ "channels": ["push", "sms"], "message": "optional custom message" }
```

**Response 200**
```json
{ "data": { "reminder_sent": true } }
```

---

## 6. Cycles & winners

### GET `/groups/:group_id/cycles`
List all cycles in the group.

**Query params:**
- `status`: `open` | `closed` | `all`

**Response 200**
```json
{
  "data": [
    {
      "cycle_id": "uuid",
      "month_number": 1,
      "month_label": "May 2026",
      "due_date": "2026-05-28",
      "status": "Closed",
      "is_skip_month": false,
      "winner": {
        "user_id": "uuid",
        "name": "Ramesh K"
      },
      "bid_amount": 1000000,
      "admin_commission": 500000,
      "basket_credit": 1000000,
      "winner_takeaway": 8500000,
      "collected_amount": 10000000,
      "paid_count": 5,
      "total_count": 5
    }
  ]
}
```

---

### GET `/groups/:group_id/cycles/:cycle_id`
Get full cycle detail.

**Response 200** — extends list shape with full payment breakdown, plus:

```json
{
  "data": {
    "...all list-shape fields...": "...",
    "is_editable": true,
    "payments": [
      { "payment_id": "uuid", "member_user_id": "uuid", "member_name": "...",
        "share_count": 1, "expected_amount": 1000000, "paid_amount": 1000000,
        "status": "Paid", "paid_at": "...", "marked_by_name": "..." }
    ]
  }
}
```

- `is_editable` — server-computed. `true` when `cycle.status='Open'` OR (`cycle.status='Closed'` AND now() < `closed_at` + 24h). Authoritative — clients must not derive locally (clock drift). Determines whether the admin UI shows edit affordances on Screen 11.

---

### POST `/groups/:group_id/cycles/:cycle_id/record-winner` **[admin]**
Record the winning bid for a regular cycle.

**Request**
```json
{
  "winner_user_id": "uuid",
  "bid_amount": 1600000,
  "notes": "Bid happened Apr 26 7 PM. Runner-up Ramesh at 14000."
}
```

**Response 200**
```json
{
  "data": {
    "cycle_id": "uuid",
    "winner_user_id": "uuid",
    "bid_amount": 1600000,
    "admin_commission": 500000,
    "basket_credit": 1600000,
    "winner_takeaway": 7900000,
    "basket_balance_after": 5420000
  }
}
```
- `admin_commission` = `pool_amount × group.admin_commission_rate / 100` (offline cash, not added to basket; based on full pool, not the bid).
- `basket_credit` = `bid_amount` (the full sacrifice is credited to the basket; commission does not reduce this).

**Errors:**
- `WINNER_INELIGIBLE` — member has exhausted their share allocation (`wins_count >= share_count`) OR has an active loan in this group
- `BID_EXCEEDS_POOL`
- `BID_NEGATIVE_OR_ZERO`
- `CYCLE_ALREADY_RECORDED` (use PATCH to edit)
- `CYCLE_CLOSED`

---

### POST `/groups/:group_id/cycles/:cycle_id/declare-skip-month` **[admin]**
Mark a cycle as skip-month. Basket pays the pool to the winner; members owe nothing.

**Request**
```json
{
  "winner_user_id": "uuid",
  "notes": "Basket large enough this month"
}
```

**Response 200**
```json
{
  "data": {
    "cycle_id": "uuid",
    "is_skip_month": true,
    "winner_user_id": "uuid",
    "winner_takeaway": 10000000,
    "basket_debit": 10000000,
    "basket_balance_after": 1000000
  }
}
```

**Errors:**
- `BASKET_INSUFFICIENT` (basket balance < pool)
- `PAYMENTS_ALREADY_COLLECTED` (some member already marked Paid)
- `WINNER_INELIGIBLE` — member has exhausted their share allocation OR has an active loan in this group
- `CYCLE_CLOSED`

---

### PATCH `/groups/:group_id/cycles/:cycle_id` **[admin]**
Edit a previously-recorded winner. Allowed within 24h of recording.

**Request**
```json
{ "bid_amount": 1700000, "notes": "Corrected bid amount" }
```

**Response 200** — updated cycle.

**Errors:** `EDIT_WINDOW_EXPIRED`.

---

### POST `/groups/:group_id/cycles/:cycle_id/close` **[admin]**
Manually close a cycle (auto-closes when all payments settled, but admin can force-close).

**Response 200** — cycle with status `Closed`.

**Errors:** `PAYMENTS_OUTSTANDING`.

---

## 7. Payments

### GET `/groups/:group_id/cycles/:cycle_id/payments`
List all payments for a cycle.

**Query params:**
- `status`: `paid` | `unpaid` | `waived` | `all`

**Response 200**
```json
{
  "data": [
    {
      "payment_id": "uuid",
      "member_user_id": "uuid",
      "member_name": "Ramesh K",
      "share_count": 2,
      "expected_amount": 2000000,
      "paid_amount": 2000000,
      "status": "Paid",
      "paid_at": "2026-04-23T14:14:00Z",
      "marked_by": "uuid",
      "notes": null
    }
  ],
  "summary": {
    "total_expected": 10000000,
    "total_paid": 8000000,
    "paid_count": 8,
    "unpaid_count": 2,
    "waived_count": 0
  }
}
```

---

### PATCH `/groups/:group_id/payments/:payment_id` **[admin]**
Mark a payment as paid/unpaid, or edit details.

**Request**
```json
{
  "status": "Paid",
  "paid_amount": 2000000,
  "paid_at": "2026-04-23T10:00:00Z",
  "notes": "Paid in cash"
}
```
- All fields optional. Sending `status: "Unpaid"` clears `paid_at` and `marked_by`.

**Response 200**
```json
{
  "data": {
    "payment_id": "uuid",
    "status": "Paid",
    "paid_amount": 2000000,
    "paid_at": "2026-04-23T10:00:00Z"
  }
}
```

**Errors:** `INVALID_STATUS`, `AMOUNT_EXCEEDS_EXPECTED`, `CYCLE_CLOSED`.

---

### POST `/groups/:group_id/cycles/:cycle_id/payments/bulk` **[admin]**
Bulk-update payments. Useful for "Mark all paid" or marking multiple as paid on a specific date.

**Request**
```json
{
  "payment_ids": ["uuid1", "uuid2", "uuid3"],
  "status": "Paid",
  "paid_at": "2026-04-21T18:00:00Z"
}
```
- Pass `payment_ids: "all_unpaid"` to apply to all unpaid in this cycle.

**Response 200**
```json
{
  "data": {
    "updated_count": 3,
    "skipped": []
  }
}
```

---

### POST `/groups/:group_id/cycles/:cycle_id/remind-defaulters` **[admin]**
Send reminders to all members with `Unpaid` status this cycle.

**Request**
```json
{ "channels": ["push", "sms"] }
```

**Response 200**
```json
{
  "data": {
    "reminders_sent": 2,
    "failed": []
  }
}
```

---

### GET `/groups/:group_id/members/:user_id/payments`
Get a member's full payment history within this group. Member can read own; admin can read anyone's.

**Response 200**
```json
{
  "data": [
    {
      "payment_id": "uuid",
      "cycle_month_label": "Mar 2026",
      "expected_amount": 2000000,
      "paid_amount": 2000000,
      "status": "Paid",
      "paid_at": "...",
      "is_skip_month": false
    }
  ]
}
```

**Errors:** `FORBIDDEN` (member trying to read someone else's history).

---

## 8. Basket & loans

### GET `/groups/:group_id/basket`
Get basket overview. Members see a subset of the admin response. Both shapes are derived from the same underlying data.

**Response 200 (admin)**
```json
{
  "data": {
    "basket_id": "uuid",
    "current_balance": 3800000,
    "total_credited": 6800000,
    "total_debited": 3000000,
    "total_lent_out": 1500000,
    "total_interest_earned": 18200,
    "active_loans_count": 2,
    "skip_months_used": 1,
    "last_recomputed_at": "..."
  }
}
```

**Response 200 (member)** — same shape, but with operational fields hidden and a personal projected share added:
```json
{
  "data": {
    "basket_id": "uuid",
    "current_balance": 3800000,
    "total_interest_earned": 18200,
    "skip_months_used": 1,
    "my_share_if_closed_today": 760000,
    "last_recomputed_at": "..."
  }
}
```

- `total_credited` / `total_debited` / `total_lent_out` / `active_loans_count` — admin-only operational metrics. Hidden from members.
- `total_interest_earned` — group-level lifetime interest from all basket loans. Same value for admin and member views (it's a group-level number, not per-person).
- `skip_months_used` — count of cycles where `is_skip_month=true`. Useful trust signal: "the basket has covered N months for the group."
- `my_share_if_closed_today` — member-only. Computed as `current_balance × member.share_count / total_shares`. Updates whenever basket changes; not stored.

---

### GET `/groups/:group_id/basket/transactions`
List ledger entries.

**Query params:**
- `type`: filter by `txn_type`
- `cycle_id`: filter to entries tied to a specific cycle (used by the deep-link from Screen 11's "View ledger entry")
- `from`, `to`: ISO date range
- `cursor`, `limit`

**Response 200**
```json
{
  "data": [
    {
      "txn_id": "uuid",
      "txn_type": "CREDIT_DISCOUNT",
      "direction": "C",
      "amount": 1500000,
      "cycle_month_label": "Mar 2026",
      "counterparty_name": null,
      "notes": "Mar bid → basket",
      "created_at": "2026-03-30T18:00:00Z"
    }
  ]
}
```

**Authorization:** members get only entries that involve them (their loans, their closure split). Admins see all.

---

### POST `/groups/:group_id/basket/adjustments` **[admin]**
Record a manual basket adjustment (per requirements F-18a). Direction is set explicitly. Notes are mandatory.

**Request**
```json
{
  "direction": "D",
  "amount": 500000,
  "notes": "Cash discrepancy found during May audit; reduced balance to match physical cash."
}
```
- `direction`: `"C"` (credit, balance up) or `"D"` (debit, balance down).
- `amount`: positive integer in paise.
- `notes`: required, non-empty.

**Response 201**
```json
{
  "data": {
    "txn_id": "uuid",
    "txn_type": "ADJUSTMENT",
    "direction": "D",
    "amount": 500000,
    "notes": "Cash discrepancy found during May audit; reduced balance to match physical cash.",
    "basket_balance_after": 3300000,
    "created_at": "..."
  }
}
```
- Notification of type `BASKET_ADJUSTED` is sent to all group members.

**Errors:**
- `INVALID_REQUEST` — direction not `'C'` or `'D'`, amount ≤ 0, missing notes
- `BASKET_INSUFFICIENT` — debit `amount > current_balance`
- `ADMIN_ONLY` — caller is not the admin

---

### POST `/groups/:group_id/loans` **[admin]**
Disburse a new loan.

**Request**
```json
{
  "borrower_user_id": "uuid",
  "principal": 1500000,
  "interest_rate": 3.00,
  "expected_close_date": "2026-09-18",
  "notes": "Family medical emergency"
}
```

**Response 201**
```json
{
  "data": {
    "loan_id": "uuid",
    "borrower_user_id": "uuid",
    "principal": 1500000,
    "monthly_interest_rate": 3.00,
    "first_month_interest": 45000,
    "amount_disbursed_to_borrower": 1455000,
    "disbursed_at": "...",
    "status": "Active",
    "basket_balance_after": 2300000,
    "warnings": []
  }
}
```

`warnings` is an empty array when everything is clean. If the borrower already has an active loan, disbursement still proceeds but `warnings` contains an explanatory message.

**Errors:**
- `BORROWER_NOT_MEMBER` — borrower is not an active member of this group
- `BORROWER_INELIGIBLE` — member has no remaining un-won shares (wins_count >= share_count); hard block
- `LOAN_EXCEEDS_CAP` — principal exceeds `min(basket_balance, remaining_shares × per_share_value)`

---

### GET `/groups/:group_id/loans`
List loans.

**Query params:**
- `status`: `active` | `repaid` | `written_off` | `all`
- `borrower_user_id`: filter to specific person

**Response 200**
```json
{
  "data": [
    {
      "loan_id": "uuid",
      "borrower_user_id": "uuid",
      "borrower_name": "Priya S",
      "principal": 1500000,
      "outstanding_principal": 1500000,
      "interest_rate": 3.00,
      "total_interest_accrued": 45000,
      "total_interest_paid": 7500,
      "outstanding_interest": 37500,
      "disbursed_at": "...",
      "expected_close_date": "2026-09-18",
      "status": "Active",
      "next_cycle_due_date": "2026-05-10"
    }
  ]
}
```

- `outstanding_interest` = `total_interest_accrued − total_interest_paid`. This is the cumulative amount the borrower can pay at any time — there is no per-cycle hard deadline.
- `next_cycle_due_date` is the `due_date` of the next open cycle — the date the next monthly accrual will run and add another `principal × interest_rate` to `total_interest_accrued`. Also when the contribution is due.

**Authorization:** members only see their own loans.

---

### GET `/groups/:group_id/loans/:loan_id`
Loan detail with full repayment history.

**Response 200**
```json
{
  "data": {
    "loan_id": "uuid",
    "borrower": { "user_id": "uuid", "name": "Priya S" },
    "principal": 1500000,
    "outstanding_principal": 1500000,
    "interest_rate": 3.00,
    "total_interest_accrued": 45000,
    "total_interest_paid": 7500,
    "outstanding_interest": 37500,
    "status": "Active",
    "transactions": [
      {
        "id": "uuid",
        "type": "INTEREST_PAID",
        "amount": 3750,
        "txn_date": "2026-04-18",
        "notes": null,
        "created_at": "..."
      }
    ]
  }
}
```

---

### POST `/groups/:group_id/loans/:loan_id/repay` **[admin]**
Record a principal repayment, interest payment, or both. Both fields are optional — at least one must be present.

**Request**
```json
{
  "principal_repaid": 500000,
  "interest_paid": 37500,
  "txn_date": "2026-04-18",
  "notes": null
}
```
- `interest_paid` — any positive amount up to the current `outstanding_interest` (`total_interest_accrued − total_interest_paid`). There is no constraint that it equals exactly one month's interest — borrowers can pay any cumulative amount. Example: if 3 months have accrued (₹6,000 total) and nothing has been paid yet, the admin can record `interest_paid: 6000` (full) or `interest_paid: 2000` (partial).
- `principal_repaid` — must equal the full outstanding principal (full-close only; no partial principal repayments). Set to 0 or omit if not closing.

**Response 200**
```json
{
  "data": {
    "loan_id": "uuid",
    "outstanding_principal": 1000000,
    "total_interest_accrued": 45000,
    "total_interest_paid": 45000,
    "outstanding_interest": 0,
    "status": "Active",
    "basket_balance_after": 4300000
  }
}
```

**Errors:**
- `INTEREST_EXCEEDS_OUTSTANDING` — `interest_paid` > `outstanding_interest`
- `PARTIAL_PRINCIPAL_NOT_ALLOWED` — `principal_repaid` > 0 but < `outstanding_principal`
- `PRINCIPAL_EXCEEDS_OUTSTANDING` — `principal_repaid` > `outstanding_principal`
- `LOAN_CLOSED` — loan already Repaid or WrittenOff

---

### PATCH `/groups/:group_id/loans/:loan_id` **[admin]**
Update loan status (write off, extend due date, etc.).

**Request**
```json
{ "status": "WrittenOff", "notes": "Borrower defaulted, written off after 6 months" }
```
- Or: `{ "expected_close_date": "2027-03-18" }` to extend.

**Response 200** — updated loan.

**Errors:** `INVALID_TRANSITION`.

---

## 9. Notifications

### GET `/me/notifications`
List the user's notifications inbox.

**Query params:**
- `unread`: `true` | `false`
- `group_id`: filter to one group
- `cursor`, `limit`

**Response 200**
```json
{
  "data": [
    {
      "id": "uuid",
      "type": "WINNER_ANNOUNCED",
      "title": "Sandeep took the chit",
      "body": "Won bid ₹52,000 in Apr 2026",
      "group_id": "uuid",
      "group_name": "Sunrise Chits 2026",
      "data": { "cycle_id": "uuid", "bid_amount": 5200000 },
      "read_at": null,
      "created_at": "2026-04-30T18:00:00Z"
    }
  ],
  "unread_count": 4
}
```
- `group_id` and `group_name` are top-level on every notification that belongs to a group (null for platform-level notifications, not used in v1).
- `data` carries type-specific payload (see notification types table below).
- `read_at` is null for unread notifications.

---

### POST `/me/notifications/mark-read`
Mark notifications as read.

**Request**
```json
{ "notification_ids": ["uuid1", "uuid2"] }
```
Or `{ "all": true }`.

**Response 200**
```json
{ "data": { "marked_count": 2 } }
```

---

### GET `/me/notification-preferences`
**Response 200**
```json
{
  "data": [
    { "group_id": null, "muted": false },
    { "group_id": "uuid", "muted": true }
  ]
}
```
- `group_id: null` is the global preference.

---

### PUT `/me/notification-preferences`
**Request**
```json
{ "group_id": "uuid", "muted": true }
```

**Response 200** — same as GET.

---

### POST `/me/push-subscriptions`
Register a Web Push endpoint for the current device.

**Request**
```json
{
  "endpoint": "https://fcm.googleapis.com/...",
  "p256dh_key": "...",
  "auth_key": "...",
  "device_info": "Chrome on Pixel 7"
}
```

**Response 201**
```json
{ "data": { "id": "uuid" } }
```

---

### DELETE `/me/push-subscriptions/:id`
**Response 204**

---

### Notification types reference

| `type` | Trigger | Who receives | Standard `data` payload |
|---|---|---|---|
| `PAYMENT_DUE` | Daily cron — fires when `due_date = today + 3 days` for an open cycle that has unpaid payments | Members with `Unpaid` payment in that cycle | `{ cycle_id, month_number, due_date }` |
| `PAYMENT_RECEIVED` | Admin marks a payment as `Paid` via PATCH `/payments/:id` | The member whose payment was marked | `{ cycle_id, month_number, paid_amount }` |
| `WINNER_ANNOUNCED` | Admin records a winner via POST `…/record-winner` | All active members of the group | `{ cycle_id, month_number, winner_user_id, winner_name, bid_amount, basket_credit }` |
| `LOAN_DISBURSED` | Admin disburses a loan via POST `…/loans` | The borrower (member receiving the loan) | `{ loan_id, principal, amount_disbursed_to_borrower }` |
| `SKIP_MONTH_DECLARED` | Admin declares a skip month via POST `…/declare-skip-month` | All active members of the group | `{ cycle_id, month_number }` |
| `DEFAULTER_REMINDER` | Admin triggers via POST `…/remind-defaulters` (manual) | Members with `Unpaid` status this cycle | `{ cycle_id, month_number, due_date }` |
| `BASKET_ADJUSTED` | Admin records a basket adjustment via POST `…/basket/adjustments` | All active members of the group | `{ txn_id, direction, amount, notes }` |

**Notes:**
- `PAYMENT_DUE` is sent by a **scheduled daily cron job** (runs at 09:00 IST). It is not triggered at cycle creation or cycle close. Skip-month cycles are excluded.
- `LOAN_DISBURSED` is a new type added in v8 (not in the original schema enum comment — the schema varchar(40) field accepts any string; add `LOAN_DISBURSED` alongside existing values).
- Mute preferences (`notification_preferences` table) are checked before each delivery — a muted user receives no notification regardless of type.

---

## 10. Reports

All report endpoints stream the file directly. Pass `Accept: application/pdf` or `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` header.

### GET `/groups/:group_id/reports/ledger.pdf` **[admin]**
Full payment + basket ledger.

### GET `/groups/:group_id/reports/ledger.xlsx` **[admin]**
Same data as Excel.

### GET `/groups/:group_id/cycles/:cycle_id/reports/summary.pdf` **[admin]**
Per-month summary.

### GET `/groups/:group_id/members/:user_id/reports/history.pdf`
Per-member history. Member can pull own; admin can pull anyone's.

### GET `/groups/:group_id/reports/closure.pdf` **[admin]**
Closure report (only available after group is Closed).

### GET `/groups/:group_id/reports/loans.xlsx` **[admin]**
Full loan register.

**Errors (all):** `REPORT_NOT_AVAILABLE`, `FORBIDDEN`.

---

## 11. Analytics

### GET `/groups/:group_id/analytics/overview` **[admin]**
Top-level metrics for the dashboard.

**Response 200**
```json
{
  "data": {
    "total_collected": 32000000,
    "total_disbursed_to_winners": 28400000,
    "current_basket_balance": 3800000,
    "total_lent_out": 1500000,
    "total_interest_earned": 18200,
    "active_loans_count": 2,
    "skip_months_used": 1,
    "defaulters_this_month": 2
  }
}
```

---

### GET `/groups/:group_id/analytics/winners-ledger`
Winners ledger across all cycles.

**Response 200**
```json
{
  "data": [
    {
      "month_number": 1,
      "month_label": "May 2026",
      "winner_name": "Ramesh K",
      "bid_amount": 1000000,
      "admin_commission": 500000,
      "basket_credit": 1000000,
      "winner_takeaway": 8500000,
      "is_skip_month": false
    }
  ]
}
```

---

### GET `/groups/:group_id/analytics/member-balance-sheet/:user_id`
Per-member position. Member can read own; admin can read anyone's.

**Response 200**
```json
{
  "data": {
    "user_id": "uuid",
    "name": "Priya S",
    "share_count": 3,
    "wins_count": 1,
    "total_contributed": 18000000,
    "total_received_as_winner": 8800000,
    "active_loans_outstanding": 0,
    "projected_closure_split": 1140000,
    "net_position": -8060000
  }
}
```
- `net_position` = received + projected closure split − contributed − loan outstanding. Negative means they've contributed more than they've received so far (normal mid-cycle).

---

### GET `/groups/:group_id/analytics/bid-trend`
Bid amount per cycle (for charting).

**Response 200**
```json
{
  "data": [
    { "month_number": 1, "bid_amount": 1000000 },
    { "month_number": 2, "bid_amount": 1200000 },
    { "month_number": 3, "is_skip_month": true, "bid_amount": null }
  ]
}
```

---

### GET `/groups/:group_id/analytics/basket-growth`
Basket balance month by month (for charting).

**Response 200**
```json
{
  "data": [
    { "month_number": 1, "balance_at_close": 1000000 },
    { "month_number": 2, "balance_at_close": 2200000 }
  ]
}
```

---

## 12. Errors

### Standard error response

**Status codes:** 400 / 401 / 403 / 404 / 409 / 422 / 429 / 500.

```json
{
  "error": {
    "code": "BID_EXCEEDS_POOL",
    "message": "Bid amount must be less than the pool amount.",
    "details": {
      "pool_amount": 10000000,
      "bid_amount_received": 12000000
    },
    "request_id": "req_abc123"
  }
}
```

### Error codes (consolidated)

| Code | HTTP | Meaning |
|---|---|---|
| `INVALID_REQUEST` | 400 | Generic validation failure |
| `MISSING_FIELD` | 400 | Required field absent |
| `INVALID_MOBILE` | 400 | Mobile number not in E.164 format |
| `INVALID_AMOUNT` | 400 | Amount negative, zero, or non-integer paise |
| `INVALID_SHARE_COUNT` | 400 | share_count < 1 or sum exceeds total |
| `INVALID_START_MONTH` | 400 | Start month in the past |
| `INVALID_PAYMENT_DUE_DAY` | 400 | payment_due_day not between 1 and 28 |
| `INVALID_COMMISSION_RATE` | 400 | admin_commission_rate not between 0 and 100 |
| `BID_EXCEEDS_POOL` | 400 | Bid > pool |
| `BID_NEGATIVE_OR_ZERO` | 400 | Bid ≤ 0 |
| `WEAK_PASSWORD` | 400 | Password fails strength rules |
| `INTEREST_RATE_OUT_OF_RANGE` | 400 | Outside group's [min, max] |
| `UNAUTHENTICATED` | 401 | No/invalid access token |
| `MOBILE_NOT_VERIFIED` | 401 | OTP not yet verified |
| `INVALID_CREDENTIALS` | 401 | Wrong password |
| `REFRESH_TOKEN_INVALID` | 401 | Refresh token bad |
| `REFRESH_TOKEN_REVOKED` | 401 | Was revoked |
| `OTP_INVALID` | 401 | Wrong OTP |
| `OTP_EXPIRED` | 401 | OTP timed out |
| `OTP_MAX_ATTEMPTS` | 429 | Too many wrong tries |
| `OTP_RATE_LIMITED` | 429 | Too many resends |
| `FORBIDDEN` | 403 | Insufficient permission |
| `ADMIN_ONLY` | 403 | Endpoint requires admin role |
| `NOT_A_MEMBER` | 403 | User not a member of this group |
| `GROUP_NOT_FOUND` | 404 | Group doesn't exist or soft-deleted |
| `MEMBER_NOT_FOUND` | 404 | Membership doesn't exist |
| `CYCLE_NOT_FOUND` | 404 | Cycle doesn't exist |
| `LOAN_NOT_FOUND` | 404 | Loan doesn't exist |
| `MOBILE_TAKEN` | 409 | Mobile already registered |
| `USERNAME_TAKEN` | 409 | Username already taken |
| `ALREADY_MEMBER` | 409 | Already in this group |
| `INVITATION_INVALID` | 409 | Code wrong or expired |
| `GROUP_FULL` | 409 | All shares filled |
| `GROUP_CLOSED` | 409 | Group is closed |
| `SHARES_EXCEEDED` | 409 | Would push total over total_shares |
| `WINS_EXCEED_SHARES` | 409 | Reducing share_count below wins_count |
| `WINNER_INELIGIBLE` | 409 | wins_count >= share_count |
| `CYCLE_ALREADY_RECORDED` | 409 | Use PATCH instead |
| `CYCLE_CLOSED` | 409 | Cycle is closed; no edits |
| `EDIT_WINDOW_EXPIRED` | 409 | Past 24h edit window |
| `BASKET_INSUFFICIENT` | 409 | Basket balance < required |
| `PAYMENTS_ALREADY_COLLECTED` | 409 | Can't skip-month after collections |
| `PAYMENTS_OUTSTANDING` | 409 | Cycle has unpaid; can't close |
| `LOANS_OUTSTANDING` | 409 | Group has active loans; can't close |
| `CYCLES_PENDING` | 409 | Not all cycles closed; can't close group |
| `LOAN_CLOSED` | 409 | Loan already repaid/written off |
| `AMOUNT_EXCEEDS_EXPECTED` | 409 | paid_amount > expected_amount |
| `INTEREST_EXCEEDS_OUTSTANDING` | 409 | interest_paid > outstanding_interest (accrued − already paid) |
| `PARTIAL_PRINCIPAL_NOT_ALLOWED` | 409 | principal_repaid > 0 but < outstanding_principal |
| `PRINCIPAL_EXCEEDS_OUTSTANDING` | 409 | principal_repaid > outstanding_principal |
| `INVALID_TRANSITION` | 409 | Bad status transition |
| `FIELD_LOCKED` | 409 | Field cannot be edited at this stage |
| `LAST_ADMIN` | 409 | Removing last admin |
| `CONFIRMATION_REQUIRED` | 422 | Sensitive op needs confirm flag |
| `RATE_LIMITED` | 429 | Generic rate limit |
| `INTERNAL_ERROR` | 500 | Server error; report `request_id` |

### Generic guidelines

- All errors return a `request_id` for support purposes.
- Validation errors use 400; business-rule violations use 409.
- The client should never parse the human-readable `message` — match on `code`.

---

## Open API design questions

1. **Approval flow on join via code?** Right now anyone with the code can directly join (status Active, share_count=1). Should there be an admin-approval step? My recommendation: not in v1 — admin can adjust share_count or remove the joiner immediately.
2. **WebSocket / real-time updates?** Not in v1. Clients poll on focus + use push notifications.
3. **API versioning strategy after v1?** URI-based (`/v2/...`) when breaking changes happen. Non-breaking additions stay on `/v1`.
4. **Should `/me` expose a "primary group" or "default group"?** Useful for deep links like home → straight into the active group. Recommendation: defer to client-side preference (localStorage).

---

*Next step after API sign-off: code structure plan, then start coding (Phase 3).*
