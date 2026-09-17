# Deploying the XUP Drive Bridge

Runbook for the backend behind the **XUP Brands · Image Sorter** Figma plugin.
Written for Windows PowerShell; commands are PowerShell-safe.

- **Repo:** <https://github.com/xupbrands/xup-drive-bridge>
- **Host:** Railway
- **Local path:** `D:\Figma Plugins\xup-brands-image-sorter - backup\railway-server`

> The repo's root **is** the server, so Railway needs no Root Directory setting.
> The `railway-server/` folder is its own git repo, separate from the plugin folder
> that contains `code.js` / `ui.html` / `manifest.json`.

---

## What this service does and why it exists

A Figma plugin UI is a sandboxed iframe with no public URL and nowhere safe to
keep a secret. This service holds the credentials and does the privileged work:

| Endpoint | Purpose |
|---|---|
| `/auth/start`, `/auth/callback` | Google OAuth. Only `@xupbrands.com` accounts get a session. |
| `/api/status` | Tells the plugin whether a stored session is still valid. |
| `/api/niche/competitors` | Data Dive → the niche's shortlisted competitor ASINs. |
| `/api/niche/assets` | Scrape.do → each ASIN's listing / A+ / Brand Story image URLs. |
| `/api/image` | Proxies Amazon image bytes (Figma may only call allowlisted domains). |
| `/api/upload` | Uploads exported PNG/JPGs to Google Drive. |

Everything except `/` and the OAuth routes requires a signed-in org session.

---

## Prerequisites

- Access to the Google Cloud project on the `xupbrands.com` Workspace
- A Railway account with access to the XUP workspace
- Data Dive API key — <https://2.datadive.tools/api-key>
  (**Standard or Enterprise plan required**; the $39 Starter plan has no API access)
- Scrape.do API key — <https://scrape.do/>

---

## Part 1 — Google Cloud OAuth client

Only needed once. Skip if the OAuth client already exists.

1. <https://console.cloud.google.com/> → select (or create) the project.
2. **APIs & Services → Library** → **Google Drive API** → **Enable**.
3. **APIs & Services → OAuth consent screen**
   - User type: **Internal** ← half the org lock lives here
   - App name: `XUP Brands Image Sorter`, support email: your work address
   - Scopes can be left empty; the app requests `openid`, `email` and
     `drive.file` at run time.
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
   - Application type: **Web application**
   - Name: `XUP Image Sorter Bridge`
   - Leave **Authorized redirect URIs** empty for now — Part 4 fills it in once
     Railway has issued a URL.
5. Copy the **Client ID** and **Client Secret**.

> **If "Internal" is greyed out**, the Cloud project sits outside the Workspace
> organisation. Have it moved, or create the project from an account on the
> `xupbrands.com` domain. Do **not** fall back to **External** — that lets any
> Google account reach the consent screen, leaving only the server-side domain
> check between outsiders and your paid API credits.

---

## Part 2 — Create the Railway service

1. <https://railway.app> → **New Project** → **Deploy from GitHub repo**
2. Select **`xupbrands/xup-drive-bridge`**
3. Leave **Root Directory** empty — the repo root is the server
4. Railway detects Node and runs `npm start` automatically
5. **Settings → Networking → Generate Domain**, then copy the URL
   (e.g. `https://xup-drive-bridge-production.up.railway.app`)

CLI alternative, run from this folder:

```powershell
npm i -g @railway/cli
```

```powershell
railway login
```

```powershell
railway up
```

---

## Part 3 — Environment variables

**Variables → Raw Editor**, paste all six:

```bash
GOOGLE_CLIENT_ID=your-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-secret
PUBLIC_URL=https://your-app.up.railway.app
ALLOWED_GOOGLE_DOMAIN=xupbrands.com
DATADIVE_API_KEY=your-datadive-key
SCRAPEDO_API_KEY=your-scrapedo-key
```

| Variable | Notes |
|---|---|
| `PUBLIC_URL` | **Exact** Railway URL. No trailing slash, `https` not `http`. The OAuth `redirect_uri` is built from this and Google compares it character for character. |
| `ALLOWED_GOOGLE_DOMAIN` | The other half of the org lock. Comma-separate for multiple domains. If unset, the service logs a warning and **refuses every sign-in** rather than defaulting to open. |
| `DATADIVE_API_KEY` | Returns 403 on Starter plans regardless of deployment. |

Redeploy after saving so the service picks them up.

---

## Part 4 — Register the redirect URI

**Google Cloud Console → Credentials → your OAuth client → Authorized redirect
URIs → Add URI:**

```
https://your-app.up.railway.app/auth/callback
```

Save. No redeploy needed — Google applies this immediately.

---

## Part 5 — Point the plugin at the service

1. In Figma: plugin → **Export** tab → **Backend URL** → paste the Railway URL.
   It's saved with the other plugin settings, so this is once per designer.
