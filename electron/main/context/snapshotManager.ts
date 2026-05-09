/**
 * Snapshot Manager — lightweight resource cache for connected apps.
 *
 * Stores one row per (app_id, scope) in `app_context_snapshots`.
 * Populated on connect; exposed to agents via context tools.
 */
import { queryRaw, runRaw, notifyWrite } from '../db'
import { getApp, listConnections } from '../apps/manager'

export interface SnapshotRow {
  appId: string
  scope: string
  data: unknown[]
  fetchedAt: number
  etag: string | null
}

// ─── Read ────────────────────────────────────────────────────────────────────

export function getSnapshot(appId: string, scope: string): SnapshotRow | null {
  const rows = queryRaw<{ app_id: string; scope: string; data_json: string; fetched_at: number; etag: string | null }>(
    'SELECT app_id, scope, data_json, fetched_at, etag FROM app_context_snapshots WHERE app_id = ? AND scope = ?',
    [appId, scope],
  )
  if (rows.length === 0) return null
  const r = rows[0]
  return { appId: r.app_id, scope: r.scope, data: JSON.parse(r.data_json), fetchedAt: r.fetched_at, etag: r.etag }
}

export function getAllSnapshots(appId?: string): SnapshotRow[] {
  const rows = appId
    ? queryRaw<{ app_id: string; scope: string; data_json: string; fetched_at: number; etag: string | null }>(
        'SELECT app_id, scope, data_json, fetched_at, etag FROM app_context_snapshots WHERE app_id = ? ORDER BY app_id, scope',
        [appId],
      )
    : queryRaw<{ app_id: string; scope: string; data_json: string; fetched_at: number; etag: string | null }>(
        'SELECT app_id, scope, data_json, fetched_at, etag FROM app_context_snapshots ORDER BY app_id, scope',
      )
  return rows.map(r => ({ appId: r.app_id, scope: r.scope, data: JSON.parse(r.data_json), fetchedAt: r.fetched_at, etag: r.etag }))
}

// ─── Write ───────────────────────────────────────────────────────────────────

function upsertScope(appId: string, scope: string, data: unknown[], etag?: string): void {
  runRaw(
    `INSERT INTO app_context_snapshots (app_id, scope, data_json, fetched_at, etag)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (app_id, scope) DO UPDATE SET data_json = excluded.data_json, fetched_at = excluded.fetched_at, etag = excluded.etag`,
    [appId, scope, JSON.stringify(data), Date.now(), etag ?? null],
  )
}

// ─── Build / refresh ─────────────────────────────────────────────────────────

/**
 * Fetch a fresh snapshot for `appId` and persist it.
 * Silently no-ops if the app module has no `snapshot` function.
 */
export async function buildSnapshot(appId: string, creds: Record<string, string>): Promise<void> {
  const app = getApp(appId)
  if (!app?.snapshot) return
  console.log(`[snapshot] building snapshot for ${appId}...`)
  const result = await app.snapshot(creds)
  for (const [scope, items] of Object.entries(result)) {
    upsertScope(appId, scope, items)
  }
  console.log(`[snapshot] built snapshot for ${appId}: ${Object.keys(result).join(', ')}`)
  notifyWrite()
}

/**
 * Refresh snapshots for all currently connected apps. Errors are logged but
 * do not propagate — a stale snapshot is better than a broken UI.
 */
export async function refreshAllSnapshots(): Promise<void> {
  const connections = listConnections()
  await Promise.allSettled(
    connections
      .filter(c => c.enabled)
      .map(c =>
        buildSnapshot(c.appId, c.creds).catch(err =>
          console.error(`[snapshot] refresh failed for ${c.appId}`, err),
        ),
      ),
  )
}

/**
 * Force-refresh the snapshot for a single app (and optionally a single scope).
 * Re-fetches from the app's `snapshot()` method and overwrites cached rows.
 * On error, logs and silently keeps the existing snapshot.
 */
export async function refreshSnapshot(appId: string, scope?: string): Promise<void> {
  const { getConnection } = await import('../apps/manager')
  const conn = getConnection(appId)
  if (!conn?.enabled) return

  const app = getApp(appId)
  if (!app?.snapshot) return

  console.log(`[snapshot] refreshing ${appId}/${scope ?? '*'}...`)
  try {
    const result = await app.snapshot(conn.creds)
    if (scope) {
      if (Object.prototype.hasOwnProperty.call(result, scope)) {
        upsertScope(appId, scope, result[scope])
      }
    } else {
      for (const [s, items] of Object.entries(result)) {
        upsertScope(appId, s, items)
      }
    }
    console.log(`[snapshot] refreshed ${appId}/${scope ?? '*'}`)
    notifyWrite()
  } catch (err) {
    console.error(`[snapshot] refreshSnapshot failed for ${appId}/${scope ?? '*'}`, err)
    // Silently keep existing snapshot
  }
}
