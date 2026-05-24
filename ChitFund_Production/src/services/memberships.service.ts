// Business logic for group membership management.
// Responsibilities: add member (look up by mobile or create placeholder + SMS invite),
// enforce total_shares cap, update share_count (prevent reducing below wins_count),
// soft-deactivate with audit log, two-step OTP admin transfer flow.

import { randomBytes } from 'crypto';
import { eq, and, ilike, sum, gt, isNull, asc } from 'drizzle-orm';
import { db } from '../config/db';
import { chit_groups, memberships, payments, monthly_cycles, cycle_winners, users, notifications, pending_admin_transfers } from '../db/schema';
import { AppError } from '../utils/AppError';
import * as otpService from './otp.service';
import { insertActivity } from './activity.service';

// ─── Shared guard (imported by all other services) ───────────────────────────
// Returns { id, role, share_count } for the caller's Active membership.
// Throws GROUP_NOT_FOUND if the group doesn't exist, NOT_A_MEMBER otherwise.
export async function assertActiveMember(group_id: string, userId: string) {
  const [m] = await db
    .select({ id: memberships.id, role: memberships.role, share_count: memberships.share_count })
    .from(memberships)
    .where(and(
      eq(memberships.group_id, group_id),
      eq(memberships.user_id,  userId),
      eq(memberships.status,   'Active'),
    ))
    .limit(1);

  if (!m) {
    const [g] = await db
      .select({ id: chit_groups.id })
      .from(chit_groups)
      .where(eq(chit_groups.id, group_id))
      .limit(1);
    if (!g) throw new AppError(404, 'GROUP_NOT_FOUND', 'Group not found.');
    throw new AppError(403, 'NOT_A_MEMBER', 'You are not a member of this group.');
  }
  return m;
}

// ─── listMembers ─────────────────────────────────────────────────────────────
export async function listMembers(
  userId:   string,
  group_id: string,
  filters:  { status?: string; q?: string },
) {
  await assertActiveMember(group_id, userId);

  const { status = 'active', q } = filters;
  const conditions: ReturnType<typeof eq>[] = [eq(memberships.group_id, group_id)];
  if (status === 'active')   conditions.push(eq(memberships.status, 'Active'));
  if (status === 'inactive') conditions.push(eq(memberships.status, 'Inactive'));
  if (q)                     conditions.push(ilike(users.name, `%${q}%`));

  const rows = await db
    .select({
      membership_id:          memberships.id,
      user_id:                memberships.user_id,
      name:                   users.name,
      mobile_number:          users.mobile_number,
      role:                   memberships.role,
      share_count:            memberships.share_count,
      wins_count:             memberships.wins_count,
      admin_withdrawal_used:  memberships.admin_withdrawal_used,
      status:                 memberships.status,
      joined_at:              memberships.joined_at,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.user_id))
    .where(and(...conditions));

  return rows.map(m => ({
    ...m,
    is_eligible_to_win: Number(m.wins_count) < Number(m.share_count) && m.status === 'Active',
  }));
}

