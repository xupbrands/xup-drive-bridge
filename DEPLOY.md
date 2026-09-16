# Deploying the XUP Drive Bridge

Follow these in order. Steps 1–3 are one-time; step 7 is the only one you repeat
when you change the code.

You need: a Google Workspace admin (or someone who can create OAuth clients in
your Google Cloud org), a Railway account, and your Data Dive + Scrape.do keys.

---

## 1. Create the Google OAuth client

1. Open <https://console.cloud.google.com/> and pick (or create) a project.
2. **APIs & Services → Library** → search **Google Drive API** → **Enable**.
3. **APIs & Services → OAuth consent screen**:
   - User type: **Internal**. This is the first half of the org lock — with
     Internal, Google itself refuses sign-in from anyone outside your Workspace,
     so nobody outside XUP Brands can even reach the consent screen.
   - App name: `XUP Brands Image Sorter`. Support email: your work address.
   - Scopes: you can leave the scope list empty here; the app requests
     `openid`, `email` and `drive.file` at run time.
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Web application**
   - Name: `XUP Image Sorter Bridge`
   - Leave **Authorized redirect URIs** empty for now — you add it in step 4,
     once Railway has given you a URL.
5. Copy the **Client ID** and **Client Secret** somewhere safe. You'll paste
   them into Railway in step 3.

> If **Internal** is greyed out, the Google Cloud project sits outside your
> Workspace organisation. Ask your Workspace admin to move it, or create the
> project from an account on the `xupbrands.com` domain. Don't work around it
> with **External** — that would let any Google account reach sign-in, and only
> the server-side domain check would be stopping them.

---

## 2. Deploy to Railway

Push this `railway-server/` folder to a GitHub repo first (it can be a
subdirectory of a larger repo).

**Via the dashboard:**

1. <https://railway.app> → **New Project** → **Deploy from GitHub repo**.
2. Pick the repo. If `railway-server/` is a subfolder, open
   **Settings → Root Directory** and set it to `railway-server`.
3. Railway detects Node and runs `npm start` on its own.
4. **Settings → Networking → Generate Domain**. Copy the URL it gives you, e.g.
   `https://xup-drive-bridge-production.up.railway.app`.

**Or via the CLI:**

```bash
npm i -g @railway/cli && railway login && railway init && railway up
```

---

## 3. Set the environment variables

**Variables** tab → **Raw Editor** → paste this, filling in your own values:

```bash
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
PUBLIC_URL=https://your-app.up.railway.app
ALLOWED_GOOGLE_DOMAIN=xupbrands.com
DATADIVE_API_KEY=your-datadive-key
SCRAPEDO_API_KEY=your-scrapedo-key
```

Notes:

- `PUBLIC_URL` must be the exact Railway URL with **no trailing slash**. It is
  what the OAuth `redirect_uri` is built from, and Google compares it character
  for character.
- `ALLOWED_GOOGLE_DOMAIN` is the second half of the org lock: every request that
  costs money or touches data is refused unless it carries a session belonging
  to this domain. Comma-separate if you have more than one (`a.com,b.com`).
- Get the Data Dive key at <https://2.datadive.tools/api-key> — this needs a
  **Standard or Enterprise** plan; the $39 Starter plan has no API access.

---

## 4. Register the redirect URI

Back in **Google Cloud Console → Credentials → your OAuth client → Authorized
redirect URIs → Add URI**:

```
https://your-app.up.railway.app/auth/callback
```

Save. No redeploy needed — Google picks this up immediately.

---

## 5. Point the plugin at it

In Figma, open the plugin → **Export** tab → **Backend URL**, and paste your
Railway URL. It's saved with your other plugin settings, so this is a one-time
step per designer.

If the URL differs from the default baked into `manifest.json`, update it there
too and re-import the plugin:

```json
"networkAccess": { "allowedDomains": ["https://your-app.up.railway.app"] }
```

---

## 6. Verify it works

```bash
curl https://your-app.up.railway.app/
```

Expect `XUP Drive Bridge is running.`

Then confirm the lock is actually on — this must return `401`:

```bash
curl -i -X POST https://your-app.up.railway.app/api/niche/competitors -H "Content-Type: application/json" -d "{\"link\":\"test\"}"
```

Finally, in the plugin: **Image Import → Competitor research → Sign in with
Google**. A popup opens, you pick your `@xupbrands.com` account, and the section
expands showing your email. Paste a niche link, hit **Fetch competitors**, tick
what you want, and **Collect & import**.

To prove the org lock end to end, try signing in with a personal Gmail account —
the popup should say it isn't in `xupbrands.com`, and no session is created.

---

## 7. Redeploying after a code change

Push to the connected branch and Railway rebuilds automatically, or run
`railway up` from `railway-server/`.

Sessions are held in memory, so **every deploy signs everyone out**. They just
click **Sign in with Google** again. If that becomes annoying, swap the
`sessions` Map in `server.js` for a Railway Redis add-on.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `redirect_uri_mismatch` on sign-in | `PUBLIC_URL` and the registered redirect URI don't match exactly — check for a trailing slash or `http` vs `https`. |
| "is not in xupbrands.com" for a real employee | Their Google session defaulted to a personal account. Sign out at <https://accounts.google.com> or use the account picker. |
| Everyone signed out after a deploy | Expected — sessions are in memory. See step 7. |
| "Data Dive rejected the API key (403)" | Key is wrong, or the plan doesn't include API access. |
| "Sign in with your work Google account" mid-session | The service restarted. Sign in again. |
| Scrape returns no A+ images | That listing may genuinely have none. The server already retries once with a rendered request before giving up. |
