import cron from 'node-cron';
import { eq, and } from 'drizzle-orm';
import { db } from '../config/db';
import { monthly_cycles, payments, chit_groups } from '../db/schema';
import { notify } from '../services/notifications.service';
import { paiseToRupeeDisplay } from '../utils/money';

// Runs at 09:00 IST (03:30 UTC) every day.
// Finds open, non-skip cycles due in exactly 3 days and sends PAYMENT_DUE
// notifications to every member who still has an Unpaid payment.
export function schedulePaymentDueReminder(): void {
  cron.schedule('30 3 * * *', () => {
    sendPaymentDueReminders().catch(err =>
      console.error('[paymentDueReminder] Error:', err),
    );
  });
}

async function sendPaymentDueReminders(): Promise<void> {
  const target = new Date();
  target.setDate(target.getDate() + 3);
  const targetDateStr = target.toISOString().split('T')[0]; // YYYY-MM-DD

  const dueCycles = await db
    .select({
      id:          monthly_cycles.id,
      group_id:    monthly_cycles.group_id,
      month_label: monthly_cycles.month_label,
      due_date:    monthly_cycles.due_date,
    })
    .from(monthly_cycles)
    .innerJoin(chit_groups, eq(chit_groups.id, monthly_cycles.group_id))
    .where(and(
      eq(monthly_cycles.status, 'Open'),
      eq(monthly_cycles.is_skip_month, false),
      eq(monthly_cycles.due_date, targetDateStr),
    ));

  for (const cycle of dueCycles) {
    const unpaid = await db
      .select({ user_id: payments.member_user_id, expected_amount: payments.expected_amount })
      .from(payments)
      .where(and(eq(payments.cycle_id, cycle.id), eq(payments.status, 'Unpaid')));

    for (const p of unpaid) {
      notify({
        user_id:  p.user_id,
        group_id: cycle.group_id,
        type:     'PAYMENT_DUE',
        title:    'Payment due in 3 days',
        body:     `${paiseToRupeeDisplay(Number(p.expected_amount))} due for ${cycle.month_label} by ${cycle.due_date}.`,
        data:     { cycle_id: cycle.id, month_label: cycle.month_label, due_date: cycle.due_date },
      }).catch(() => {});
    }
  }
}