// ─── addMember ───────────────────────────────────────────────────────────────
export async function addMember(
  userId:   string,
  group_id: string,
  data:     { name: string; mobile_number: string; share_count?: number },
) {
  const { name, mobile_number, share_count = 1 } = data;

  if (!/^\+\d{10,15}$/.test(mobile_number)) {
    throw new AppError(400, 'INVALID_MOBILE', 'mobile_number must be in E.164 format (e.g. +919812345678).');
  }

  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin') throw new AppError(403, 'FORBIDDEN', 'Only the group admin can add members.');

  const [lockedProbe, groupRows, sharesRows, targetUserRows] = await Promise.all([
    db.select({ id: payments.id })
      .from(payments)
      .innerJoin(monthly_cycles, eq(monthly_cycles.id, payments.cycle_id))
      .where(eq(monthly_cycles.group_id, group_id))
      .limit(1),

    db.select({ total_shares: chit_groups.total_shares, status: chit_groups.status })
      .from(chit_groups)
      .where(eq(chit_groups.id, group_id))
      .limit(1),

    db.select({ shares_filled: sum(memberships.share_count) })
      .from(memberships)
      .where(and(eq(memberships.group_id, group_id), eq(memberships.status, 'Active'))),

    db.select({ id: users.id })
      .from(users)
      .where(eq(users.mobile_number, mobile_number))
      .limit(1),
  ]);

  if (lockedProbe[0] || groupRows[0].status === 'Closed') {
    throw new AppError(409, 'GROUP_LOCKED', 'Cannot add members after the group has started or been closed.');
  }

  const totalShares  = Number(groupRows[0].total_shares);
  const sharesFilled = Number(sharesRows[0].shares_filled ?? 0);
  if (sharesFilled + share_count > totalShares) {
    throw new AppError(409, 'SHARES_EXCEEDED',
      `Adding ${share_count} share(s) would exceed the group capacity of ${totalShares} (currently ${sharesFilled} filled).`);
  }

  const result = await db.transaction(async (tx) => {
    let targetUserId: string;
    let invitation_sent = false;

    if (targetUserRows[0]) {
      targetUserId = targetUserRows[0].id;
    } else {
      // Stub account: random non-bcrypt hash — can never satisfy bcrypt.compare().
      const [newUser] = await tx
        .insert(users)
        .values({ name, mobile_number, password_hash: randomBytes(32).toString('hex') })
        .returning({ id: users.id });
      targetUserId    = newUser.id;
      invitation_sent = true;
    }

    const [existing] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.group_id, group_id), eq(memberships.user_id, targetUserId)))
      .limit(1);

    if (existing) throw new AppError(409, 'ALREADY_MEMBER', 'This user is already a member of the group.');

    const [newMembership] = await tx
      .insert(memberships)
      .values({ group_id, user_id: targetUserId, role: 'Member', share_count })
      .returning({ id: memberships.id });

    return { membership_id: newMembership.id, user_id: targetUserId, invitation_sent };
  });

  await insertActivity({
    group_id,
    event_type: 'MEMBER_JOINED',
    actor_id:   result.user_id,
    data:       { share_count },
  });

  return { ...result, status: 'Active' };
}

// ─── updateMember ────────────────────────────────────────────────────────────
export async function updateMember(
  userId:        string,
  group_id:      string,
  membership_id: string,
  data:          { share_count: number },
) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin') {
    throw new AppError(403, 'FORBIDDEN', 'Only the group admin can update member shares.');
  }

  const [lockedProbe, targetRows, groupRows, sharesRows] = await Promise.all([
    db.select({ id: payments.id })
      .from(payments)
      .innerJoin(monthly_cycles, eq(monthly_cycles.id, payments.cycle_id))
      .where(eq(monthly_cycles.group_id, group_id))
      .limit(1),

    db.select({
      id: memberships.id, user_id: memberships.user_id, role: memberships.role,
      share_count: memberships.share_count, wins_count: memberships.wins_count,
      status: memberships.status, joined_at: memberships.joined_at,
      name: users.name, mobile_number: users.mobile_number,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.user_id))
    .where(and(eq(memberships.id, membership_id), eq(memberships.group_id, group_id)))
    .limit(1),

    db.select({ total_shares: chit_groups.total_shares })
      .from(chit_groups)
      .where(eq(chit_groups.id, group_id))
      .limit(1),

    db.select({ shares_filled: sum(memberships.share_count) })
      .from(memberships)
      .where(and(eq(memberships.group_id, group_id), eq(memberships.status, 'Active'))),
  ]);

  if (!targetRows[0]) throw new AppError(404, 'MEMBERSHIP_NOT_FOUND', 'Membership not found in this group.');
  if (lockedProbe[0]) throw new AppError(409, 'FIELD_LOCKED', 'share_count cannot be changed after the group has started.');

  const target         = targetRows[0];
  const wins           = Number(target.wins_count);
  const oldShares      = Number(target.share_count);
  const new_share_count = data.share_count;
  const totalCap       = Number(groupRows[0].total_shares);
  const filled         = Number(sharesRows[0].shares_filled ?? 0);

  if (new_share_count === 0 && target.role !== 'Admin') {
    throw new AppError(400, 'INVALID_SHARE_COUNT', 'Only the admin may have 0 shares.');
  }

  if (new_share_count < wins) {
    throw new AppError(409, 'WINS_EXCEED_SHARES',
      `Cannot reduce share_count to ${new_share_count} — member has already won ${wins} time(s).`);
  }
  if (filled - oldShares + new_share_count > totalCap) {
    throw new AppError(409, 'SHARES_EXCEEDED', `This change would exceed group capacity of ${totalCap} shares.`);
  }

  await db.update(memberships).set({ share_count: new_share_count }).where(eq(memberships.id, membership_id));

  return {
    membership_id: target.id,
    user_id:       target.user_id,
    name:          target.name,
    mobile_number: target.mobile_number,
    role:          target.role,
    share_count:   new_share_count,
    wins_count:    wins,
    is_eligible_to_win: new_share_count > wins && target.status === 'Active',
    status:        target.status,
    joined_at:     target.joined_at,
  };
}

