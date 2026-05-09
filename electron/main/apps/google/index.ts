import type { AppModule } from '../types'
import { getUserInfo, listCalendarList, listMessages, getMessage, listDriveFiles, googleGet } from './api'
import type { GoogleCreds } from './api'
import { runOAuthFlow } from './oauth'
import { buildGoogleTools } from './tools'

export const googleApp: AppModule = {
  manifest: {
    id: 'google',
    name: 'Google Workspace',
    description: 'Access Gmail, Google Calendar, and Google Drive from your WOS agent.',
    icon: 'google',
    authType: 'oauth',
    scopes: [
      'gmail.modify',
      'calendar',
      'drive',
    ],
    docsUrl: 'https://console.cloud.google.com/apis/credentials',
    authFields: [
      {
        key: 'clientId',
        label: 'Client ID',
        placeholder: '123456789012-abc….apps.googleusercontent.com',
        required: true,
        helper: 'From Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client ID.',
      },
      {
        key: 'clientSecret',
        label: 'Client Secret',
        placeholder: 'GOCSPX-…',
        required: true,
        secret: true,
        helper: 'Found next to the Client ID in Google Cloud Console.',
      },
    ],
  },

  async test(creds) {
    if (!creds.accessToken) return { ok: false, error: 'No access token. Please authorize first.' }
    try {
      const user = await getUserInfo(creds as unknown as GoogleCreds)
      return {
        ok: true,
        identity: { email: user.email, name: user.name },
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  },

  async initiateOAuth(creds) {
    if (!creds.clientId) return { ok: false, error: 'Client ID is required.' }
    if (!creds.clientSecret) return { ok: false, error: 'Client Secret is required.' }
    console.log('[google:oauth] initiating OAuth flow, clientId:', String(creds.clientId).slice(0, 20) + '...')
    try {
      const tokens = await runOAuthFlow(creds.clientId, creds.clientSecret)
      const fullCreds: Record<string, string> = {
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: String(tokens.expiresAt),
        redirectUri: tokens.redirectUri,
      }
      const user = await getUserInfo(fullCreds as unknown as GoogleCreds)
      console.log('[google:oauth] OAuth success, user:', user.email)
      return {
        ok: true,
        identity: { email: user.email, name: user.name },
        fullCreds,
      }
    } catch (err) {
      console.error('[google:oauth] OAuth failed:', err instanceof Error ? err.message : err)
      return { ok: false, error: (err as Error).message }
    }
  },

  buildTools(creds) {
    return buildGoogleTools(creds as unknown as GoogleCreds)
  },
  async snapshot(creds) {
    console.log('[google] fetching calendar list...')
    try {
      const data = await listCalendarList(creds as unknown as GoogleCreds)
      const calendars = (data.items ?? []).map(c => ({ id: c.id, summary: c.summary, primary: c.primary ?? false }))
      console.log('[google] calendar snapshot:', calendars.length, 'calendars')
      return { calendars }
    } catch (err) {
      console.error('[google] calendar snapshot failed:', err instanceof Error ? err.message : err)
      return { calendars: [] }
    }
  },
  projectResourceTypes() {
    return [
      {
        kind: 'google:calendar',
        label: 'Google Calendar',
        description: 'Show upcoming meetings on the project dashboard.',
        multiSelect: true,
        pickerComponentId: 'snapshot-list',
        snapshotScope: 'calendars',
        refreshIntervalSec: 1800,
        refSchema: {
          hint: 'Pick a calendar, or paste its id (use "primary" for your default).',
          fields: [
            { name: 'id', label: 'Calendar id', type: 'text', required: true, placeholder: 'primary' },
            { name: 'summary', label: 'Display name', type: 'text', placeholder: 'Atlas Roadmap' },
          ],
        },
        refExamples: ['primary', 'team@acme.com'],
        async fetcher(creds, ref) {
          if (!creds.accessToken) return []
          const calId = extractGoogleId(ref) ?? 'primary'
          try {
            const timeMin = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
            const q = new URLSearchParams({
              maxResults: '15',
              singleEvents: 'true',
              orderBy: 'startTime',
              timeMin,
            })
            const data = await googleGet<{
              items?: Array<{
                id: string; summary?: string; htmlLink?: string;
                start?: { dateTime?: string; date?: string };
                organizer?: { email?: string; displayName?: string };
              }>
            }>(`/calendar/v3/calendars/${encodeURIComponent(calId)}/events?${q}`, creds as unknown as GoogleCreds)
            return (data.items ?? []).map(ev => ({
              id: ev.id,
              ts: Date.parse(ev.start?.dateTime ?? ev.start?.date ?? '') || Date.now(),
              actor: ev.organizer?.displayName ?? ev.organizer?.email ?? null,
              title: ev.summary ?? '(no title)',
              url: ev.htmlLink ?? null,
            }))
          } catch (err) {
            console.error('[google/fetcher] calendar failed', err)
            return []
          }
        },
      },
      {
        kind: 'google:gmail_label',
        label: 'Gmail label or query',
        description: 'Match threads by Gmail label or search query (e.g. label:atlas).',
        multiSelect: true,
        pickerComponentId: 'gmail-query',
        refreshIntervalSec: 600,
        refSchema: {
          hint: 'Any valid Gmail search query.',
          fields: [
            { name: 'query', label: 'Gmail query', type: 'textarea', required: true, placeholder: 'label:atlas newer_than:7d' },
          ],
        },
        refExamples: ['label:atlas', 'from:alerts@acme.com newer_than:7d'],
        async fetcher(creds, ref) {
          if (!creds.accessToken) return []
          const query = extractGmailQuery(ref)
          if (!query) return []
          try {
            const list = await listMessages(creds as unknown as GoogleCreds, query, 15)
            const ids = (list.messages ?? []).map(m => m.id).slice(0, 10)
            const detailed = await Promise.all(
              ids.map(id => getMessage(creds as unknown as GoogleCreds, id).catch(() => null)),
            )
            return detailed.filter(Boolean).map(m => {
              const msg = m as { id: string; snippet?: string; internalDate?: string; payload?: { headers?: Array<{ name: string; value: string }> } }
              const headers = msg.payload?.headers ?? []
              const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value ?? ''
              const from = headers.find(h => h.name.toLowerCase() === 'from')?.value ?? null
              return {
                id: msg.id,
                ts: msg.internalDate ? Number(msg.internalDate) : Date.now(),
                actor: from,
                title: subject || (msg.snippet ?? '').slice(0, 120),
                url: `https://mail.google.com/mail/u/0/#inbox/${msg.id}`,
              }
            })
          } catch (err) {
            console.error('[google/fetcher] gmail failed', err)
            return []
          }
        },
      },
      {
        kind: 'google:drive_folder',
        label: 'Drive folder',
        description: 'Watch a Drive folder for new and updated docs.',
        multiSelect: true,
        pickerComponentId: 'drive-folder',
        refreshIntervalSec: 3600,
        refSchema: {
          hint: 'Paste a folder id or its share URL.',
          fields: [
            { name: 'id', label: 'Folder id', type: 'text', required: true, placeholder: '1A2B3CdEf…' },
            { name: 'name', label: 'Folder name', type: 'text', placeholder: 'Atlas / Designs' },
          ],
          pasteParsers: [
            { regex: 'drive\\.google\\.com/drive/folders/(?<id>[A-Za-z0-9_-]+)', groupToField: { id: 'id' } },
            { regex: 'id=(?<id>[A-Za-z0-9_-]+)', groupToField: { id: 'id' } },
          ],
        },
        refExamples: ['https://drive.google.com/drive/folders/1A2B3CdEf'],
        async fetcher(creds, ref) {
          if (!creds.accessToken) return []
          const folderId = extractGoogleId(ref)
          if (!folderId) return []
          try {
            const data = await listDriveFiles(
              creds as unknown as GoogleCreds,
              `'${folderId}' in parents and trashed = false`,
              20,
            )
            return (data.files as Array<{
              id: string; name: string; modifiedTime?: string; webViewLink?: string;
              lastModifyingUser?: { displayName?: string; emailAddress?: string };
            }>).map(f => ({
              id: f.id,
              ts: Date.parse(f.modifiedTime ?? '') || Date.now(),
              actor: f.lastModifyingUser?.displayName ?? f.lastModifyingUser?.emailAddress ?? null,
              title: f.name,
              url: f.webViewLink ?? null,
            }))
          } catch (err) {
            console.error('[google/fetcher] drive failed', err)
            return []
          }
        },
      },
    ]
  },
}

function extractGoogleId(ref: unknown): string | null {
  if (!ref) return null
  if (typeof ref === 'string') return ref
  if (typeof ref === 'object') {
    const r = ref as Record<string, unknown>
    if (typeof r.id === 'string') return r.id
    if (typeof r.calendarId === 'string') return r.calendarId
    if (typeof r.folderId === 'string') return r.folderId
  }
  return null
}

function extractGmailQuery(ref: unknown): string | null {
  if (!ref) return null
  if (typeof ref === 'string') return ref
  if (typeof ref === 'object') {
    const r = ref as Record<string, unknown>
    if (typeof r.query === 'string') return r.query
    if (typeof r.label === 'string') return `label:${r.label}`
    if (typeof r.q === 'string') return r.q
  }
  return null
}
