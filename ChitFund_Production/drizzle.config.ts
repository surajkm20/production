// Drizzle Kit configuration.
// Tells drizzle-kit where to find the schema, which DB dialect to use,
// and where to write the generated SQL migration files.
// Run `npm run db:generate` to produce migrations, `npm run db:migrate` to apply them.
import { defineConfig } from 'drizzle-kit';
import 'dotenv/config';

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});