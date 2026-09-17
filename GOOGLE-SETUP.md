# Google Cloud setup — XUP Amazon Creative Kit

Everything needed on the Google side so the plugin's **Sign in with Google**
works and is locked to `@xupbrands.com`.

**Do this signed in as `muhammad@xupbrands.com`** (or another `xupbrands.com`
Workspace account). The **Internal** option in Step 3 only appears for Workspace
accounts — a personal Gmail will not show it.

**Time:** ~10 minutes. **Result:** a Client ID and Client secret to paste into Railway.

---

## Values you'll need

| Thing | Value |
|---|---|
| Plugin name | `XUP Amazon Creative Kit` |
| Railway URL | `https://xup-drive-bridge-production-b9ac.up.railway.app` |
| Redirect URI | `https://xup-drive-bridge-production-b9ac.up.railway.app/auth/callback` |

> If Railway reissues the domain, every instance of that URL below changes with
> it — see **Part 6**.

---

## A note on the two console layouts

Google moved these screens in 2025. You'll see one of:

- **Newer:** a left-hand **Google Auth Platform** section containing *Overview,
  Branding, Audience, Clients, Data Access*
- **Older:** **APIs & Services → OAuth consent screen** and **→ Credentials**

Both are covered at each step.

---

## Part 1 — Project

1. Go to <https://console.cloud.google.com/>
2. Top bar → project dropdown → pick the existing XUP project, or **New Project**
   - Name: `XUP Amazon Creative Kit`
   - **Organisation / Location: `xupbrands.com`** ← important. A project created
     outside the organisation cannot use **Internal** in Part 3.
3. Make sure the project is selected before continuing — the dropdown should
   show its name.

---

## Part 2 — Enable the Drive API

**APIs & Services → Library** → search `Google Drive API` → **Enable**.

This is needed for the Export to Drive feature. Sign-in alone doesn't require it,
but enable it now so you don't have to come back.

---

## Part 3 — Consent screen and audience

This is **half of the org lock**: set to Internal, Google itself refuses anyone
outside `xupbrands.com` before the request ever reaches our server.

**Newer UI**
1. **Google Auth Platform → Branding**
   - App name: `XUP Amazon Creative Kit`
   - User support email: your work address
   - Developer contact email: your work address
   - **Save**
2. **Google Auth Platform → Audience**
   - User type: **Internal** → **Save**

**Older UI**
1. **APIs & Services → OAuth consent screen**
2. User type: **Internal** → **Create**
3. App name `XUP Amazon Creative Kit`, support email, developer contact → **Save
   and Continue**
4. Scopes page: **leave empty** and continue — the app requests its scopes at run
   time, they don't need declaring here.

> **"Internal" greyed out or missing?** The project sits outside the
> `xupbrands.com` organisation. Move it (or recreate it inside the org) rather
> than choosing **External**. External lets any Google account reach the consent
> screen, leaving only our server-side domain check between outsiders and your
> paid Data Dive / Scrape.do credits.

Internal apps need **no Google verification review**, so there's nothing to
submit and no waiting.

---

## Part 4 — Create the OAuth client

This is where the Client ID and secret come from.

1. **Newer UI:** **Google Auth Platform → Clients → + Create client**
   **Older UI:** **APIs & Services → Credentials → + Create Credentials → OAuth client ID**
2. **Application type:** `Web application`
3. **Name:** `XUP Amazon Creative Kit Bridge` (internal label only)
4. **Authorized JavaScript origins:** leave empty — the plugin never calls Google
   directly from the browser.
5. **Authorized redirect URIs → + Add URI:**

```
https://xup-drive-bridge-production-b9ac.up.railway.app/auth/callback
```

6. **Create**

A dialog shows:

- **Client ID** — ends `.apps.googleusercontent.com`
- **Client secret** — usually starts `GOCSPX-`

Click **Download JSON** as a backup while it's open.

> The secret is only fully displayed at creation. If you lose it, don't rebuild
> the client — open it and **Add secret** (newer UI) or reset it, then update
> Railway.

---

## Part 5 — Put them in Railway

Railway project → **Variables → Raw Editor**:

