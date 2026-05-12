// Creates and exports the Drizzle ORM client connected to PostgreSQL.
// This is the single DB instance shared across all services.
// Import `db` from here wherever you need to run queries.

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from './env';

export const client = postgres(env.DATABASE_URL, {
  onnotice: () => {},  // suppress NOTICE messages (e.g. TRUNCATE CASCADE) in test output
});

export const db = drizzle(client);