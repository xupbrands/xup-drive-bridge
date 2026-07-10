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
//
// See README.md for full setup steps.

const express = require('express')
const cors = require('cors')
const crypto = require('crypto')

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  PUBLIC_URL,
  PORT = 3000,
} = process.env

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !PUBLIC_URL) {
  console.warn('WARNING: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and PUBLIC_URL must all be set as environment variables for OAuth to work.')
}

const REDIRECT_URI = `${PUBLIC_URL}/auth/callback`
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'

// In-memory session store: sessionId -> { accessToken, refreshToken, expiresAt }
// NOTE: this resets on every server restart/redeploy, which just means the
// designer has to click "Connect Google Drive" again — acceptable for an
// internal tool. If that becomes annoying, swap this for a small persistent
// store (e.g. a Railway-provisioned Postgres/Redis add-on).
const sessions = new Map()

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
app.get('/auth/start', (req, res) => {
  const sessionId = newSessionId()
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: DRIVE_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state: sessionId,
  })
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

    sessions.set(String(state), {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt: Date.now() + (tokenData.expires_in || 3600) * 1000,
    })

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
  res.json({ connected: !!session })
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
app.post('/api/upload', async (req, res) => {
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

app.listen(PORT, () => {
  console.log(`XUP Drive Bridge listening on port ${PORT}`)
})