```bash
GOOGLE_CLIENT_ID=your-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-your-secret
PUBLIC_URL=https://xup-drive-bridge-production-b9ac.up.railway.app
ALLOWED_GOOGLE_DOMAIN=xupbrands.com
DATADIVE_API_KEY=your-datadive-key
SCRAPEDO_API_KEY=your-scrapedo-key
PORT=8080
```

Redeploy so the service picks them up.

**`PUBLIC_URL` must match the redirect URI from Part 4 exactly** — same scheme,
same host, **no trailing slash**. The server builds its `redirect_uri` from this
value and Google compares it character for character. A mismatch here is the
single most common cause of sign-in failing.

`ALLOWED_GOOGLE_DOMAIN` is the **other half of the org lock**. If it's unset the
service refuses every sign-in rather than defaulting to open, so don't skip it.

---

## Part 6 — If the Railway domain changes

Railway has already reissued this domain twice. When it changes, the URL must be
updated in **three** places or sign-in breaks:

1. **Railway** → `PUBLIC_URL`
2. **Google Cloud** → the OAuth client's Authorized redirect URI (Part 4)
3. **The plugin** → Export tab **Backend URL**, and `manifest.json`:

```json
"networkAccess": { "allowedDomains": ["https://YOUR-URL.up.railway.app"] }
```

Re-import the plugin in Figma after editing `manifest.json`.

---

## Part 7 — Verify

**1. Service is up:**

```powershell
curl.exe -s https://xup-drive-bridge-production-b9ac.up.railway.app/
```

Expect `XUP Drive Bridge is running.`

**2. The lock is on:**

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" -X POST https://xup-drive-bridge-production-b9ac.up.railway.app/api/niche/competitors -H "Content-Type: application/json" -d "{\"link\":\"test\"}"
```

Expect `401`. **That 401 means it's working** — the endpoint exists and is
refusing unauthenticated callers. A `404` means Railway is still serving old
code.

**3. Sign-in works:** in Figma → **Image Import → Competitor research → Sign in
with Google** → pick your `@xupbrands.com` account. The popup closes itself and
the section expands showing your email.

**4. The lock actually locks:** try a personal Gmail account. The popup should
say it isn't in `xupbrands.com`, and no session is created.

---

## What the plugin asks for, and why

| Scope | Why |
|---|---|
| `openid`, `email` | Read the signed-in identity and its `hd` (hosted domain) claim — this is what the domain check reads. |
| `drive.file` | Least-privilege Drive scope. Lets the service create files in a folder you point it at; it **cannot** browse or read anything it didn't create. |

The plugin never sees the client secret or any Google token — only an opaque
session id. All Google calls happen server-side.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `redirect_uri_mismatch` | `PUBLIC_URL` ≠ registered redirect URI. Check trailing slash, `http` vs `https`, and that the domain suffix matches. |
| `Access blocked: This app is blocked` | Consent screen is Internal but the account isn't in the Workspace. Sign in with the work account. |
| "Internal" unavailable | Project is outside the `xupbrands.com` organisation — see Part 3. |
| "is not in xupbrands.com" for a real employee | Browser defaulted to a personal Google account. Sign out at <https://accounts.google.com> or use the account picker. |
| `client_id=undefined` in the popup URL | Railway variables aren't set. See Part 5. |
| Popup opens then 404s | Backend isn't deployed, or Backend URL in the plugin is wrong. |
| Everyone signed out after a deploy | Expected — sessions are held in memory. They sign in again. |
| Endpoints return `404` instead of `401` | Railway is running an old build. Redeploy from `master`. |

---

## Checklist

- [ ] Project exists **inside the `xupbrands.com` organisation**
- [ ] Google Drive API enabled
- [ ] Consent screen app name = `XUP Amazon Creative Kit`
- [ ] Audience / user type = **Internal**
- [ ] OAuth client created, type **Web application**
- [ ] Redirect URI = `<Railway URL>/auth/callback`
- [ ] Client ID + secret pasted into Railway
- [ ] All seven Railway variables set, `PUBLIC_URL` matching exactly
- [ ] Redeployed
- [ ] `/` returns the running message
- [ ] `/api/niche/competitors` returns **401**
- [ ] Sign-in works with a work account
- [ ] Sign-in is refused for a personal account
