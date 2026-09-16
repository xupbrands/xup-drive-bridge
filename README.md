# XUP Drive Bridge

A tiny backend that lets the **XUP Brands Image Sorter** Figma plugin export directly
into a Google Drive folder. The Figma plugin itself has no safe place to hold a
Google OAuth client secret or long-lived Drive tokens, so this service holds them
instead — the plugin only ever talks to this service, never to Google directly.

## 1. Create a Google Cloud OAuth Client

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and create a project
   (or use an existing one).
2. **APIs & Services > Library** — enable the **Google Drive API**.
3. **APIs & Services > OAuth consent screen** — set it up (Internal if you're on a
   Google Workspace domain and only your team will use this; External + "Testing"
   mode otherwise, adding your team's Google accounts as test users so you don't
   need to go through Google's verification review).
4. **APIs & Services > Credentials > Create Credentials > OAuth client ID**
   - Application type: **Web application**
   - Authorized redirect URIs: add `https://YOUR-RAILWAY-URL/auth/callback`
     (you'll get the exact Railway URL in step 2 below — come back and add this
     after deploying, then redeploy isn't needed, just save the credential).
5. Copy the **Client ID** and **Client Secret** — you'll need them in step 3.

## 2. Deploy to Railway

1. Push this `railway-server/` folder to its own GitHub repo (or a subfolder of
   one), then in [Railway](https://railway.app): **New Project > Deploy from GitHub repo**.
2. Once deployed, Railway gives you a public URL like
   `https://xup-drive-bridge-production.up.railway.app` — copy it.
3. Go back to Google Cloud Console (step 1.4) and add
   `<that URL>/auth/callback` as an authorized redirect URI.

## 3. Set environment variables in Railway

In the Railway project's **Variables** tab, add (see `.env.example`):

| Variable | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | From step 1 |
| `GOOGLE_CLIENT_SECRET` | From step 1 |
| `PUBLIC_URL` | The exact Railway URL from step 2 (no trailing slash) |

Redeploy after setting these so the service picks them up.

## 4. Connect it in the Figma plugin

Full click-by-click deployment steps live in [DEPLOY.md](DEPLOY.md).

In the plugin's **Export** tab, under **Google Drive**:
1. Paste your Railway URL (e.g. `https://xup-drive-bridge-production.up.railway.app`)
   into **Backend URL**.
2. Click **Connect Google Drive** — a popup opens for Google sign-in, then closes
   itself automatically.
3. Paste the target Drive folder's share link into **Folder link**.
4. Select what you want to export as usual, then click **Export to Drive** instead
   of (or in addition to) **Export as ZIP**.

You'll also need to add your Railway URL to the plugin's `manifest.json` under
`networkAccess.allowedDomains` before the plugin is allowed to call it — see the
comment left there.

## 5. Access is locked to our Google Workspace

The plugin is for XUP Brands staff only, enforced in two independent places:

1. **Google Cloud OAuth consent screen set to "Internal"** — Google refuses
   sign-in for anyone outside the Workspace before they ever reach us.
2. **`ALLOWED_GOOGLE_DOMAIN` checked server-side** — after the code exchange we
   read the `hd` (hosted domain) claim out of Google's ID token and refuse to
   create a session unless it matches. `hd` is used in preference to the email
   suffix, so an address like `evil@xupbrands.com.attacker.io` is rejected.

Every endpoint that costs money or touches data (`/api/niche/*`, `/api/image`,
`/api/upload`) sits behind `requireOrgMember`. A request with no session, or one
whose account was refused, gets a 401 — so nobody outside the org can burn
Data Dive or Scrape.do credits even if they know the URL.

Set `ALLOWED_GOOGLE_DOMAIN` to your Workspace domain (comma-separate for more
than one). If it is unset the service logs a warning and refuses every sign-in
rather than defaulting to open.

Sign-in happens once and covers both Drive export and competitor research.

## 6. Competitor research (Data Dive + Scrape.do)

The **Image Import** tab can pull a niche's shortlisted competitor ASINs straight
from Data Dive and import their creative into Figma.

Add two more variables in Railway:

| Variable | Value |
|---|---|
| `DATADIVE_API_KEY` | Create one at <https://2.datadive.tools/api-key> (Standard or Enterprise plan — the $39 Starter plan has no API access) |
| `SCRAPEDO_API_KEY` | From your <https://scrape.do/> dashboard |

Then in the plugin:

1. **Sign in with Google** using your work account.
2. Paste a Data Dive niche link and click **Fetch competitors**. (A niche name
   works too — it falls back to searching your niches by label.)
3. Every ASIN comes back ticked; untick any you don't want.
4. Tick what to download from each competitor:
   - Listing images
   - A+ Premium desktop
   - A+ Premium mobile
   - Brand story
5. **Collect & import** — the images are scraped, downloaded and built into
   frames on the canvas in one go. No second click.

Each ASIN gets one frame per ticked item, named
`B0AAA11111 Acme - A+ Premium (Desktop)`, using the size, gap, padding and
alignment settings from the top of the Import tab. From there they are ordinary
frames — export them as ZIP or to Drive like anything else.

### How it works

- `POST /api/niche/competitors` — resolves the link to a niche id and calls Data
  Dive's `GET /v1/niches/{nicheId}/competitors`. That endpoint returns the
  niche's competitor set, which is already the shortlist the niche was dived
  with, so no extra ranking or filtering happens server-side.
- `POST /api/niche/assets` — fetches each ASIN's Amazon detail page through
  Scrape.do and pulls out the hi-res gallery (`colorImages`), the A+ / Premium A+
  modules, and Brand Story images (both served from the `aplus-media` CDN path).
- `GET /api/image` — proxies the image bytes. Figma plugins may only call domains
  listed in `manifest.json`, and Amazon's CDN isn't one, so the bytes come back
  through this service. The proxy is locked to Amazon image hosts over HTTPS so
  it can't be used as an open relay.

### Cost and rate notes

- **Desktop and mobile A+ are different Amazon pages.** Ticking both means two
  Scrape.do requests per ASIN instead of one. Listing images, desktop A+ and
  Brand Story all come off the same desktop page, so ticking all three still
  costs one request. The plugin shows the estimated scrape count before you
  commit.
- If a pass comes back with no images (bot check, or A+ injected client-side) it
  retries **once** with `render=true&super=true`, which costs more credits.
- Three ASINs are scraped at a time, and a batch is capped at **30 ASINs** so one
  stray click can't burn hundreds of credits.
- A failing ASIN is reported on its own and never fails the rest of the batch.

## Notes / limitations

- Sessions are stored in memory, so every time this service restarts or redeploys,
  designers will need to click "Connect Google Drive" again. Fine for casual daily
  use; if it becomes annoying, swap the in-memory `Map` in `server.js` for a real
  store (Railway can add a Postgres or Redis plugin in a couple of clicks).
- The OAuth scope used is `drive.file` (the least-privilege option) — it can create
  files in any folder you point it at, but can't browse/read files it didn't create.
- Drive doesn't have a concept of nested folders created purely from a filename, so
  files whose export name includes a `/` (mirroring the frame hierarchy, e.g.
  `A+ Premium/A+ Premium (Mobile)/Module 1.png`) get flattened to
  `A+ Premium - A+ Premium (Mobile) - Module 1.png` instead of nested subfolders.