// ─── removeMember ────────────────────────────────────────────────────────────
export async function removeMember(
  userId:        string,
  group_id:      string,
  membership_id: string,
  data:          { reason?: string; confirm_active_cycle?: boolean },
) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin') {
    throw new AppError(403, 'FORBIDDEN', 'Only the group admin can remove members.');
  }

  const [target] = await db
    .select({ id: memberships.id, user_id: memberships.user_id, role: memberships.role, status: memberships.status })
    .from(memberships)
    .where(and(eq(memberships.id, membership_id), eq(memberships.group_id, group_id)))
    .limit(1);

  if (!target) throw new AppError(404, 'MEMBERSHIP_NOT_FOUND', 'Membership not found in this group.');
  if (target.role === 'Admin') {
    throw new AppError(409, 'LAST_ADMIN', 'Cannot remove the group admin. Transfer admin role to another member first.');
  }

  const [existingPayment] = await db
    .select({ id: payments.id })
    .from(payments)
    .innerJoin(monthly_cycles, eq(monthly_cycles.id, payments.cycle_id))
    .where(eq(monthly_cycles.group_id, group_id))
    .limit(1);

  if (existingPayment && !data.confirm_active_cycle) {
    throw new AppError(409, 'CONFIRMATION_REQUIRED',
      'Group has an active cycle. Pass confirm_active_cycle: true to confirm removal.');
  }

  const deactivatedAt = new Date();
  const [updated] = await db
    .update(memberships)
    .set({ status: 'Inactive', deactivated_at: deactivatedAt, ...(data.reason != null ? { notes: data.reason } : {}) })
    .where(eq(memberships.id, membership_id))
    .returning({ id: memberships.id });

  if (!updated) throw new AppError(404, 'MEMBERSHIP_NOT_FOUND', 'Membership not found.');

  await insertActivity({ group_id, event_type: 'MEMBER_REMOVED', actor_id: target.user_id });

  return { membership_id, status: 'Inactive', deactivated_at: deactivatedAt };
}

// ─── initiateTransferAdmin ───────────────────────────────────────────────────
export async function initiateTransferAdmin(
  userId:        string,
  group_id:      string,
  membership_id: string,
) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin') throw new AppError(403, 'FORBIDDEN', 'Only the current admin can initiate a transfer.');

  const [target] = await db
    .select({ id: memberships.id, role: memberships.role, status: memberships.status, user_id: memberships.user_id })
    .from(memberships)
    .where(and(eq(memberships.id, membership_id), eq(memberships.group_id, group_id)))
    .limit(1);

  if (!target)                    throw new AppError(404, 'MEMBERSHIP_NOT_FOUND', 'Target membership not found.');
  if (target.status !== 'Active') throw new AppError(409, 'INVALID_REQUEST', 'Target member must be Active.');
  if (target.role === 'Admin')    throw new AppError(409, 'INVALID_REQUEST', 'Target is already the Admin.');

  // Block if a non-expired, non-completed transfer already exists
  const [existing] = await db
    .select({ id: pending_admin_transfers.id })
    .from(pending_admin_transfers)
    .where(and(
      eq(pending_admin_transfers.group_id, group_id),
      isNull(pending_admin_transfers.completed_at),
      gt(pending_admin_transfers.expires_at, new Date()),
    ))
    .limit(1);

  if (existing) throw new AppError(409, 'INVALID_REQUEST', 'A pending admin transfer already exists for this group.');

  const [fromUser, toUser] = await Promise.all([
    db.select({ mobile_number: users.mobile_number }).from(users).where(eq(users.id, userId)).limit(1),
    db.select({ mobile_number: users.mobile_number }).from(users).where(eq(users.id, target.user_id)).limit(1),
  ]);

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const [record] = await db
    .insert(pending_admin_transfers)
    .values({ group_id, from_user_id: userId, to_user_id: target.user_id, to_membership_id: membership_id, expires_at: expiresAt })
    .returning({ id: pending_admin_transfers.id, expires_at: pending_admin_transfers.expires_at });

  await Promise.all([
    otpService.sendOtp(fromUser[0].mobile_number, 'admin_transfer'),
    otpService.sendOtp(toUser[0].mobile_number,   'admin_transfer'),
  ]);

  return { transfer_id: record.id, expires_at: record.expires_at };
}

