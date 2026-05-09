import * as http from 'node:http'
import { shell } from 'electron'

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/contacts.other.readonly',
].join(' ')

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = http.createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
    s.on('error', reject)
  })
}

export async function runOAuthFlow(clientId: string, clientSecret: string): Promise<{
  accessToken: string
  refreshToken: string
  expiresAt: number
  redirectUri: string
}> {
  const port = await findFreePort()
  const redirectUri = `http://127.0.0.1:${port}/callback`

  return new Promise((resolve, reject) => {
    let server: http.Server | null = null
    const timeout = setTimeout(() => {
      server?.close()
      reject(new Error('OAuth authorization timed out (5 minutes). Please try again.'))
    }, 5 * 60 * 1000)

    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
      if (url.pathname !== '/callback') {
        res.writeHead(404)
        res.end('Not found')
        return
      }

      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(`<html><body><h2>Authorization denied.</h2><p>${error}</p><script>window.close()</script></body></html>`)
        clearTimeout(timeout)
        server?.close()
        reject(new Error(`OAuth denied: ${error}`))
        return
      }

      if (!code) {
        res.writeHead(400)
        res.end('Missing code')
        return
      }

      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(`<html><body style="font-family:system-ui;text-align:center;padding-top:80px">
        <h2 style="color:#16a34a">✓ Connected to Google Workspace</h2>
        <p style="color:#666">You can close this tab and return to WOS.</p>
        <script>setTimeout(()=>window.close(),2000)</script>
      </body></html>`)

      clearTimeout(timeout)
      server?.close()

      exchangeCode(code, clientId, clientSecret, redirectUri)
        .then(resolve)
        .catch(reject)
    })

    server.listen(port, '127.0.0.1', () => {
      const authUrl = buildAuthUrl(clientId, redirectUri)
      void shell.openExternal(authUrl)
    })

    server.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}

function buildAuthUrl(clientId: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
  })
  return `${AUTH_ENDPOINT}?${params}`
}

async function exchangeCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: number; redirectUri: string }> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Token exchange failed ${res.status}: ${text}`)
  }
  const data = await res.json() as { access_token: string; refresh_token?: string; expires_in: number }
  if (!data.refresh_token) {
    throw new Error('No refresh token returned. Make sure you included prompt=consent in the auth URL.')
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    redirectUri,
  }
}

export async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<{ accessToken: string; expiresAt: number }> {
  console.log('[google:oauth] refreshing access token...')
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    let parsed: { error?: string } = {}
    try { parsed = JSON.parse(text) as { error?: string } } catch { /* ignore */ }
    if (parsed.error === 'invalid_client' || parsed.error === 'unauthorized_client') {
      throw new Error('Google OAuth credentials are invalid. Please reconnect Google in Settings → Apps → Google.')
    }
    throw new Error(`Token refresh failed ${res.status}: ${text}`)
  }
  const data = await res.json() as { access_token: string; expires_in: number }
  console.log('[google:oauth] token refreshed, expires in', data.expires_in, 's')
  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  }
}
