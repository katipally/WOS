import { refreshAccessToken } from './oauth'
import { getConnection } from '../manager'
import { encryptApiKey, decryptApiKey } from '../../crypto'
import { getDb, schema, notifyWrite } from '../../db'
import { eq } from 'drizzle-orm'

export interface GoogleCreds {
  clientId: string
  clientSecret: string
  accessToken: string
  refreshToken: string
  expiresAt: string
}

export async function getFreshToken(creds: GoogleCreds): Promise<string> {
  const expiresAt = parseInt(creds.expiresAt, 10)
  if (Date.now() < expiresAt - 5 * 60 * 1000) {
    return creds.accessToken
  }
  console.log('[google:api] access token expired, refreshing...')
  try {
    const refreshed = await refreshAccessToken(creds.clientId, creds.clientSecret, creds.refreshToken)
    console.log('[google:api] token refreshed, new expiry:', new Date(refreshed.expiresAt).toISOString())
    const updatedCreds: GoogleCreds = { ...creds, accessToken: refreshed.accessToken, expiresAt: String(refreshed.expiresAt) }
    persistUpdatedTokens(updatedCreds)
    return refreshed.accessToken
  } catch (err) {
    console.error('[google:api] token refresh failed:', err instanceof Error ? err.message : err)
    throw err
  }
}

function persistUpdatedTokens(creds: GoogleCreds): void {
  try {
    const db = getDb()
    const credsStr = JSON.stringify(creds)
    const { encrypted, iv } = encryptApiKey(credsStr)
    db.update(schema.appConnections)
      .set({ encryptedCreds: encrypted, iv, updatedAt: new Date() })
      .where(eq(schema.appConnections.appId, 'google'))
      .run()
    notifyWrite()
  } catch { /* ignore persistence errors during tool execution */ }
}

function humanizeGoogleError(status: number, body: string): Error {
  if (status === 401) return new Error('Google session expired. Please reconnect Google in Settings → Apps → Google.')
  if (status === 403) {
    if (body.includes('insufficientPermissions') || body.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT')) {
      return new Error('Google permission denied. Make sure you granted the required scopes when connecting Google.')
    }
    return new Error('Google access denied. Check that your account has access to this resource.')
  }
  if (status === 429) return new Error('Google rate limit reached. Please wait a moment before trying again.')
  if (status === 404) return new Error('Google resource not found. Check that the ID or path is correct.')
  if (status === 400) {
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } }
      if (parsed.error?.message) return new Error(`Google API error: ${parsed.error.message}`)
    } catch { /* ignore */ }
  }
  return new Error(`Google API error (${status}): ${body.slice(0, 200)}`)
}

async function handleGoogleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw humanizeGoogleError(res.status, text)
  }
  if (res.status === 204) return {} as T
  return res.json() as Promise<T>
}

