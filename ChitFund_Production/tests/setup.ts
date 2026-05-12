import { db, client } from '../src/config/db';
import { sql } from 'drizzle-orm';

beforeEach(async () => {
  // Wipe all tables. CASCADE follows every foreign key, so one statement clears the whole DB.
  await db.execute(sql`TRUNCATE TABLE users CASCADE`);
});

afterAll(async () => {
  await client.end();
});
