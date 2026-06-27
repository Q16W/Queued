# Queued — deploy to Cloudflare Pages (queued.tv)

This folder is the production site. It's a static site — no build step, no server.

```
deploy/
├── index.html      ← the app
├── support.js      ← runtime (loaded by index.html)
├── manifest.json   ← PWA manifest (installable / "Add to Home Screen")
├── icon-192.png    ← app icons
├── icon-512.png
├── icon-180.png    ← iOS home-screen icon
└── _headers        ← Cloudflare cache + security headers
```

## Option A — drag & drop (fastest)
1. Go to **Cloudflare dashboard → Workers & Pages → Create → Pages → Upload assets**.
2. Name the project `queued`.
3. Drag the **contents of this `deploy/` folder** (not the folder itself) into the uploader.
4. Deploy. You'll get a `queued.pages.dev` URL — confirm it loads.

## Option B — connect a Git repo (auto-deploy on push)
1. Push the repo to GitHub/GitLab.
2. Cloudflare Pages → **Connect to Git** → pick the repo.
3. Build command: *(leave empty)*. Build output directory: `deploy`.
4. Every push to the main branch redeploys.

## Point queued.tv at it
1. In the Pages project → **Custom domains → Set up a custom domain** → enter `queued.tv` (and add `www.queued.tv` if you want it).
2. If your domain's DNS is already on Cloudflare, the records are added automatically.
   - Otherwise add a **CNAME** `queued.tv → queued.pages.dev` (Cloudflare's UI walks you through the apex/CNAME-flattening).
3. SSL is automatic. Give it a few minutes for the cert.

## Updating the site
Re-copy the latest `Rankit.dc.html` to `deploy/index.html` and `support.js` to `deploy/support.js`, then re-upload (Option A) or push (Option B). The `_headers` file makes `index.html` revalidate so users get updates immediately while icons stay cached.

## Notes
- Fonts (Google Fonts) and icons (Tabler) load from their CDNs — the app needs a network connection. That's fine for a normal web app; a fully-offline PWA would need a service worker (a later step).
- All user data lives in the browser's localStorage on each device. There is no backend yet, so data does not sync between devices unless the user signs in with AniList.
