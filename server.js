// XUP Drive Bridge
//
// A minimal backend that lets the XUP Brands Image Sorter Figma plugin export
// generated assets directly into a Google Drive folder. Figma plugin UIs run in a
// sandboxed iframe with no public URL and no safe place to hold a Google OAuth
// client secret, so this small service exists to:
//
//   1. Run the Google OAuth "Authorization Code" flow (the plugin never sees the
//      client secret or the Drive access/refresh tokens — only a session id).
//   2. Perform the actual Drive API upload server-side using those tokens.
//
// Required environment variables (set these in Railway's dashboard):
//   GOOGLE_CLIENT_ID      - OAuth 2.0 Client ID from Google Cloud Console
//   GOOGLE_CLIENT_SECRET  - OAuth 2.0 Client Secret from Google Cloud Console
//   PUBLIC_URL            - This service's own public URL, e.g. https://xup-drive-bridge.up.railway.app
//                           (used to build the OAuth redirect_uri — must exactly match
//                           what's registered in Google Cloud Console)
//   ALLOWED_GOOGLE_DOMAIN - Workspace domain(s) allowed to use the plugin, e.g. "xupbrands.com"
//   DATADIVE_API_KEY      - Data Dive API key (see research.js)
//   SCRAPEDO_API_KEY      - Scrape.do API key (see research.js)
//
// Sign-in is required for everything except `/` and the OAuth routes themselves:
// only accounts in ALLOWED_GOOGLE_DOMAIN get a session, and every endpoint that
// costs money or touches data sits behind `requireOrgMember`.
//
// See README.md for full setup steps.

const express = require('express')
const cors = require('cors')
const crypto = require('crypto')
const { getNicheCompetitors, scrapeAsins } = require('./research')

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  PUBLIC_URL,
  ALLOWED_GOOGLE_DOMAIN,
  PORT = 3000,
} = process.env

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !PUBLIC_URL) {
  console.warn('WARNING: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and PUBLIC_URL must all be set as environment variables for OAuth to work.')
}

// Which Google Workspace domain(s) may use this service. Comma-separated, e.g.
// "xupbrands.com". This is the second of two locks: the OAuth consent screen
// should ALSO be set to "Internal" in Google Cloud Console, which stops anyone
// outside the Workspace from completing sign-in at all. This check is what makes
// the restriction enforceable here rather than trusting that setting alone.
const ALLOWED_DOMAINS = String(ALLOWED_GOOGLE_DOMAIN || '')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean)

if (ALLOWED_DOMAINS.length === 0) {
  console.warn('WARNING: ALLOWED_GOOGLE_DOMAIN is not set — every Google account that can complete sign-in would be accepted. Set it to your Workspace domain.')
}

const REDIRECT_URI = `${PUBLIC_URL}/auth/callback`
// `openid email` is what lets us read the signed-in identity (and its Workspace
// domain) back out of the ID token; drive.file is the least-privilege Drive scope.
const DRIVE_SCOPE = 'openid email https://www.googleapis.com/auth/drive.file'

// In-memory session store:
//   sessionId -> { accessToken, refreshToken, expiresAt, email, domain }
// NOTE: this resets on every server restart/redeploy, which just means the
// designer has to sign in again — acceptable for an internal tool. If that
// becomes annoying, swap this for a small persistent store (e.g. a
// Railway-provisioned Postgres/Redis add-on).
const sessions = new Map()

// Reads the payload out of a Google ID token. No signature check is needed: this
// token came back over TLS directly from Google's own token endpoint in response
// to our client_secret, so it cannot have been substituted in transit. (A token
// accepted from a *client* would have to be verified properly.)
function decodeIdToken(idToken) {
  const part = String(idToken || '').split('.')[1]
  if (!part) throw new Error('Google did not return an identity token')
  const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
  return JSON.parse(json)
}

// Throws unless the signed-in account really belongs to an allowed Workspace
// domain. `hd` is the authoritative hosted-domain claim; we fall back to the
// email suffix only when `hd` is absent, and require a verified email either way
// so an unverified consumer address can't spoof the domain.
function assertOrgMember(claims) {
  const email = String(claims.email || '').toLowerCase()
  const hd = String(claims.hd || '').toLowerCase()
  const emailDomain = email.split('@')[1] || ''
  const domain = hd || emailDomain

  if (!email) throw new Error('Google did not return an email address for this account')
  if (claims.email_verified === false) throw new Error('That Google account has an unverified email address')
  if (ALLOWED_DOMAINS.length === 0) throw new Error('This service has no ALLOWED_GOOGLE_DOMAIN configured — ask an admin to set it')
  if (!domain || !ALLOWED_DOMAINS.includes(domain)) {
    throw new Error(`${email} is not in ${ALLOWED_DOMAINS.join(' or ')} — sign in with your work account`)
  }
  return { email, domain }
}

