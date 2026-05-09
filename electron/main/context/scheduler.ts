/**
 * Context Scheduler — background refresh of app resource snapshots.
 *
 * Uses Node's setInterval (not cron) to keep it lightweight.
 * Intervals are per-scope so high-churn scopes (calendars) refresh faster.
 */
import { refreshSnapshot } from './snapshotManager'
import { listConnections } from '../apps/manager'

// Per-scope refresh intervals (ms)
const SCOPE_INTERVALS: Record<string, number> = {
  'slack.channels':  30 * 60 * 1000,  // 30 min
  'slack.users':     60 * 60 * 1000,  // 60 min
  'github.repos':    60 * 60 * 1000,  // 60 min
  'google.calendars': 5 * 60 * 1000,  //  5 min
  'jira.projects':   60 * 60 * 1000,  // 60 min
}

// appId → list of (scope, interval)
const APP_SCOPE_MAP: Record<string, { scope: string; interval: number }[]> = {
  slack:  [{ scope: 'channels', interval: SCOPE_INTERVALS['slack.channels'] },
           { scope: 'users',    interval: SCOPE_INTERVALS['slack.users'] }],
  github: [{ scope: 'repos',     interval: SCOPE_INTERVALS['github.repos'] }],
  google: [{ scope: 'calendars', interval: SCOPE_INTERVALS['google.calendars'] }],
  jira:   [{ scope: 'projects',  interval: SCOPE_INTERVALS['jira.projects'] }],
}

// key: `${appId}:${scope}` → interval handle
const handles = new Map<string, ReturnType<typeof setInterval>>()

function scheduleApp(appId: string): void {
  clearAppSchedule(appId)
  const scopes = APP_SCOPE_MAP[appId]
  if (!scopes) return
  for (const { scope, interval } of scopes) {
    const key = `${appId}:${scope}`
    const handle = setInterval(() => {
      console.log(`[scheduler] tick: refreshing ${key}`)
      refreshSnapshot(appId, scope).catch(err =>
        console.error(`[scheduler] refresh failed for ${key}`, err),
      )
    }, interval)
    handles.set(key, handle)
  }
}

function clearAppSchedule(appId: string): void {
  const scopes = APP_SCOPE_MAP[appId] ?? []
  for (const { scope } of scopes) {
    const key = `${appId}:${scope}`
    const h = handles.get(key)
    if (h !== undefined) {
      clearInterval(h)
      handles.delete(key)
    }
  }
}

/**
 * Start background refresh intervals for all currently connected apps.
 * Call once after DB initialisation.
 */
export function startContextScheduler(): void {
  const connections = listConnections().filter(c => c.enabled)
  for (const c of connections) {
    scheduleApp(c.appId)
  }
  console.log(`[scheduler] started (${handles.size} intervals for ${connections.length} apps)`)
}

/**
 * Stop all background refresh intervals. Call from the before-quit handler.
 */
export function stopContextScheduler(): void {
  for (const [, handle] of handles) {
    clearInterval(handle)
  }
  const count = handles.size
  handles.clear()
  console.log(`[scheduler] stopped (cleared ${count} intervals)`)
}

/**
 * Register refresh intervals for a newly connected app.
 * Call after buildSnapshot() completes in the connect flow.
 */
export function scheduleAppOnConnect(appId: string): void {
  scheduleApp(appId)
}

/**
 * Remove refresh intervals for a disconnected app.
 * Call in disconnectApp().
 */
export function clearAppScheduleOnDisconnect(appId: string): void {
  clearAppSchedule(appId)
}
