// Integration tests for cycle closing and final-cycle seeding.
// Covers: normal next-cycle seeding, final-cycle basket offset with admin commission,
//         full-coverage (all-Waived) case, and empty-basket case.

import request from 'supertest';
import { app } from '../src/app';
import { db } from '../src/config/db';
import { payments, monthly_cycles, basket_transactions, baskets } from '../src/db/schema';
import { eq, and } from 'drizzle-orm';
import { createUser, createGroup } from './helpers/seed';

// ─── helpers ─────────────────────────────────────────────────────────────────

async function startGroup(adminToken: string, group_id: string) {
  const res = await request(app)
    .post(`/v1/groups/${group_id}/start`)
    .set('Authorization', `Bearer ${adminToken}`);
  if (res.status !== 200) throw new Error(`startGroup failed: ${JSON.stringify(res.body)}`);
  return res.body.data.current_cycle as { cycle_id: string; month_number: number };
}

async function markAllPaid(adminToken: string, group_id: string, cycle_id: string) {
  const res = await request(app)
    .post(`/v1/groups/${group_id}/cycles/${cycle_id}/payments/bulk`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ payment_ids: 'all_unpaid', status: 'Paid', paid_at: new Date().toISOString() });
  if (res.status !== 200) throw new Error(`markAllPaid failed: ${JSON.stringify(res.body)}`);
}

async function recordWinner(adminToken: string, group_id: string, cycle_id: string, winner_user_id: string, bid_amount: number) {
  const res = await request(app)
    .post(`/v1/groups/${group_id}/cycles/${cycle_id}/record-winner`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ winner_user_id, bid_amount });
  if (res.status !== 200) throw new Error(`recordWinner failed: ${JSON.stringify(res.body)}`);
  return res.body.data;
}

async function closeCycle(adminToken: string, group_id: string, cycle_id: string) {
  const res = await request(app)
    .post(`/v1/groups/${group_id}/cycles/${cycle_id}/close`)
    .set('Authorization', `Bearer ${adminToken}`);
  if (res.status !== 200) throw new Error(`closeCycle failed: ${JSON.stringify(res.body)}`);
  return res.body.data;
}

