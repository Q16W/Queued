# Queued — backend setup (accounts + TMDB proxy)

This adds **accounts with cross-device sync** and a **shared TMDB key** so users never enter their own. Everything runs on Cloudflare's **free** tier — no extra cost beyond your domain.

You'll do this once, in about 20–30 minutes. Commands are copy-paste. Anything in `<ANGLE BRACKETS>` you replace.

---

## What you need
- The `deploy/` folder (this site, including `_worker.js` and `schema.sql`).
- A free [Cloudflare account](https://dash.cloudflare.com) (you have this).
- A free [TMDB account](https://www.themoviedb.org/settings/api) → an **API Key (v3 auth)**.
- A free [Google Cloud](https://console.cloud.google.com) project for Google sign-in.
- **Node.js** installed (https://nodejs.org → "LTS"). This gives you the `npx` command used below.

---

## 1. Install Wrangler (Cloudflare's CLI)
Open a terminal (Mac: Terminal app · Windows: PowerShell) and run:
```bash
npm install -g wrangler
wrangler login
```
A browser opens — approve access. Done.

## 2. Create the database (D1)
```bash
wrangler d1 create queued
```
It prints a block like:
```
[[d1_databases]]
binding = "DB"
database_name = "queued"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```
**Copy the `database_id`** — you'll paste it in the dashboard in step 6.

## 3. Create the tables
Run the schema against the database you just made:
```bash
wrangler d1 execute queued --remote --file=deploy/schema.sql
```
You should see it apply a few statements with no errors.

## 4. Get your TMDB key
1. Go to https://www.themoviedb.org/settings/api → request an **API Key (v3 auth)** (instant, free).
2. Copy the key (a long string).

## 5. Set up Google sign-in
1. Go to https://console.cloud.google.com → create a project (any name).
2. **APIs & Services → OAuth consent screen** → choose **External** → fill in app name "Queued", your email → Save. (You can leave it in "Testing" mode; add your family's Google emails as test users, or click **Publish** to allow anyone.)
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**
   - **Authorized JavaScript origins**: add `https://queued.tv` and `https://www.queued.tv` (and `https://<your-project>.pages.dev` while testing).
   - Create. **Copy the "Client ID"** (ends in `.apps.googleusercontent.com`).

## 6. Create the Pages project & add bindings
If you haven't deployed the site yet, the quickest path:
```bash
wrangler pages deploy deploy --project-name queued
```
This uploads the site **and** the `_worker.js` backend, and gives you a `queued.pages.dev` URL.

Now open the **Cloudflare dashboard → Workers & Pages → queued → Settings**:

**a) Bind the database** — *Settings → Functions → D1 database bindings → Add binding*
- Variable name: `DB`
- D1 database: **queued**

**b) Add secrets & variables** — *Settings → Environment variables → Production* (use **Encrypt** for the two secrets):
| Name | Value | Encrypt? |
|------|-------|----------|
| `TMDB_KEY` | your TMDB v3 key | ✅ yes |
| `SESSION_SECRET` | a long random string (see below) | ✅ yes |
| `GOOGLE_CLIENT_ID` | your `...apps.googleusercontent.com` ID | no |

Generate a random `SESSION_SECRET`:
```bash
openssl rand -base64 48
```
(or just mash 50+ random characters — it only needs to be long and secret.)

**c) Redeploy so the bindings take effect:**
```bash
wrangler pages deploy deploy --project-name queued
```

## 7. Point queued.tv at it
Dashboard → **queued → Custom domains → Set up a custom domain** → `queued.tv` (and `www.queued.tv`). Cloudflare adds the DNS automatically if the domain is on your account. SSL is automatic.

---

## ✅ Test it
On `https://queued.tv`:
1. **Movies/TV search & browse work with no key entered** (the proxy is serving them).
2. Profile → ⚙ → **Create account** → you're signed in, and a green "synced" dot appears.
3. Add a few titles, open the site on your phone, sign in → your library is there.
4. **Continue with Google** works.

## Updating the app later
Re-copy the latest `Rankit.dc.html` → `deploy/index.html` and `support.js` → `deploy/support.js`, then:
```bash
wrangler pages deploy deploy --project-name queued
```

---

## Costs (all free tier — typical family use won't get close)
- **Pages**: unlimited static requests; 100,000 Functions requests/day.
- **D1**: 5 GB storage; 5M row reads/day; 100k writes/day.
- **TMDB / AniList / Google**: free.

## Notes & limits
- **Sync model** is last-write-wins on a whole-library snapshot. If the same account edits on two devices at once, the most recent save wins. Fine for personal use; a field-level merge would be a later upgrade.
- **TMDB terms** allow this for a free, non-commercial app at low volume. If Queued ever grows or monetizes, revisit TMDB's API terms.
- **Auth** here is solid for v1 (PBKDF2-hashed passwords, signed http-only session cookies, Google ID-token verification). Before opening it to the public at scale, consider adding password-reset and rate-limiting.
