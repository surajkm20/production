// Routes for basket and loan management (require JWT + group membership):
//   GET    /groups/:group_id/basket                          — basket overview (members see limited view)
//   GET    /groups/:group_id/basket/transactions             — ledger entries
//   POST   /groups/:group_id/loans                  [admin]  — disburse a new loan
//   GET    /groups/:group_id/loans                           — list loans
//   GET    /groups/:group_id/loans/:loan_id                  — loan detail + repayment history
//   POST   /groups/:group_id/loans/:loan_id/repay   [admin]  — record repayment
//   PATCH  /groups/:group_id/loans/:loan_id          [admin]  — write off or extend due date
//   DELETE /groups/:group_id/loans/:loan_id          [admin]  — delete an Active loan (reverses basket)

import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { requireMember } from '../middleware/requireMember';
import { requireAdmin } from '../middleware/requireAdmin';
import { validate } from '../middleware/validate';
import { disburseLoanSchema, repayLoanSchema, updateLoanSchema, basketAdjustmentSchema, bulkRepaySchema } from '../validators/loans.validators';
import * as basket from '../controllers/basket.controller';

export const basketRouter = Router();

basketRouter.use('/:group_id', authenticate, requireMember);

basketRouter.get('/:group_id/basket',                                                               basket.getBasket);
basketRouter.get('/:group_id/basket/transactions',                                                  basket.listTransactions);
basketRouter.post('/:group_id/basket/adjustments',  requireAdmin, validate(basketAdjustmentSchema), basket.recordAdjustment);
basketRouter.post('/:group_id/loans',                   requireAdmin, validate(disburseLoanSchema), basket.disburseLoan);
basketRouter.get('/:group_id/loans',                                                                basket.listLoans);
basketRouter.get('/:group_id/loans/:loan_id',                                                       basket.getLoan);
basketRouter.post('/:group_id/loans/:loan_id/repay',    requireAdmin, validate(repayLoanSchema),    basket.repayLoan);
basketRouter.patch('/:group_id/loans/:loan_id',         requireAdmin, validate(updateLoanSchema),   basket.updateLoan);
basketRouter.delete('/:group_id/loans/:loan_id',        requireAdmin,                                basket.deleteLoan);
basketRouter.post('/:group_id/loans/bulk-repay',        requireAdmin, validate(bulkRepaySchema),     basket.bulkRepayMember);