export async function googleGet<T = unknown>(path: string, creds: GoogleCreds): Promise<T> {
  const token = await getFreshToken(creds)
  const res = await fetch(`https://www.googleapis.com${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  return handleGoogleResponse<T>(res)
}

export async function googlePost<T = unknown>(path: string, body: unknown, creds: GoogleCreds, baseUrl = 'https://www.googleapis.com'): Promise<T> {
  const token = await getFreshToken(creds)
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  })
  return handleGoogleResponse<T>(res)
}

export async function googlePatch<T = unknown>(path: string, body: unknown, creds: GoogleCreds): Promise<T> {
  const token = await getFreshToken(creds)
  const res = await fetch(`https://www.googleapis.com${path}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  })
  return handleGoogleResponse<T>(res)
}

export async function getUserInfo(creds: GoogleCreds) {
  return googleGet<{ email: string; name: string; picture: string }>(
    '/oauth2/v2/userinfo', creds,
  )
}

/* ── Gmail helpers ── */
const GMAIL = '/gmail/v1/users/me'

export async function listMessages(creds: GoogleCreds, query = '', maxResults = 20) {
  const q = new URLSearchParams({ maxResults: String(maxResults) })
  if (query) q.set('q', query)
  return googleGet<{ messages?: Array<{ id: string; threadId: string }>; resultSizeEstimate: number }>(
    `${GMAIL}/messages?${q}`, creds,
  )
}

export async function getMessage(creds: GoogleCreds, id: string) {
  return googleGet<{ id: string; threadId: string; payload: unknown; snippet: string; internalDate: string }>(
    `${GMAIL}/messages/${id}?format=full`, creds,
  )
}

export async function sendMessage(creds: GoogleCreds, to: string, subject: string, body: string, cc?: string, threadId?: string) {
  const raw = buildRawEmail(to, subject, body, cc, threadId)
  return googlePost<{ id: string; threadId: string }>(
    `${GMAIL}/messages/send`,
    { raw },
    creds,
    'https://gmail.googleapis.com',
  )
}

export async function createDraft(creds: GoogleCreds, to: string, subject: string, body: string) {
  const raw = buildRawEmail(to, subject, body)
  return googlePost<unknown>(
    `${GMAIL}/drafts`,
    { message: { raw } },
    creds,
    'https://gmail.googleapis.com',
  )
}

function buildRawEmail(to: string, subject: string, body: string, cc?: string, threadId?: string): string {
  const lines = [
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    ...(threadId ? [`X-Thread-Id: ${threadId}`] : []),
    '',
    body,
  ]
  return Buffer.from(lines.join('\r\n')).toString('base64url')
}

/* ── Calendar helpers ── */
const CAL = '/calendar/v3/calendars/primary'

export async function listCalendarEvents(creds: GoogleCreds, timeMin?: string, timeMax?: string, maxResults = 20) {
  const q = new URLSearchParams({ maxResults: String(maxResults), singleEvents: 'true', orderBy: 'startTime' })
  if (timeMin) q.set('timeMin', timeMin)
  else q.set('timeMin', new Date().toISOString())
  if (timeMax) q.set('timeMax', timeMax)
  return googleGet<{ items: unknown[] }>(`${CAL}/events?${q}`, creds)
}

export async function getCalendarEvent(creds: GoogleCreds, eventId: string) {
  return googleGet<unknown>(`${CAL}/events/${eventId}`, creds)
}

export async function createCalendarEvent(creds: GoogleCreds, event: {
  summary: string
  start: { dateTime: string; timeZone?: string }
  end: { dateTime: string; timeZone?: string }
  description?: string
  attendees?: Array<{ email: string }>
  addMeetLink?: boolean
}) {
  const { addMeetLink, ...eventBody } = event
  const body: Record<string, unknown> = { ...eventBody }
  if (addMeetLink) {
    body.conferenceData = { createRequest: { requestId: `wos-${Date.now()}`, conferenceSolutionKey: { type: 'hangoutsMeet' } } }
  }
  const q = addMeetLink ? '?conferenceDataVersion=1' : ''
  return googlePost<unknown>(`${CAL}/events${q}`, body, creds)
}

export async function updateCalendarEvent(creds: GoogleCreds, eventId: string, updates: Record<string, unknown>) {
  return googlePatch<unknown>(`${CAL}/events/${eventId}`, updates, creds)
}

/* ── Drive helpers ── */
const DRIVE = '/drive/v3'

export async function listDriveFiles(creds: GoogleCreds, query?: string, pageSize = 20) {
  const q = new URLSearchParams({
    pageSize: String(pageSize),
    fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink)',
  })
  if (query) q.set('q', query)
  return googleGet<{ files: unknown[] }>(`${DRIVE}/files?${q}`, creds)
}

