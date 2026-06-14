/**
 * @fileoverview Report-generation route definitions for the ChitFund API. It
 * exposes endpoints for group ledger, cycle summary, member history, closure,
 * and loan-register reports, with admin-only reports guarded by `requireAdmin`.
 * It exists to declare the reporting surface in one place; the controllers
 * currently return JSON but can later stream PDF/Excel files without any change
 * to these route definitions.
 * @module routes/reports
 * @author Suraj KM
 */

// Routes for report generation (require JWT + group membership):
//   GET /groups/:group_id/reports/ledger.pdf            [admin]
//   GET /groups/:group_id/reports/ledger.xlsx           [admin]
//   GET /groups/:group_id/cycles/:cycle_id/reports/summary.pdf  [admin]
//   GET /groups/:group_id/members/:user_id/reports/history.pdf
//   GET /groups/:group_id/reports/closure.pdf           [admin]
//   GET /groups/:group_id/reports/loans.xlsx            [admin]
// Currently returns JSON. When PDF/Excel libraries are added, the controllers
// can stream files without changing these routes.

import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { requireMember } from '../middleware/requireMember';
import { requireAdmin } from '../middleware/requireAdmin';
import * as reports from '../controllers/reports.controller';

/** Router for report-generation endpoints, mounted under `/groups`. */
export const reportsRouter = Router();

reportsRouter.use('/:group_id', authenticate, requireMember);

reportsRouter.get('/:group_id/reports/ledger.pdf',                               requireAdmin, reports.groupLedger);
reportsRouter.get('/:group_id/reports/ledger.xlsx',                              requireAdmin, reports.groupLedger);
reportsRouter.get('/:group_id/cycles/:cycle_id/reports/summary.pdf',             requireAdmin, reports.cycleSummary);
reportsRouter.get('/:group_id/members/:user_id/reports/history.pdf',                           reports.memberHistory);
reportsRouter.get('/:group_id/reports/closure.pdf',                              requireAdmin, reports.closureReport);
reportsRouter.get('/:group_id/reports/loans.xlsx',                               requireAdmin, reports.loanRegister);