// Gate for every endpoint that costs money or touches data. Reads the session id
// from a header so it never lands in a URL or a log line.
function requireOrgMember(req, res, next) {
  const sessionId = String(req.get('x-xup-session') || req.body?.sessionId || '')
  const session = sessions.get(sessionId)
  if (!session) {
    res.status(401).json({ error: 'Sign in with your work Google account to use this plugin' })
    return
  }
  if (!ALLOWED_DOMAINS.includes(session.domain)) {
    // Covers the case where the allowlist was tightened after a session was made.
    sessions.delete(sessionId)
    res.status(403).json({ error: 'Your account is no longer allowed to use this plugin' })
    return
  }
  req.xupSession = session
  next()
}

function newSessionId() {
  return crypto.randomBytes(24).toString('hex')
}

const app = express()
app.use(cors())
app.use(express.json({ limit: '100mb' }))

app.get('/', (req, res) => {
  res.send('XUP Drive Bridge is running.')
})

// Step 1: the plugin opens this in a popup window to kick off the Google login.
// The plugin picks its own sessionId up front (rather than waiting to be told one)
// because Google's sign-in pages send Cross-Origin-Opener-Policy: same-origin,
// which severs window.opener on the popup — so postMessage-ing the result back
// to the opener is not reliable. The plugin polls /api/status with this id instead.
app.get('/auth/start', (req, res) => {
  const sessionId = String(req.query.sessionId || '') || newSessionId()
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: DRIVE_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state: sessionId,
  })
  // Pre-filters Google's account chooser to the Workspace domain, so people don't
  // get all the way through sign-in on a personal account only to be rejected.
  // It's a usability hint, not the security boundary — assertOrgMember is.
  if (ALLOWED_DOMAINS.length === 1) params.set('hd', ALLOWED_DOMAINS[0])
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`)
})

// Step 2: Google redirects the popup here with an authorization code.
app.get('/auth/callback', async (req, res) => {
  const { code, state, error } = req.query

  if (error || !code || !state) {
    res.status(400).send(renderPopupResult(false, error ? String(error) : 'Missing authorization code'))
    return
  }

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        code: String(code),
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    })

    const tokenData = await tokenRes.json()
    if (!tokenRes.ok) {
      console.error('Token exchange failed:', tokenData)
      res.status(400).send(renderPopupResult(false, tokenData.error_description || tokenData.error || 'Token exchange failed'))
      return
    }

    // Org lock: only create a session if the account belongs to our Workspace.
    // Anything else is turned away here, before a session id ever exists — so a
    // rejected account has nothing to replay against the gated endpoints.
    let identity
    try {
      identity = assertOrgMember(decodeIdToken(tokenData.id_token))
    } catch (authErr) {
      console.warn('Rejected sign-in:', authErr.message)
      res.status(403).send(renderPopupResult(false, authErr.message))
      return
    }

    sessions.set(String(state), {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt: Date.now() + (tokenData.expires_in || 3600) * 1000,
      email: identity.email,
      domain: identity.domain,
    })
    console.log(`Session created for ${identity.email}`)

    res.send(renderPopupResult(true, null, String(state)))
  } catch (err) {
    console.error('Auth callback error:', err)
    res.status(500).send(renderPopupResult(false, 'Something went wrong completing sign-in'))
  }
})

function renderPopupResult(success, errorMessage, sessionId) {
  const payload = success
    ? { type: 'xup-drive-auth', ok: true, sessionId }
    : { type: 'xup-drive-auth', ok: false, error: errorMessage }
  const body = success
    ? 'Connected! You can close this window.'
    : `Sign-in failed: ${escapeHtml(errorMessage || 'unknown error')}`
  return `<!doctype html><html><body style="font-family:sans-serif; padding:24px;">
<p>${body}</p>
<script>
  if (window.opener) { window.opener.postMessage(${JSON.stringify(payload)}, '*') }
  setTimeout(() => window.close(), 1200)