2. If the domain changed, update `manifest.json` in the **plugin** folder and
   re-import the plugin:

```json
"networkAccess": { "allowedDomains": ["https://your-app.up.railway.app"] }
```

---

## Part 6 — Verify

```powershell
curl.exe -s https://your-app.up.railway.app/
```

Expect: `XUP Drive Bridge is running.`

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" -X POST https://your-app.up.railway.app/api/niche/competitors -H "Content-Type: application/json" -d "{\"link\":\"test\"}"
```

Expect: `401`. **That 401 is the org lock working, not a failure.**

Then in the plugin: **Image Import → Competitor research → Sign in with Google**.
A popup opens, you pick your `@xupbrands.com` account, and the section expands
showing your email.

To confirm the lock end to end, try a personal Gmail account — the popup should
say it isn't in `xupbrands.com`, and no session is created.

---

## Updating the code later

From `railway-server/`:

```powershell
git add -A
```

```powershell
git commit -m "Describe the change"
```

```powershell
git push
```

Railway rebuilds automatically on push to `master`.

> **PowerShell 5.1 has no `&&`.** Chaining with `&&` gives
> *"The token '&&' is not a valid statement separator in this version."*
> Run commands one per line, or use `;`. PowerShell 7 supports `&&`.

**Sessions are in memory, so every deploy signs everyone out.** They just click
**Sign in with Google** again. To avoid that, swap the `sessions` Map in
`server.js` for a Railway Redis add-on.

### Dependency alerts

If GitHub reports vulnerabilities:

```powershell
npm audit fix
```

```powershell
git commit -am "Bump dependencies via npm audit fix"
```

```powershell
git push
```

The banner GitHub prints during `git push` is generated *before* Dependabot
rescans, so it can still show the old count on the very push that fixes it.
Check <https://github.com/xupbrands/xup-drive-bridge/security/dependabot> a few
minutes later.

---

## Recovery: "Application not found"

If the Railway URL returns:

```json
{"status":"error","code":404,"message":"Application not found"}
```

…the service is gone or has lost its public domain. This has happened before.

1. Open <https://railway.app> and look for the `xup-drive-bridge` project.
2. **Project exists** → **Settings → Networking** → **Generate Domain** if there
   isn't one. Confirm all six variables are still set.
3. **Project gone** → redo Part 2, then Parts 3–5.

Either path can produce a **new URL**. When that happens it must be updated in
**three places** or sign-in will keep failing:

1. Railway → `PUBLIC_URL`
2. Google Cloud → Authorized redirect URI
3. The plugin → **Backend URL** (and `manifest.json` if the domain changed)

A stale `PUBLIC_URL` is the single most common cause of sign-in breaking after a
redeploy.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `redirect_uri_mismatch` | `PUBLIC_URL` and the registered redirect URI differ. Check trailing slash and `http` vs `https`. |
| `Application not found` | No service at that URL — see Recovery above. |
| "is not in xupbrands.com" for a real employee | Their browser defaulted to a personal Google account. Sign out at <https://accounts.google.com> or use the account picker. |
| Everyone signed out after a deploy | Expected — sessions are in memory. |
| "Sign in with your work Google account" mid-session | The service restarted. Sign in again. |
| `Data Dive rejected the API key (403)` | Wrong key, or the plan has no API access (Starter). |
| Sign-in popup opens then immediately 404s | Backend isn't deployed, or Backend URL in the plugin is wrong. |
| Scrape returns no A+ images | That listing may genuinely have none. The server already retries once with a rendered request before giving up. |
| Everything returns 401 | Expected when signed out. Sign in first; the session travels in the `x-xup-session` header. |

---

## Cost notes

- **Scrape.do bills per request.** One ASIN is normally one request. Desktop and
  mobile A+ are *different Amazon pages*, so ticking both costs two per ASIN.
  Listing images, desktop A+ and Brand Story all come from the same desktop page
  — ticking all three still costs one.
- A pass that returns nothing (bot check, or A+ injected client-side) retries
  **once** with `render=true&super=true`, which costs more credits.
- Batches are capped at **30 ASINs**, scraped 3 at a time.
- The plugin shows an estimated scrape count before you commit.

---

## Security model

Two independent locks, either of which would stop an outsider:

1. **OAuth consent screen set to Internal** — Google refuses non-Workspace
   accounts before the request ever reaches us.
2. **`ALLOWED_GOOGLE_DOMAIN` checked server-side** — after the code exchange the
   `hd` (hosted domain) claim is read from Google's ID token and no session is
   created unless it matches. `hd` is preferred over the email suffix, so an
   address like `evil@xupbrands.com.attacker.io` is rejected.

Every endpoint that costs money or touches data sits behind `requireOrgMember`.
The image proxy is additionally restricted to Amazon image hosts over HTTPS, so
it can't be used as an open relay or to reach internal addresses.

Secrets live **only** in Railway's Variables tab. `.gitignore` covers `.env`
files; never commit real keys.
