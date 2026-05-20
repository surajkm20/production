# ChitFund — Deployment Guide

## What "deployment" actually means

On your laptop, everything runs locally: the backend on `localhost:3000`, the frontend on `localhost:5173`, the DB on your local Postgres. No one outside can reach any of it.

Deployment means moving these three things to computers that are always on and reachable from the internet:

```
Your laptop (dev)              Production (live)
─────────────────              ──────────────────
localhost:3000   →   Railway   (backend API server)
localhost:5173   →   Vercel    (React frontend)
local postgres   →   Railway   (managed PostgreSQL)
```

Each of these is a separate service, hosted separately, but they talk to each other over the internet using URLs instead of localhost.

---

## The three pieces and what they do

### 1. Backend — Railway (Node.js + Express)
- Runs your compiled TypeScript (`node dist/index.js`)
- Handles all API requests at `https://your-api.up.railway.app/v1/...`
- Connects to the production PostgreSQL database
- Runs cron jobs (payment reminders etc.)

### 2. Database — Railway (Managed PostgreSQL)
- A PostgreSQL instance Railway manages for you (backups, updates, uptime)
- Gives you a `DATABASE_URL` connection string
- You never touch the DB server directly — only through Drizzle migrations

### 3. Frontend — Vercel (React + Vite)
- Vercel builds your React app (`npm run build`) and serves the static files
- Users visit `https://yourapp.vercel.app` — they download the HTML/JS/CSS
- Their browser then makes API calls to Railway
- Vercel has zero runtime — it only serves files, your backend does all the work

---

## How a request flows in production

```
User's phone/browser
        │
        │  HTTPS (encrypted)
        ▼
  Vercel CDN  ──── serves the React app (HTML + JS)
        │
        │  React app runs in the browser, user logs in
        │
        ▼
  Railway (your Express server)
        │
        │  Drizzle ORM queries
        ▼
  Railway PostgreSQL
```

Everything between the user and your server is HTTPS — this is why the HTTPS setup we did matters.

---

## First-time deployment — step by step

### Phase 1: Prepare the code

Before deploying, make sure locally:

```bash
npx tsc --noEmit                        # zero TypeScript errors (backend)
cd client && npx tsc -b --noEmit && cd ..  # zero TypeScript errors (frontend)
npm run test:run                        # all tests pass
npm run build                           # dist/ folder builds successfully
```

If any of these fail, fix before deploying. A failed build on Railway means the app won't start.

---

### Phase 2: Deploy the backend (Railway)

**Step 1 — Push your code to GitHub**
Railway pulls code directly from GitHub. Every push to `main` can auto-deploy.

```bash
git add .
git commit -m "ready for production"
git push origin main
```

**Step 2 — Create a Railway account**
Go to railway.app → sign up with GitHub.

**Step 3 — Create a new project**
- New Project → Deploy from GitHub repo → select your repo
- Railway detects Node.js automatically

**Step 4 — Add a PostgreSQL database**
- Inside your Railway project → New → Database → PostgreSQL
- Railway creates a DB and gives you a `DATABASE_URL` variable automatically
- It gets injected into your app's environment — no manual copy needed

**Step 5 — Set environment variables**
In Railway → your service → Variables tab, add:

```
NODE_ENV=production
JWT_ACCESS_SECRET=<generate a strong random string — see note below>
JWT_REFRESH_SECRET=<generate a different strong random string>
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_DAYS=30
OTP_EXPIRY_MINUTES=10
OTP_MAX_ATTEMPTS=5
MSG91_AUTH_KEY=<your real MSG91 key>
MSG91_SENDER_ID=CHITFD
MSG91_TEMPLATE_ID=<your real template ID>
VAPID_PUBLIC_KEY=<generate — see note below>
VAPID_PRIVATE_KEY=<generate — see note below>
VAPID_CONTACT_EMAIL=surajsurya10012000@gmail.com
ALLOWED_ORIGINS=https://yourapp.vercel.app
```

> **How to generate JWT secrets:**
> ```bash
> node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
> ```
> Run this twice — once for ACCESS, once for REFRESH. Never reuse them.

> **How to generate VAPID keys:**
> ```bash
> npx web-push generate-vapid-keys
> ```

**Step 6 — Set build and start commands**
In Railway → your service → Settings:
- Build command: `npm run build`
- Start command: `node dist/index.js`

**Step 7 — Run database migrations**
After the first deploy, open Railway's shell for your service and run:
```bash
npm run db:migrate
```
This applies all your Drizzle migration files to the production DB. **You only run this when there are new migrations** — not on every deploy.

**Step 8 — Verify**
Hit your Railway URL in the browser:
```
https://your-api.up.railway.app/health
```
Should return: `{"status":"ok"}`

---

### Phase 3: Deploy the frontend (Vercel)

**Step 1 — Create a Vercel account**
Go to vercel.com → sign up with GitHub.

**Step 2 — Import your project**
- New Project → Import your GitHub repo
- Set Root Directory to `client/` (important — your frontend lives there)
- Vercel auto-detects Vite

**Step 3 — Set environment variable**
In Vercel → your project → Settings → Environment Variables:
```
VITE_API_URL=https://your-api.up.railway.app
```
This is the Railway URL from Phase 2. No trailing slash.

**Step 4 — Deploy**
Vercel builds and deploys automatically. You get a URL like `https://chitfund-xyz.vercel.app`.

