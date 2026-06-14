/**
 * @fileoverview Current-user (`/me`) route definitions for the ChitFund API. It
 * declares the endpoints a signed-in user uses to manage their own account —
 * profile read/update, password change, active session listing and revocation,
 * in-app notifications, notification preferences, and Web Push subscriptions.
 * All routes require JWT auth and operate strictly on the authenticated caller,
 * so it exists to keep self-service account and session management isolated from
 * the group-scoped routers.
 * @module routes/users
 * @author Suraj KM
 */

// Routes for the current user's profile and session management (all require JWT):
//   GET    /me
//   PATCH  /me
//   POST   /me/change-password
//   GET    /me/sessions
//   DELETE /me/sessions/:id
//   GET    /me/notifications
//   POST   /me/notifications/mark-read
//   DELETE /me/notifications
//   GET    /me/notification-preferences
//   PUT    /me/notification-preferences
//   POST   /me/push-subscriptions
//   DELETE /me/push-subscriptions/:id

import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import * as users from '../controllers/users.controller';

/** Router for current-user profile and session endpoints, mounted at `/me`. */
export const usersRouter = Router();

usersRouter.use(authenticate);

usersRouter.get('/',                             users.getMe);
usersRouter.patch('/',                           users.updateMe);
usersRouter.post('/change-password',             users.changePassword);
usersRouter.get('/sessions',                     users.listSessions);
usersRouter.delete('/sessions/:id',              users.revokeSession);
usersRouter.get('/notifications',                users.listNotifications);
usersRouter.post('/notifications/mark-read',     users.markNotificationsRead);
usersRouter.delete('/notifications',             users.clearNotifications);
usersRouter.get('/notification-preferences',     users.getNotificationPreferences);
usersRouter.put('/notification-preferences',     users.updateNotificationPreferences);
usersRouter.post('/push-subscriptions',          users.addPushSubscription);
usersRouter.delete('/push-subscriptions/:id',    users.removePushSubscription);