export async function getDriveFile(creds: GoogleCreds, fileId: string) {
  const meta = await googleGet<{ id: string; name: string; mimeType: string; size: string }>(
    `${DRIVE}/files/${fileId}?fields=id,name,mimeType,size,modifiedTime,webViewLink`, creds,
  )
  const token = await getFreshToken(creds)
  const textMime = meta.mimeType?.startsWith('text/') || meta.mimeType === 'application/json'
  let content: string | null = null
  if (textMime && parseInt(meta.size, 10) < 500_000) {
    const res = await fetch(`https://www.googleapis.com${DRIVE}/files/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) content = await res.text()
  }
  return { ...meta, content }
}

export async function uploadDriveFile(creds: GoogleCreds, name: string, content: string, mimeType = 'text/plain', folderId?: string) {
  const token = await getFreshToken(creds)
  const metadata: Record<string, unknown> = { name, mimeType }
  if (folderId) metadata.parents = [folderId]
  const form = new FormData()
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }))
  form.append('file', new Blob([content], { type: mimeType }))
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Drive upload failed ${res.status}: ${text}`)
  }
  return res.json()
}

export async function createDriveFolder(creds: GoogleCreds, name: string, parentId?: string) {
  const metadata: Record<string, unknown> = { name, mimeType: 'application/vnd.google-apps.folder' }
  if (parentId) metadata.parents = [parentId]
  return googlePost<{ id: string; name: string }>(`${DRIVE}/files`, metadata, creds)
}

/* ── Calendar List ── */
export async function listCalendarList(creds: GoogleCreds) {
  return googleGet<{ items?: Array<{ id: string; summary: string; primary?: boolean }> }>(
    '/calendar/v3/users/me/calendarList', creds,
  )
}

/* ── People / contacts search (Gmail-style "To:" autocomplete) ── */
export interface GmailContact {
  name: string
  email: string
  photoUrl: string | null
}

export async function searchGmailContacts(creds: GoogleCreds, query: string): Promise<GmailContact[]> {
  if (!query.trim()) return []
  const token = await getFreshToken(creds)

  // Try saved contacts first (contacts.readonly scope)
  const results: GmailContact[] = []
  const seen = new Set<string>()

  try {
    const q = new URLSearchParams({ query, readMask: 'names,emailAddresses,photos', pageSize: '10' })
    const res = await fetch(`https://people.googleapis.com/v1/people:searchContacts?${q}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })
    if (res.ok) {
      const data = await res.json() as { results?: Array<{ person: { names?: Array<{ displayName?: string }>; emailAddresses?: Array<{ value?: string }>; photos?: Array<{ url?: string }> } }> }
      for (const r of data.results ?? []) {
        const email = r.person?.emailAddresses?.[0]?.value ?? ''
        if (!email || seen.has(email.toLowerCase())) continue
        seen.add(email.toLowerCase())
        results.push({
          name: r.person?.names?.[0]?.displayName ?? email,
          email,
          photoUrl: r.person?.photos?.[0]?.url ?? null,
        })
      }
    }
  } catch { /* contacts scope not granted — fall through */ }

  // Also search "other contacts" (people you've emailed — no extra scope beyond contacts.other.readonly)
  if (results.length < 10) {
    try {
      const q = new URLSearchParams({ query, readMask: 'names,emailAddresses,photos', pageSize: String(10 - results.length) })
      const res = await fetch(`https://people.googleapis.com/v1/otherContacts:search?${q}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      })
      if (res.ok) {
        const data = await res.json() as { results?: Array<{ person: { names?: Array<{ displayName?: string }>; emailAddresses?: Array<{ value?: string }>; photos?: Array<{ url?: string }> } }> }
        for (const r of data.results ?? []) {
          const email = r.person?.emailAddresses?.[0]?.value ?? ''
          if (!email || seen.has(email.toLowerCase())) continue
          seen.add(email.toLowerCase())
          results.push({
            name: r.person?.names?.[0]?.displayName ?? email,
            email,
            photoUrl: r.person?.photos?.[0]?.url ?? null,
          })
        }
      }
    } catch { /* other contacts scope not granted */ }
  }

  return results
}