**Step 5 — Update ALLOWED_ORIGINS on Railway**
Now that you have your Vercel URL, go back to Railway and update:
```
ALLOWED_ORIGINS=https://chitfund-xyz.vercel.app
```
Redeploy the Railway service for this to take effect.

**Step 6 — Test end to end**
Open your Vercel URL in a browser → try signup, login, create group. Check Railway logs if anything fails.

---

### Phase 4: Custom domain (optional but recommended)

If you have a domain like `yourchitfund.com`:

**Frontend on Vercel:**
- Vercel → your project → Domains → Add `app.yourchitfund.com`
- Add a CNAME record in your domain registrar pointing to Vercel's servers

**Backend on Railway:**
- Railway → your service → Settings → Custom Domain → Add `api.yourchitfund.com`
- Add a CNAME record pointing to Railway's servers

Then update:
- `VITE_API_URL=https://api.yourchitfund.com` on Vercel
- `ALLOWED_ORIGINS=https://app.yourchitfund.com` on Railway

---

## Environment variables — what they are and why they matter

An environment variable is a value set on the server, outside the code. You never hardcode secrets into source files because:
- Source code goes on GitHub (public or not, breaches happen)
- Different environments need different values (dev DB vs prod DB)

```
.env (local dev)        Railway (production)
────────────────        ────────────────────
DATABASE_URL=           DATABASE_URL=           ← different DB entirely
  localhost/chitfund      railway-postgres-url

JWT_ACCESS_SECRET=      JWT_ACCESS_SECRET=      ← same secret, set once
  any_dev_value           strong_random_64_chars

NODE_ENV=development    NODE_ENV=production     ← controls rate limiting,
                                                   HTTPS redirect, etc.
```

**Never commit `.env` to git.** Our `.gitignore` blocks this. If you ever accidentally commit a secret, treat it as compromised — rotate it immediately.

---

## What happens on every subsequent deploy

After the first deploy, updating the app is simple:

```bash
# make your code changes locally
git add .
git commit -m "your change"
git push origin main
```

Railway detects the push → runs `npm run build` → restarts the server with the new code. Vercel does the same for the frontend. Zero downtime on Railway's paid plan; brief downtime on free.

**When you also have a DB schema change:**
```bash
npm run db:generate     # generates a new migration file in drizzle/
git add drizzle/
git commit -m "add migration: ..."
git push origin main
# after Railway redeploys:
# open Railway shell → npm run db:migrate
```

Always run `db:migrate` after deploying code that depends on a schema change — not before (the old code won't know about new columns), not much after (the new code will crash without the new columns).

---

## Android app (Capacitor) — when you're ready

Capacitor wraps your existing React web app in a native Android shell. The app is essentially a WebView loading your Vercel URL (or the bundled build).

**Install Capacitor (run inside `client/`):**
```bash
npm install @capacitor/core @capacitor/cli @capacitor/android
npx cap init "ChitFund" "com.yourcompany.chitfund" --web-dir dist
npx cap add android
```

**`capacitor.config.ts`:**
```ts
const config: CapacitorConfig = {
  appId: 'com.yourcompany.chitfund',
  appName: 'ChitFund',
  webDir: 'dist',
  server: {
    url: 'https://app.yourchitfund.com',  // your live Vercel URL
    cleartext: false,                      // no HTTP allowed
  },
};
```

**Build and sync:**
```bash
npm run build           # build the React app
npx cap sync            # copy web assets into android/
npx cap open android    # open Android Studio
```

**In Android Studio:**
- Build → Generate Signed Bundle/APK → Android App Bundle (.aab)
- Create a keystore on first time (keep it safe — you need it for every future update)
- Upload the `.aab` to Google Play Console

**CORS note for Capacitor:**
Mobile WebViews do not send an `Origin` header. Our CORS setup already handles this with the `!origin` check — the Android app will work without any extra CORS changes.

---

## What to check after every deploy

```
□ /health endpoint returns {"status":"ok"}
□ Signup + OTP flow works
□ Login works
□ At least one protected route returns data (not 401/403)
□ Railway logs show no startup errors
□ No CORS errors in browser DevTools console
```

---

## Common problems and fixes

| Symptom | Likely cause | Fix |
|---|---|---|
| App crashes on Railway start | Missing env var | Check Railway logs for "Invalid environment variables" |
| All API calls return 502 | Build failed or app crashed | Check Railway deploy logs |
| CORS error in browser | `ALLOWED_ORIGINS` doesn't match Vercel URL | Update `ALLOWED_ORIGINS` on Railway and redeploy |
| Frontend shows blank page | `VITE_API_URL` wrong or missing | Check Vercel env vars, redeploy |
| DB queries fail after deploy | Migration not run | Open Railway shell → `npm run db:migrate` |
| OTPs not sending | `MSG91_AUTH_KEY` wrong | Verify key in MSG91 dashboard |
| Android app can't reach API | `capacitor.config.ts` has wrong URL | Update server URL and rebuild |

---

## Key things to never forget

1. **Never commit `.env`** — it's gitignored, keep it that way
2. **JWT secrets must be different from dev** — dev secrets are in git history; generate fresh ones for production
3. **Run `db:migrate` after schema changes** — Drizzle doesn't auto-migrate in production
4. **Keep your Android keystore backed up** — losing it means you cannot update the app on Play Store, ever
5. **`NODE_ENV=production` must be set** — it enables the HTTPS redirect and rate limiting
6. **Update `ALLOWED_ORIGINS` when your frontend URL changes** — otherwise the web app breaks immediately
