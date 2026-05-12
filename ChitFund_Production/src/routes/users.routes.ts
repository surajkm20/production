// Routes for the current user's profile and session management (all require JWT):
//   GET    /me
//   PATCH  /me
//   POST   /me/change-password
//   GET    /me/sessions
//   DELETE /me/sessions/:id
//   GET    /me/notifications
//   POST   /me/notifications/mark-read
//   GET    /me/notification-preferences
//   PUT    /me/notification-preferences
//   POST   /me/push-subscriptions
//   DELETE /me/push-subscriptions/:id

import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import * as users from '../controllers/users.controller';

export const usersRouter = Router();

usersRouter.use(authenticate);

usersRouter.get('/',                             users.getMe);
usersRouter.patch('/',                           users.updateMe);
usersRouter.post('/change-password',             users.changePassword);
usersRouter.get('/sessions',                     users.listSessions);
usersRouter.delete('/sessions/:id',              users.revokeSession);
usersRouter.get('/notifications',                users.listNotifications);
usersRouter.post('/notifications/mark-read',     users.markNotificationsRead);
usersRouter.get('/notification-preferences',     users.getNotificationPreferences);
usersRouter.put('/notification-preferences',     users.updateNotificationPreferences);
usersRouter.post('/push-subscriptions',          users.addPushSubscription);
usersRouter.delete('/push-subscriptions/:id',    users.removePushSubscription);
