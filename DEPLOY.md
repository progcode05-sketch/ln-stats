# Deploying LinkedIn Stats (SaaS) to Render

## How it works

1. User clicks **Connect with LinkedIn** → LinkedIn OAuth (OpenID Connect) signs them in.
2. User enters their LinkedIn email + password once → stored **AES-256-GCM encrypted**.
3. Server runs a **headless, invisible** Chromium that signs in as the user and scrapes
   post stats. Progress streams to the browser live via Server-Sent Events.
4. Each run is saved as a **snapshot**, so users see week-over-week growth.

The server is **Express** + **node:sqlite** (built-in, no native build) + **Puppeteer**.

---

## 1. Configure your LinkedIn app

In <https://www.linkedin.com/developers/apps>:

- **Products** → add **"Sign In with LinkedIn using OpenID Connect"**
  (grants the `openid`, `profile`, `email` scopes).
- **Auth** → add these **Authorized redirect URLs**:
  - `http://localhost:4173/auth/linkedin/callback`  (local dev)
  - `https://ln-stats.onrender.com/auth/linkedin/callback`  (production)
- Copy your **Client ID** and **Client Secret**.

> ⚠️ Your client secret was shared in chat earlier — **regenerate it** in the Auth tab
> and use the new value. Never commit it.

## 2. Generate secrets

```bash
node -e "console.log('ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('base64'))"
node -e "console.log('SESSION_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
```

## 3. Run locally

```bash
cp .env.example .env   # then fill in the values
npm install
npm run dev            # http://localhost:4173
```

## 4. Deploy to Render

1. Push this repo to GitHub.
2. Render → **New → Blueprint**, point it at the repo (it reads `render.yaml`),
   or **New → Web Service** with **Runtime: Docker**.
3. In the service's **Environment** tab, set the secret values
   (these are `sync: false` in `render.yaml`, so Render won't auto-fill them):
   - `LINKEDIN_CLIENT_ID`
   - `LINKEDIN_CLIENT_SECRET`  (the **regenerated** one)
   - `ENCRYPTION_KEY`
   - `SESSION_SECRET`
4. Confirm `BASE_URL` matches your real Render URL. If your service isn't literally
   `ln-stats.onrender.com`, update both `BASE_URL` and the LinkedIn redirect URL.
5. Deploy. Render's health check hits `/health`.

## 5. Keep-alive (cron-job.org)

- URL: `https://ln-stats.onrender.com/health`
- Method: **GET**
- Interval: **every 13 minutes**

`/health` returns a fast `200 ok`, which keeps the free instance from sleeping.

---

## ⚠️ Important limitations (read these)

- **Data persistence on Render free is ephemeral.** The SQLite file lives on the
  container's disk, which is wiped on every redeploy or platform restart. The
  keep-alive ping prevents idle sleep, but a deploy still resets all snapshots.
  For durable week-over-week history, either:
  - add a Render **persistent disk** (paid) mounted at `/app/data`, or
  - migrate the DB layer in `src/db.ts` to **Postgres** (Render offers a free Postgres).
- **Memory.** Free instances have 512 MB RAM; headless Chromium is heavy and may
  OOM on large profiles. If collections crash with no clear error, upgrade the
  instance size.
- **LinkedIn security checks.** On a first login or a login from a new location,
  LinkedIn may demand a CAPTCHA / verification code, which can't be solved
  automatically from the server. The app surfaces this as a clear error and the
  user can retry later. Scraping LinkedIn while authenticated is also against
  LinkedIn's User Agreement — understand that risk before going public.
