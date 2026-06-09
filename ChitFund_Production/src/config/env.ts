// Reads all environment variables from process.env, validates that required ones are present,
// and exports them as a typed config object.
// The server fails fast at startup if any required variable is missing —
// better to crash immediately than to fail silently at runtime.

import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ path: process.env.NODE_ENV === 'test' ? '.env.test' : '.env' });

const envSchema = z.object({
  DATABASE_URL:             z.string().min(1, 'DATABASE_URL is required'),

  JWT_ACCESS_SECRET:        z.string().min(1, 'JWT_ACCESS_SECRET is required'),
  JWT_REFRESH_SECRET:       z.string().min(1, 'JWT_REFRESH_SECRET is required'),
  JWT_ACCESS_EXPIRES_IN:    z.string().default('15m'),
  JWT_REFRESH_EXPIRES_DAYS: z.coerce.number().default(30),

  PORT:                     z.coerce.number().default(3000),
  NODE_ENV:                 z.enum(['development', 'production', 'test']).default('development'),
  ALLOWED_ORIGINS:          z.string().default('http://localhost:5173'),

  OTP_EXPIRY_MINUTES:       z.coerce.number().default(10),
  OTP_MAX_ATTEMPTS:         z.coerce.number().default(5),

  MSG91_AUTH_KEY:                    z.string().default(''),
  MSG91_TEMPLATE_ID_LOGIN:           z.string().default(''),
  MSG91_TEMPLATE_ID_PASSWORD_RESET:  z.string().default(''),

  VAPID_PUBLIC_KEY:         z.string().default(''),
  VAPID_PRIVATE_KEY:        z.string().default(''),
  VAPID_CONTACT_EMAIL:      z.string().default(''),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error('❌ Invalid environment variables:', parsedEnv.error.format());
  process.exit(1);
}

export const env = parsedEnv.data;