// ─── confirmTransferAdmin ────────────────────────────────────────────────────
export async function confirmTransferAdmin(transferId: string, otp: string, userId: string) {
  const now = new Date();

  const [transfer] = await db
    .select({
      id: pending_admin_transfers.id, group_id: pending_admin_transfers.group_id,
      from_user_id: pending_admin_transfers.from_user_id, to_user_id: pending_admin_transfers.to_user_id,
      to_membership_id: pending_admin_transfers.to_membership_id,
      from_confirmed_at: pending_admin_transfers.from_confirmed_at,
      to_confirmed_at:   pending_admin_transfers.to_confirmed_at,
      expires_at: pending_admin_transfers.expires_at, completed_at: pending_admin_transfers.completed_at,
    })
    .from(pending_admin_transfers)
    .where(eq(pending_admin_transfers.id, transferId))
    .limit(1);

  if (!transfer)               throw new AppError(404, 'NOT_FOUND', 'Transfer not found.');
  if (transfer.completed_at)   throw new AppError(409, 'INVALID_REQUEST', 'Transfer already completed.');
  if (transfer.expires_at < now) throw new AppError(409, 'INVALID_REQUEST', 'Transfer has expired.');
  if (userId !== transfer.from_user_id && userId !== transfer.to_user_id) {
    throw new AppError(403, 'FORBIDDEN', 'You are not a party to this transfer.');
  }

  const isFrom = userId === transfer.from_user_id;
  if (isFrom  && transfer.from_confirmed_at) throw new AppError(409, 'INVALID_REQUEST', 'You have already confirmed.');
  if (!isFrom && transfer.to_confirmed_at)   throw new AppError(409, 'INVALID_REQUEST', 'You have already confirmed.');

  const [userRow] = await db
    .select({ mobile_number: users.mobile_number })
    .from(users).where(eq(users.id, userId)).limit(1);

  await otpService.verifyOtp(userRow.mobile_number, otp, 'admin_transfer');

  if (isFrom) {
    await db.update(pending_admin_transfers).set({ from_confirmed_at: now }).where(eq(pending_admin_transfers.id, transferId));
  } else {
    await db.update(pending_admin_transfers).set({ to_confirmed_at: now }).where(eq(pending_admin_transfers.id, transferId));
  }

  const otherConfirmed = isFrom ? transfer.to_confirmed_at : transfer.from_confirmed_at;
  if (otherConfirmed) {
    await db.transaction(async (tx) => {
      // Demote first to satisfy the one-admin-per-group partial unique index
      await tx.update(memberships).set({ role: 'Member' })
        .where(and(eq(memberships.group_id, transfer.group_id), eq(memberships.user_id, transfer.from_user_id)));
      await tx.update(memberships).set({ role: 'Admin' })
        .where(eq(memberships.id, transfer.to_membership_id));
      await tx.update(pending_admin_transfers).set({ completed_at: now })
        .where(eq(pending_admin_transfers.id, transferId));
    });
    return { status: 'completed', message: 'Admin transfer completed. Roles have been swapped.' };
  }

  return { status: 'pending', message: `Confirmation recorded. Waiting for the ${isFrom ? 'new' : 'current'} admin to confirm.` };
}

// ─── listJoinRequests ────────────────────────────────────────────────────────
export async function listJoinRequests(userId: string, group_id: string) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin') {
    throw new AppError(403, 'FORBIDDEN', 'Only the group admin can view join requests.');
  }

  return db
    .select({
      membership_id:         memberships.id,
      user_id:               memberships.user_id,
      name:                  users.name,
      mobile_number:         users.mobile_number,
      requested_share_count: memberships.requested_share_count,
      requested_at:          memberships.joined_at,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.user_id))
    .where(and(eq(memberships.group_id, group_id), eq(memberships.status, 'Pending')));
}

