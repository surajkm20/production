// Creates and configures the Express application.
// Registers global middleware (JSON body parser, request logger, rate limiter)
// and mounts all route groups under /v1.
// Attaches the global error handler last (Express requires this order).

import express from 'express';
import { apiLimiter } from './middleware/rateLimiter';
import { errorHandler } from './middleware/errorHandler';
import { v1Router } from './routes';

export const app = express();

app.use(express.json());
app.use(apiLimiter);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use('/v1', v1Router);

app.use(errorHandler);
