import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env';
import { apiLimiter } from './middleware/rateLimiter';
import { errorHandler } from './middleware/errorHandler';
import { v1Router } from './routes';

export const app = express();

// Railway/Render terminate SSL at the proxy layer and forward internally as HTTP.
// This tells Express to trust the X-Forwarded-Proto header they inject,
// so req.protocol correctly reflects 'https' instead of always returning 'http'.
app.set('trust proxy', 1);

// Health check before HTTPS redirect so Railway's internal HTTP probe always reaches it.
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Redirect HTTP → HTTPS in production.
app.use((req, res, next) => {
  if (env.NODE_ENV === 'production' && req.protocol !== 'https') {
    return res.redirect(301, `https://${req.headers.host}${req.url}`);
  }
  next();
});

// Security headers: XSS protection, clickjacking prevention, MIME sniffing, HSTS, etc.
app.use(helmet());

// CORS — allow only origins listed in ALLOWED_ORIGINS (comma-separated env var).
// Requests with no Origin header (Capacitor Android WebView, Postman, curl) pass through.
const allowedOrigins = env.ALLOWED_ORIGINS.split(',').map((o) => o.trim());

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin '${origin}' is not allowed`));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

app.use(express.json());
app.use(apiLimiter);

app.use('/v1', v1Router);

app.use(errorHandler);