// ─── approveJoinRequest ──────────────────────────────────────────────────────
export async function approveJoinRequest(
  userId:        string,
  group_id:      string,
  membership_id: string,
  data:          { share_count?: number },
) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin') {
    throw new AppError(403, 'FORBIDDEN', 'Only the group admin can approve join requests.');
  }

  const [targetRows, groupRows, sharesRows] = await Promise.all([
    db.select({
      id:                    memberships.id,
      user_id:               memberships.user_id,
      status:                memberships.status,
      requested_share_count: memberships.requested_share_count,
      share_count:           memberships.share_count,
    })
    .from(memberships)
    .where(and(eq(memberships.id, membership_id), eq(memberships.group_id, group_id)))
    .limit(1),

    db.select({ total_shares: chit_groups.total_shares })
      .from(chit_groups)
      .where(eq(chit_groups.id, group_id))
      .limit(1),

    db.select({ shares_filled: sum(memberships.share_count) })
      .from(memberships)
      .where(and(eq(memberships.group_id, group_id), eq(memberships.status, 'Active'))),
  ]);

  if (!targetRows[0]) throw new AppError(404, 'MEMBERSHIP_NOT_FOUND', 'Join request not found.');
  const target = targetRows[0];
  if (target.status !== 'Pending') {
    throw new AppError(409, 'INVALID_REQUEST', 'This membership is not in Pending status.');
  }

  const finalShares = data.share_count ?? Number(target.requested_share_count ?? target.share_count);
  const totalCap    = Number(groupRows[0].total_shares);
  const filled      = Number(sharesRows[0].shares_filled ?? 0);

  if (filled + finalShares > totalCap) {
    throw new AppError(409, 'SHARES_EXCEEDED',
      `Approving ${finalShares} share(s) would exceed group capacity of ${totalCap} (${filled} Active shares already filled).`);
  }

  await db
    .update(memberships)
    .set({ status: 'Active', share_count: finalShares })
    .where(eq(memberships.id, membership_id));

  await db.insert(notifications).values({
    user_id:  target.user_id,
    group_id,
    type:     'JOIN_REQUEST_APPROVED',
    title:    'Join request approved',
    body:     `Your request to join the group has been approved with ${finalShares} share(s).`,
    data:     { membership_id },
  });

  await insertActivity({
    group_id,
    event_type: 'MEMBER_JOINED',
    actor_id:   target.user_id,
    data:       { share_count: finalShares },
  });

  return { membership_id, user_id: target.user_id, share_count: finalShares, status: 'Active' };
}

// ─── rejectJoinRequest ───────────────────────────────────────────────────────
export async function rejectJoinRequest(
  userId:        string,
  group_id:      string,
  membership_id: string,
  data:          { reason?: string },
) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin') {
    throw new AppError(403, 'FORBIDDEN', 'Only the group admin can reject join requests.');
  }

  const [target] = await db
    .select({ id: memberships.id, user_id: memberships.user_id, status: memberships.status })
    .from(memberships)
    .where(and(eq(memberships.id, membership_id), eq(memberships.group_id, group_id)))
    .limit(1);

  if (!target) throw new AppError(404, 'MEMBERSHIP_NOT_FOUND', 'Join request not found.');
  if (target.status !== 'Pending') {
    throw new AppError(409, 'INVALID_REQUEST', 'This membership is not in Pending status.');
  }

  await db
    .update(memberships)
    .set({
      status:         'Inactive',
      deactivated_at: new Date(),
      ...(data.reason ? { notes: data.reason } : {}),
    })
    .where(eq(memberships.id, membership_id));

  await db.insert(notifications).values({
    user_id:  target.user_id,
    group_id,
    type:     'JOIN_REQUEST_REJECTED',
    title:    'Join request not approved',
    body:     data.reason
      ? `Your request to join the group was not approved. Reason: ${data.reason}`
      : 'Your request to join the group was not approved. Contact the admin for more information.',
    data:     { membership_id },
  });

  return { membership_id, status: 'Inactive' };
}

