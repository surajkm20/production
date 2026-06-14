/**
 * @fileoverview Payment-tracking route definitions for the ChitFund API. It maps
 * endpoints for listing a cycle's payments, the admin-only actions to update an
 * individual payment, bulk-mark payments, and remind defaulters, plus a member's
 * own payment history. It exists to centralise per-cycle contribution tracking
 * under one router while applying membership, admin authorisation, and Zod
 * validation to each mutating endpoint.
 * @module routes/payments
 * @author Suraj KM
 */

// Routes for payment tracking (require JWT + group membership):
//   GET   /groups/:group_id/cycles/:cycle_id/payments              — list payments for a cycle
//   PATCH /groups/:group_id/payments/:payment_id         [admin]   — mark paid/unpaid, edit details
//   POST  /groups/:group_id/cycles/:cycle_id/payments/bulk [admin] — bulk mark payments
//   POST  /groups/:group_id/cycles/:cycle_id/remind-defaulters [admin]
//   GET   /groups/:group_id/members/:user_id/payments              — member payment history

import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { requireMember } from '../middleware/requireMember';
import { requireAdmin } from '../middleware/requireAdmin';
import { validate } from '../middleware/validate';
import { updatePaymentSchema, bulkMarkPaymentsSchema, remindDefaultersSchema } from '../validators/payments.validators';
import * as payments from '../controllers/payments.controller';

/** Router for payment-tracking endpoints, mounted under `/groups`. */
export const paymentsRouter = Router();

paymentsRouter.use('/:group_id', authenticate, requireMember);

paymentsRouter.get('/:group_id/cycles/:cycle_id/payments',                                                         payments.listPayments);
paymentsRouter.patch('/:group_id/payments/:payment_id',          requireAdmin, validate(updatePaymentSchema),      payments.updatePayment);
paymentsRouter.post('/:group_id/cycles/:cycle_id/payments/bulk', requireAdmin, validate(bulkMarkPaymentsSchema),   payments.bulkMarkPayments);
paymentsRouter.post('/:group_id/cycles/:cycle_id/remind-defaulters', requireAdmin, validate(remindDefaultersSchema), payments.remindDefaulters);
paymentsRouter.get('/:group_id/members/:user_id/payments',                                                         payments.memberPaymentHistory);