// Get the cycle with a given month_number for a group.
async function getCycleByMonth(group_id: string, month_number: number) {
  const [row] = await db.select({ id: monthly_cycles.id })
    .from(monthly_cycles)
    .where(and(eq(monthly_cycles.group_id, group_id), eq(monthly_cycles.month_number, month_number)));
  if (!row) throw new Error(`No cycle found for month_number=${month_number}`);
  return row;
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('Final-cycle seeding via closeCycle', () => {

  it('non-final cycle seeding: expected_amount = contribution × share_count, status Unpaid', async () => {
    // Group with 3 cycles, admin holds all 3 shares.
    // Closing cycle 1 seeds cycle 2 (not final). Cycle 2 should use normal contribution.
    // pool = 3 × 5000 = 15000, contribution = 5000, admin_commission = 0
    const admin = await createUser();
    const { group_id } = await createGroup(admin.token, {
      monthly_contribution: 5000,
      total_shares: 3,
      admin_commission_rate: 0,
      admin_share_count: 3,
    });

    await startGroup(admin.token, group_id);
    const cycle1 = await getCycleByMonth(group_id, 1);

    await markAllPaid(admin.token, group_id, cycle1.id);
    await recordWinner(admin.token, group_id, cycle1.id, admin.id, 1000);
    await closeCycle(admin.token, group_id, cycle1.id);

    // Cycle 2 is NOT the final cycle (total_months = 3). Should be seeded normally.
    const cycle2 = await getCycleByMonth(group_id, 2);
    const cycle2Payments = await db.select({ expected_amount: payments.expected_amount, status: payments.status })
      .from(payments).where(eq(payments.cycle_id, cycle2.id));

    expect(cycle2Payments.length).toBe(1); // only admin
    // Normal contribution: 5000 × 3 shares = 15000 paise
    expect(Number(cycle2Payments[0].expected_amount)).toBe(15000);
    expect(cycle2Payments[0].status).toBe('Unpaid');
  });

  it('final-cycle seeding: basket partially offsets pool + admin_commission', async () => {
    // Group: 2 cycles, admin holds all 2 shares.
    // pool = 2 × 5000 = 10000, admin_commission_rate = 5%
    // admin_commission = round(10000 × 5/100) = 500
    // total_needed = 10000 + 500 = 10500
    // basket after cycle-1 close: 3000 (manual credit) + basket_credit from winner
    //   bid_amount = 2000, commission = 500, basket_credit = 1500
    //   basket after winner recording = 3000 + 1500 = 4500
    // basket_contribution = min(4500, 10500) = 4500
    // remaining_to_collect = 10500 - 4500 = 6000
    // admin has 2/2 shares = all → expected_amount = floor(6000 × 2 / 2) = 6000
    const admin = await createUser();
    const { group_id } = await createGroup(admin.token, {
      monthly_contribution: 5000,
      total_shares: 2,
      admin_commission_rate: 5,
      admin_share_count: 2,
    });

    // Credit basket 3000 paise
    await request(app)
      .post(`/v1/groups/${group_id}/basket/adjustments`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ direction: 'C', amount: 3000, notes: 'Test seed' });

    await startGroup(admin.token, group_id);
    const cycle1 = await getCycleByMonth(group_id, 1);

    await markAllPaid(admin.token, group_id, cycle1.id);
    await recordWinner(admin.token, group_id, cycle1.id, admin.id, 2000);
    await closeCycle(admin.token, group_id, cycle1.id);

    // Final cycle (cycle 2) payments
    const cycle2 = await getCycleByMonth(group_id, 2);
    const cycle2Payments = await db.select({ expected_amount: payments.expected_amount, status: payments.status })
      .from(payments).where(eq(payments.cycle_id, cycle2.id));

    expect(cycle2Payments.length).toBe(1);
    expect(Number(cycle2Payments[0].expected_amount)).toBe(6000);
    expect(cycle2Payments[0].status).toBe('Unpaid');

    // DEBIT_FINAL_CYCLE_OFFSET transaction must exist for cycle2 with amount=4500
    const txns = await db.select({ txn_type: basket_transactions.txn_type, amount: basket_transactions.amount, direction: basket_transactions.direction })
      .from(basket_transactions)
      .where(eq(basket_transactions.cycle_id, cycle2.id));

    const offsetTxn = txns.find(t => t.txn_type === 'DEBIT_FINAL_CYCLE_OFFSET');
    expect(offsetTxn).toBeDefined();
    expect(Number(offsetTxn!.amount)).toBe(4500);
    expect(offsetTxn!.direction).toBe('D');
  });

  it('final-cycle seeding: basket covers total_needed exactly — all payments Waived', async () => {
    // pool = 10000, admin_commission = 5% → total_needed = 10500
    // basket credit = 15000 → basket_contribution = min(basket, 10500) = 10500
    // remaining_to_collect = 0 → all Waived, expected_amount = 0
    // DEBIT_FINAL_CYCLE_OFFSET amount = 10500 (not 15000 — capped at total_needed)
    const admin = await createUser();
    const { group_id } = await createGroup(admin.token, {
      monthly_contribution: 5000,
      total_shares: 2,
      admin_commission_rate: 5,
      admin_share_count: 2,
    });

    await request(app)
      .post(`/v1/groups/${group_id}/basket/adjustments`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ direction: 'C', amount: 15000, notes: 'Large credit for test' });

    await startGroup(admin.token, group_id);
    const cycle1 = await getCycleByMonth(group_id, 1);

    await markAllPaid(admin.token, group_id, cycle1.id);
    await recordWinner(admin.token, group_id, cycle1.id, admin.id, 2000);
    await closeCycle(admin.token, group_id, cycle1.id);

    const cycle2 = await getCycleByMonth(group_id, 2);
    const cycle2Payments = await db.select({ expected_amount: payments.expected_amount, status: payments.status })
      .from(payments).where(eq(payments.cycle_id, cycle2.id));

    expect(cycle2Payments.length).toBe(1);
    expect(Number(cycle2Payments[0].expected_amount)).toBe(0);
    expect(cycle2Payments[0].status).toBe('Waived');

    const txns = await db.select({ txn_type: basket_transactions.txn_type, amount: basket_transactions.amount })
      .from(basket_transactions)
      .where(eq(basket_transactions.cycle_id, cycle2.id));

    const offsetTxn = txns.find(t => t.txn_type === 'DEBIT_FINAL_CYCLE_OFFSET');
    expect(offsetTxn).toBeDefined();
    expect(Number(offsetTxn!.amount)).toBe(10500); // capped at total_needed
  });

  it('final-cycle seeding: basket balance from winner credit only — correct offset applied, no manual credit', async () => {
    // pool = 10000, admin_commission = 0% → total_needed = 10000
    // No manual basket credit. After recording winner bid=2000 (commission=0):
    //   basket_credit = 2000, basket = 2000
    // At seeding: basket_contribution = min(2000, 10000) = 2000
    //             remaining = 10000 - 2000 = 8000
    // admin has 2/2 shares → expected_amount = floor(8000 × 2/2) = 8000
    // DEBIT_FINAL_CYCLE_OFFSET created for 2000
    const admin = await createUser();
    const { group_id } = await createGroup(admin.token, {
      monthly_contribution: 5000,
      total_shares: 2,
      admin_commission_rate: 0,
      admin_share_count: 2,
    });
    // No basket credit — only winner recording will add to basket

    await startGroup(admin.token, group_id);
    const cycle1 = await getCycleByMonth(group_id, 1);

    await markAllPaid(admin.token, group_id, cycle1.id);
    await recordWinner(admin.token, group_id, cycle1.id, admin.id, 2000);
    // Basket now = 2000 (basket_credit from bid with 0% commission)
    await closeCycle(admin.token, group_id, cycle1.id);

    const cycle2 = await getCycleByMonth(group_id, 2);
    const cycle2Payments = await db.select({ expected_amount: payments.expected_amount, status: payments.status })
      .from(payments).where(eq(payments.cycle_id, cycle2.id));

    expect(cycle2Payments.length).toBe(1);
    expect(Number(cycle2Payments[0].expected_amount)).toBe(8000); // 10000 - 2000
    expect(cycle2Payments[0].status).toBe('Unpaid');

    const txns = await db.select({ txn_type: basket_transactions.txn_type, amount: basket_transactions.amount })
      .from(basket_transactions)
      .where(eq(basket_transactions.cycle_id, cycle2.id));

    const offsetTxn = txns.find(t => t.txn_type === 'DEBIT_FINAL_CYCLE_OFFSET');
    expect(offsetTxn).toBeDefined(); // basket had 2000 to contribute
    expect(Number(offsetTxn!.amount)).toBe(2000);
  });

  it('GET /cycles/:cycle_id returns is_final_cycle and basket_contribution in response', async () => {
    // pool = 10000, admin_commission = 0% → total_needed = 10000
    // basket = 5000 → basket_contribution = 5000, remaining = 5000
    // API response for cycle 2 should include is_final_cycle=true, basket_contribution=5000
    const admin = await createUser();
    const { group_id } = await createGroup(admin.token, {
      monthly_contribution: 5000,
      total_shares: 2,
      admin_commission_rate: 0,
      admin_share_count: 2,
    });

    await request(app)
      .post(`/v1/groups/${group_id}/basket/adjustments`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ direction: 'C', amount: 5000, notes: 'Test credit' });

    await startGroup(admin.token, group_id);
    const cycle1 = await getCycleByMonth(group_id, 1);

    await markAllPaid(admin.token, group_id, cycle1.id);
    await recordWinner(admin.token, group_id, cycle1.id, admin.id, 2000);
    await closeCycle(admin.token, group_id, cycle1.id);

    const cycle2 = await getCycleByMonth(group_id, 2);
    const res = await request(app)
      .get(`/v1/groups/${group_id}/cycles/${cycle2.id}`)
      .set('Authorization', `Bearer ${admin.token}`);

    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.is_final_cycle).toBe(true);
    // basket after winner recording: 5000 (credit) + basket_credit(2000-0=2000) = 7000
    // basket_contribution = min(7000, 10000) = 7000
    expect(data.basket_contribution).toBe(7000);
    // remaining = 10000 - 7000 = 3000; admin expected_amount = 3000
    const adminPayment = data.payments[0];
    expect(Number(adminPayment.expected_amount)).toBe(3000);
  });

});
