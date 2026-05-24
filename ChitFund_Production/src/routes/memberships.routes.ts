// Routes for group membership management (require JWT + group membership):
//   GET    /groups/:group_id/members                              — list members
//   POST   /groups/:group_id/members                [admin]      — add member by mobile
//   PATCH  /groups/:group_id/members/:membership_id [admin]      — update share_count
//   DELETE /groups/:group_id/members/:membership_id [admin]      — soft-deactivate member
//   POST   /groups/:group_id/members/:membership_id/transfer-admin  [admin]
//   POST   /groups/:group_id/transfer-admin/:transfer_id/confirm
//   POST   /groups/:group_id/members/:membership_id/remind       [admin]

import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { requireMember } from '../middleware/requireMember';
import { requireAdmin } from '../middleware/requireAdmin';
import { validate } from '../middleware/validate';
import { addMemberSchema, updateMemberSchema, removeMemberSchema, remindMemberSchema, confirmTransferAdminSchema, approveJoinRequestSchema, rejectJoinRequestSchema, updateMemberProfileSchema } from '../validators/memberships.validators';
import * as memberships from '../controllers/memberships.controller';

export const membershipsRouter = Router();

membershipsRouter.use('/:group_id/members',      authenticate, requireMember);
membershipsRouter.use('/:group_id/join-requests', authenticate, requireMember);

membershipsRouter.get('/:group_id/members',                                              memberships.listMembers);
membershipsRouter.post('/:group_id/members',                               requireAdmin, validate(addMemberSchema),    memberships.addMember);
membershipsRouter.patch('/:group_id/members/:membership_id',               requireAdmin, validate(updateMemberSchema), memberships.updateMember);
membershipsRouter.delete('/:group_id/members/:membership_id',              requireAdmin, validate(removeMemberSchema), memberships.removeMember);
membershipsRouter.patch('/:group_id/members/:user_id/profile',             requireAdmin, validate(updateMemberProfileSchema), memberships.updateMemberProfile);
membershipsRouter.post('/:group_id/members/:membership_id/transfer-admin', requireAdmin,                               memberships.initiateTransferAdmin);
membershipsRouter.post('/:group_id/transfer-admin/:transfer_id/confirm',   authenticate, validate(confirmTransferAdminSchema), memberships.confirmTransferAdmin);
membershipsRouter.post('/:group_id/members/:membership_id/remind',         requireAdmin, validate(remindMemberSchema), memberships.remindMember);

membershipsRouter.get('/:group_id/members/:user_id/wins',    authenticate, requireMember, memberships.getMemberWins);

// Join request management (admin only)
membershipsRouter.get('/:group_id/join-requests',                                              requireAdmin,                                  memberships.listJoinRequests);
membershipsRouter.post('/:group_id/join-requests/:membership_id/approve',  requireAdmin, validate(approveJoinRequestSchema), memberships.approveJoinRequest);
membershipsRouter.post('/:group_id/join-requests/:membership_id/reject',   requireAdmin, validate(rejectJoinRequestSchema),  memberships.rejectJoinRequest);
