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
