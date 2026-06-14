/**
 * @fileoverview Root API router for the ChitFund backend. It imports every domain
 * router and mounts them under the `/v1` prefix, giving `app.ts` a single entry
 * point to wire up the entire API surface. It exists to centralise route
 * composition so that adding a new domain requires only one import and one
 * `v1Router.use(...)` line here, keeping the server bootstrap clean and the
 * URL namespace consistent.
 * @module routes/index
 * @author Suraj KM
 */

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
import { adminRouter } from './admin.routes';

/** Aggregate `/v1` router mounting every domain sub-router; import this in `app.ts`. */
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
v1Router.use('/admin', adminRouter);
