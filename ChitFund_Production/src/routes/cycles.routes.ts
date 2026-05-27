// Routes for monthly cycle management (require JWT + group membership):
//   GET   /groups/:group_id/chiti-eligibility                     — Double Chiti eligibility (admin + member)
//   GET   /groups/:group_id/cycles                                — list all cycles
//   GET   /groups/:group_id/cycles/:cycle_id                      — cycle detail
//   POST  /groups/:group_id/cycles/:cycle_id/record-winner  [admin] — supports multiple calls (Double Chiti)
//   POST  /groups/:group_id/cycles/:cycle_id/declare-skip-month  [admin]
//   PATCH /groups/:group_id/cycles/:cycle_id                [admin] — edit first winner within 24h window
//   POST  /groups/:group_id/cycles/:cycle_id/close          [admin]

import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { requireMember } from '../middleware/requireMember';
import { requireAdmin } from '../middleware/requireAdmin';
import { validate } from '../middleware/validate';
import { recordWinnerSchema, declareSkipMonthSchema, updateCycleSchema, correctCycleSchema } from '../validators/cycles.validators';
import * as cycles from '../controllers/cycles.controller';

export const cyclesRouter = Router();

cyclesRouter.use('/:group_id', authenticate, requireMember);

cyclesRouter.get('/:group_id/chiti-eligibility',                                 cycles.getChitiEligibility);
cyclesRouter.get('/:group_id/cycles',                                          cycles.listCycles);
cyclesRouter.get('/:group_id/cycles/:cycle_id',                                cycles.getCycle);
cyclesRouter.post('/:group_id/cycles/:cycle_id/record-winner',     requireAdmin, validate(recordWinnerSchema),     cycles.recordWinner);
cyclesRouter.post('/:group_id/cycles/:cycle_id/declare-skip-month', requireAdmin, validate(declareSkipMonthSchema), cycles.declareSkipMonth);
cyclesRouter.patch('/:group_id/cycles/:cycle_id',                   requireAdmin, validate(updateCycleSchema),      cycles.updateCycle);
cyclesRouter.post('/:group_id/cycles/:cycle_id/close',              requireAdmin,                                   cycles.closeCycle);
cyclesRouter.post('/:group_id/cycles/:cycle_id/correct',            requireAdmin, validate(correctCycleSchema),      cycles.correctClosedCycle);
cyclesRouter.post('/:group_id/cycles/:cycle_id/reopen',             requireAdmin,                                       cycles.reopenCycle);
