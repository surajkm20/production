// Routes for chit group lifecycle (require JWT; admin-only routes noted inline):
//   POST  /groups                              — create group [admin created]
//   GET   /groups                              — list groups the caller belongs to
//   POST  /groups/join                         — join via invitation code
//   GET   /groups/:group_id                    — group detail
//   PATCH /groups/:group_id                    [admin] update mutable fields
//   POST  /groups/:group_id/start              [admin] open cycle 1
//   POST  /groups/:group_id/close              [admin] close the group + trigger closure split
//   POST  /groups/:group_id/rotate-invitation-code  [admin]

import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { requireMember } from '../middleware/requireMember';
import { requireAdmin } from '../middleware/requireAdmin';
import { validate } from '../middleware/validate';
import { createGroupSchema, updateGroupSchema, joinGroupSchema } from '../validators/groups.validators';
import * as groups from '../controllers/groups.controller';

export const groupsRouter = Router();

groupsRouter.use(authenticate);

groupsRouter.post('/',     validate(createGroupSchema),  groups.createGroup);
groupsRouter.get('/',                                    groups.listGroups);
groupsRouter.post('/join', validate(joinGroupSchema),    groups.joinGroup);

groupsRouter.get('/:group_id',            requireMember,                              groups.getGroup);
groupsRouter.patch('/:group_id',          requireMember, requireAdmin, validate(updateGroupSchema), groups.updateGroup);
groupsRouter.post('/:group_id/start',     requireMember, requireAdmin,                groups.startGroup);
groupsRouter.post('/:group_id/close',     requireMember, requireAdmin,                groups.closeGroup);
groupsRouter.post('/:group_id/rotate-invitation-code', requireMember, requireAdmin,   groups.rotateInvitationCode);
groupsRouter.get('/:group_id/activity',               requireMember,                  groups.getGroupActivity);
