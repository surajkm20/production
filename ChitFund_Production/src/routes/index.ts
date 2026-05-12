// Root router. Imports every domain router and mounts them under /v1.
// app.ts imports this single file — adding a new domain only requires one line here.

import { Router } from 'express';
import { authRouter } from './auth.routes';
import { usersRouter } from './users.routes';
import { groupsRouter } from './groups.routes';
import { membershipsRouter } from './memberships.routes';
import { cyclesRouter } from './cycles.routes';
import { paymentsRouter } from './payments.routes';
import { basketRouter } from './basket.routes';
import { analyticsRouter } from './analytics.routes';
import { reportsRouter } from './reports.routes';

export const v1Router = Router();

v1Router.use('/auth', authRouter);
v1Router.use('/me', usersRouter);
v1Router.use('/groups', groupsRouter);
v1Router.use('/groups', membershipsRouter);
v1Router.use('/groups', cyclesRouter);
v1Router.use('/groups', paymentsRouter);
v1Router.use('/groups', basketRouter);
v1Router.use('/groups', analyticsRouter);
v1Router.use('/groups', reportsRouter);