// ─── getMemberWins ───────────────────────────────────────────────────────────
export async function getMemberWins(callerId: string, groupId: string, targetUserId: string) {
  const caller = await assertActiveMember(groupId, callerId);

  if (callerId !== targetUserId && caller.role !== 'Admin') {
    throw new AppError(403, 'FORBIDDEN', 'Only an admin can view another member\'s win history.');
  }

  const rows = await db
    .select({
      month_number:        monthly_cycles.month_number,
      month_label:         monthly_cycles.month_label,
      winner_number:       cycle_winners.winner_number,
      bid_amount:          cycle_winners.bid_amount,
      admin_commission:    cycle_winners.admin_commission,
      basket_credit:       cycle_winners.basket_credit,
      winner_takeaway:     cycle_winners.winner_takeaway,
      is_admin_withdrawal: cycle_winners.is_admin_withdrawal,
    })
    .from(cycle_winners)
    .innerJoin(monthly_cycles, eq(monthly_cycles.id, cycle_winners.cycle_id))
    .where(and(
      eq(cycle_winners.group_id,       groupId),
      eq(cycle_winners.winner_user_id, targetUserId),
    ))
    .orderBy(asc(monthly_cycles.month_number));

  return rows;
}

// ─── updateMemberProfile ─────────────────────────────────────────────────────
// Updates name and/or mobile_number on the users table for a member of the group.
// Only the group admin may call this. Changes are global (not per-group) — the
// user's display name and phone are updated everywhere they appear.
export async function updateMemberProfile(
  callerId: string,
  group_id: string,
  target_user_id: string,
  data: { name?: string; phone?: string },
) {
  const caller = await assertActiveMember(group_id, callerId);
  if (caller.role !== 'Admin') {
    throw new AppError(403, 'FORBIDDEN', 'Only the group admin can edit a member\'s profile.');
  }

  // Verify the target user is an active member of this group
  const [targetMembership] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(
      eq(memberships.group_id, group_id),
      eq(memberships.user_id, target_user_id),
      eq(memberships.status, 'Active'),
    ))
    .limit(1);

  if (!targetMembership) {
    throw new AppError(404, 'MEMBER_NOT_FOUND', 'This user is not an active member of the group.');
  }

  // If phone is being changed, check uniqueness against other users
  if (data.phone !== undefined) {
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.mobile_number, data.phone))
      .limit(1);

    if (existing && existing.id !== target_user_id) {
      throw new AppError(409, 'PHONE_TAKEN', 'This phone number is already registered to another user.');
    }
  }

  const updates: Partial<{ name: string; mobile_number: string; updated_at: Date }> = {
    updated_at: new Date(),
  };
  if (data.name  !== undefined) updates.name          = data.name;
  if (data.phone !== undefined) updates.mobile_number = data.phone;

  const [updated] = await db
    .update(users)
    .set(updates)
    .where(eq(users.id, target_user_id))
    .returning({ id: users.id, name: users.name, mobile_number: users.mobile_number });

  if (!updated) throw new AppError(404, 'MEMBER_NOT_FOUND', 'User not found.');

  return {
    user_id:       updated.id,
    name:          updated.name,
    mobile_number: updated.mobile_number,
  };
}

// ─── remindMember ────────────────────────────────────────────────────────────
export async function remindMember(
  userId:        string,
  group_id:      string,
  membership_id: string,
  data:          { channels?: string[]; message?: string },
) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin') {
    throw new AppError(403, 'FORBIDDEN', 'Only the group admin can send reminders.');
  }

  const [target] = await db
    .select({ user_id: memberships.user_id, status: memberships.status })
    .from(memberships)
    .where(and(eq(memberships.id, membership_id), eq(memberships.group_id, group_id)))
    .limit(1);

  if (!target)                    throw new AppError(404, 'MEMBERSHIP_NOT_FOUND', 'Membership not found in this group.');
  if (target.status !== 'Active') throw new AppError(409, 'INVALID_REQUEST', 'Cannot remind an inactive member.');

  await db.insert(notifications).values({
    user_id:  target.user_id,
    group_id,
    type:     'DEFAULTER_REMINDER',
    title:    'Payment Reminder',
    body:     data.message ?? 'Please complete your outstanding payment for this chit fund.',
    data:     { channels: data.channels ?? ['push'] },
  });

  return { reminder_sent: true };
}