</script>
</body></html>`
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Lets the plugin check whether a previously-stored session id is still connected
// (so re-opening the plugin doesn't force a fresh login every time).
app.get('/api/status', (req, res) => {
  const session = sessions.get(String(req.query.sessionId || ''))
  if (!session) {
    res.json({ connected: false })
    return
  }
  res.json({ connected: true, email: session.email, domain: session.domain })
})

async function getValidAccessToken(session) {
  if (session.accessToken && Date.now() < session.expiresAt - 60000) {
    return session.accessToken
  }
  if (!session.refreshToken) {
    throw new Error('Session expired — please reconnect Google Drive')
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: session.refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  const tokenData = await tokenRes.json()
  if (!tokenRes.ok) throw new Error(tokenData.error_description || tokenData.error || 'Failed to refresh access token')

  session.accessToken = tokenData.access_token
  session.expiresAt = Date.now() + (tokenData.expires_in || 3600) * 1000
  return session.accessToken
}

function extractFolderId(folderIdOrLink) {
  const match = String(folderIdOrLink || '').match(/[-\w]{25,}/)
  if (!match) throw new Error('Could not find a folder ID in that Drive link')
  return match[0]
}

async function uploadFileToDrive(accessToken, folderId, name, base64Bytes, mimeType) {
  const boundary = 'xupdrivebridge' + crypto.randomBytes(8).toString('hex')
  const metadata = { name, parents: [folderId] }
  const bodyParts = [
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    `--${boundary}\r\nContent-Type: ${mimeType || 'application/octet-stream'}\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Bytes}\r\n`,
    `--${boundary}--`,
  ]

  const uploadRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body: bodyParts.join(''),
  })

  const result = await uploadRes.json()
  if (!uploadRes.ok) throw new Error(result.error?.message || 'Drive upload failed')
  return result
}

// Step 3: the plugin sends exported files here once connected.
app.post('/api/upload', requireOrgMember, async (req, res) => {
  const { sessionId, folderLink, files } = req.body || {}

  const session = sessions.get(String(sessionId || ''))
  if (!session) {
    res.status(401).json({ error: 'Not connected to Google Drive — please reconnect' })
    return
  }
  if (!Array.isArray(files) || files.length === 0) {
    res.status(400).json({ error: 'No files provided' })
    return
  }

  let folderId
  try {
    folderId = extractFolderId(folderLink)
  } catch (err) {
    res.status(400).json({ error: err.message })
    return
  }

  try {
    const accessToken = await getValidAccessToken(session)
    const uploaded = []
    const failed = []

    for (const file of files) {
      try {
        // `name` may include forward slashes to mirror the artboard/frame hierarchy
        // (e.g. "A+ Premium/A+ Premium (Mobile)/Mobile Module 1.png") — Drive has no
        // real subfolders here without extra API calls, so we flatten those into the
        // filename itself rather than silently dropping the structure.
        const flatName = String(file.name).replace(/\//g, ' - ')
        await uploadFileToDrive(accessToken, folderId, flatName, file.base64, file.mimeType)
        uploaded.push(file.name)
      } catch (err) {
        console.error(`Failed to upload "${file.name}":`, err)
        failed.push({ name: file.name, error: err.message })
      }
    }

    res.json({ uploaded, failed })
  } catch (err) {
    console.error('Upload failed:', err)
    res.status(500).json({ error: err.message })
  }
})

// ---------------------------------------------------------------------------
// Competitor research (Data Dive -> Scrape.do)
// ---------------------------------------------------------------------------

// Step 1: turn a Data Dive niche link into its shortlisted competitor ASINs.
app.post('/api/niche/competitors', requireOrgMember, async (req, res) => {
  const { link } = req.body || {}
  if (!link) {
    res.status(400).json({ error: 'Paste a Data Dive niche link' })
    return
  }
  try {
    res.json(await getNicheCompetitors(link))
  } catch (err) {
    console.error('Niche lookup failed:', err)
    res.status(502).json({ error: err.message })
  }
})

// Step 2: scrape each selected ASIN's detail page for its creative assets. This
// returns URLs only — the plugin pulls the actual bytes through /api/image below,
// so a slow ASIN never blocks the whole response.
app.post('/api/niche/assets', requireOrgMember, async (req, res) => {
  const { marketplace, asins, kinds } = req.body || {}
  if (!Array.isArray(asins) || asins.length === 0) {
    res.status(400).json({ error: 'No ASINs provided' })
    return
  }
  // A cap keeps one fat niche from burning a few hundred Scrape.do credits in a
  // single accidental click.
  const list = asins.map((a) => String(a).trim().toUpperCase()).filter(Boolean).slice(0, 30)

  try {
    res.json({ marketplace: marketplace || 'com', results: await scrapeAsins(marketplace, list, kinds) })
  } catch (err) {
    console.error('Asset scrape failed:', err)
    res.status(502).json({ error: err.message })
  }
})

// Step 3: image proxy. A Figma plugin may only make network calls to domains
// listed in its manifest's `networkAccess.allowedDomains`, and Amazon's CDN isn't
// (and shouldn't be) one of them — so image bytes come back through this service.
const ALLOWED_IMAGE_HOSTS = new Set(['m.media-amazon.com', 'images-na.ssl-images-amazon.com'])

app.get('/api/image', requireOrgMember, async (req, res) => {
  const raw = String(req.query.url || '')

  let parsed
  try {
    parsed = new URL(raw)
  } catch (err) {
    res.status(400).json({ error: 'Invalid image URL' })
    return
  }
  // Host allowlist: without it this endpoint would be an open proxy anyone could
  // point at an internal address.
  if (parsed.protocol !== 'https:' || !ALLOWED_IMAGE_HOSTS.has(parsed.hostname)) {
    res.status(400).json({ error: `Refusing to proxy ${parsed.hostname}` })
    return
  }

  try {
    const upstream = await fetch(parsed.toString())
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: `Image fetch failed (${upstream.status})` })
      return
    }
    const contentType = upstream.headers.get('content-type') || 'image/jpeg'
    if (!contentType.startsWith('image/')) {
      res.status(415).json({ error: 'Upstream did not return an image' })
      return
    }
    res.set('Content-Type', contentType)
    res.set('Cache-Control', 'public, max-age=86400')
    res.send(Buffer.from(await upstream.arrayBuffer()))
  } catch (err) {
    console.error('Image proxy failed:', err)
    res.status(502).json({ error: err.message })
  }
})

app.listen(PORT, () => {
  console.log(`XUP Drive Bridge listening on port ${PORT}`)
})
