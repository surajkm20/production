// Entry point. Loads env vars, imports the Express app, and starts the HTTP server.
// Nothing else lives here — keep it thin so tests can import app.ts without binding a port.

import './config/env';
import { app } from './app';
import { env } from './config/env';
import { schedulePaymentDueReminder } from './jobs/paymentDueReminder.job';

schedulePaymentDueReminder();

app.listen(env.PORT, () => {
  console.log(`Server running on port ${env.PORT} [${env.NODE_ENV}]`);
});
