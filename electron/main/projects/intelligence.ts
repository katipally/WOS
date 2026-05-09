/**
 * Project intelligence: AI summaries, health scoring, risk heuristics, alerts.
 *
 * Phase 4 implementation. All functions are best-effort and degrade gracefully
 * when no model is configured (returns a deterministic stub instead of
 * throwing) so the UI keeps working in offline / unconfigured installs.
 */

import { resolveAgent } from '../agent/settings'

import { getProvider } from '../providers'
import {
  getProject,
  listActivity,
  listResources,
  listRisks,
  recordSummary,
  updateProject,
  markAlertFired,
  listAlerts,
  recordMetric,
} from './manager'
import type { ProjectActivityRow, ProjectAlertRow } from './types'

export type SummaryKind = 'daily' | 'weekly' | 'status' | 'standup'

const KIND_HEADER: Record<SummaryKind, string> = {
  daily: 'Daily summary',
  weekly: 'Weekly digest',
  status: 'Status update',
  standup: 'Standup notes',
}

const KIND_LOOKBACK_MS: Record<SummaryKind, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  status: 14 * 24 * 60 * 60 * 1000,
  standup: 24 * 60 * 60 * 1000,
}

async function pickModel(projectModelOverride: string | null): Promise<{ model: string; apiKeyOverride?: string } | null> {
  if (projectModelOverride) return { model: projectModelOverride }
  try {
    const agent = await resolveAgent('wos')
    if (agent.model) return { model: agent.model, apiKeyOverride: agent.apiKeyOverride }
  } catch { /* ignore */ }
  return null
}

function stubSummary(activities: ProjectActivityRow[], kind: SummaryKind): string {
  if (!activities.length) return `${KIND_HEADER[kind]}: no activity recorded yet.`
  const byApp = new Map<string, number>()
  for (const a of activities) byApp.set(a.sourceApp, (byApp.get(a.sourceApp) ?? 0) + 1)
  const apps = [...byApp.entries()].map(([k, n]) => `${k}: ${n}`).join(', ')
  const recent = activities.slice(0, 5).map(a => `• ${a.title}`).join('\n')
  return `${KIND_HEADER[kind]} (${activities.length} events — ${apps})\n\nRecent activity:\n${recent}`
}

function fingerprint(activities: ProjectActivityRow[]): string {
  // Cheap content hash so we skip regeneration when nothing changed.
  return activities.map(a => `${a.sourceApp}:${a.dedupeKey}:${a.ts}`).join('|').slice(0, 256)
}

export async function generateSummary(projectId: string, kind: SummaryKind): Promise<{ ok: boolean; summary?: string; cached?: boolean; error?: string }> {
  const project = getProject(projectId)
  if (!project) return { ok: false, error: 'project not found' }

  const since = Date.now() - KIND_LOOKBACK_MS[kind]
  const activities = listActivity(projectId, { since, limit: 200 })
  const fp = fingerprint(activities)

  const picked = await pickModel(project.modelOverride)
  if (!picked) {
    const body = stubSummary(activities, kind)
    recordSummary({ projectId, kind, body, modelUsed: 'stub', sourceFingerprint: fp })
    if (kind === 'status') updateProject(projectId, { summary: body })
    return { ok: true, summary: body, cached: false }
  }

  const systemPrompt = [
    `You are an assistant that writes concise, actionable ${KIND_HEADER[kind].toLowerCase()} for software projects.`,
    'Read the JSON list of recent project activity and produce 4-8 short bullet points.',
    'Group by theme (PRs, issues, discussions, decisions). Highlight blockers, risks, and asks.',
    'Be neutral and specific. No em-dashes. No filler. Markdown allowed.',
  ].join(' ')

  const userPayload = JSON.stringify({
    project: { name: project.name, description: project.description, status: project.status },
    timeframe: KIND_HEADER[kind],
    activity: activities.map(a => ({
      ts: new Date(a.ts).toISOString(),
      app: a.sourceApp,
      kind: a.sourceKind,
      title: a.title,
      actor: a.actor,
      url: a.url,
    })),
  })

  try {
    const provider = getProvider(picked.model)
    let raw = ''
    for await (const event of provider.stream({
      model: picked.model,
      systemPrompt,
      messages: [{ role: 'user', content: userPayload }],
      tools: [],
      maxTokens: 600,
      apiKeyOverride: picked.apiKeyOverride,
    })) {
      if (event.type === 'text_delta') raw += event.content
    }
    const body = raw.trim() || stubSummary(activities, kind)
    recordSummary({ projectId, kind, body, modelUsed: picked.model, sourceFingerprint: fp })
    if (kind === 'status') updateProject(projectId, { summary: body })
    return { ok: true, summary: body }
  } catch (err) {
    const body = stubSummary(activities, kind)
    recordSummary({ projectId, kind, body, modelUsed: 'stub', sourceFingerprint: fp })
    return { ok: false, error: (err as Error).message, summary: body }
  }
}

// ─── health / risk ──────────────────────────────────────────────────────────

export interface HealthReport {
  healthScore: number               // 0–100
  riskLevel: 'low' | 'medium' | 'high' | 'critical'
  signals: { label: string; weight: number; positive: boolean; detail?: string }[]
}

export function computeHealthAndRisk(projectId: string): HealthReport {
  const project = getProject(projectId)
  if (!project) return { healthScore: 0, riskLevel: 'critical', signals: [] }

  const now = Date.now()
  const oneDay = 24 * 60 * 60 * 1000
  const since = now - 14 * oneDay
  const activity = listActivity(projectId, { since, limit: 500 })
  const resources = listResources(projectId)
  const risks = listRisks(projectId).filter(r => r.status === 'open' || r.status === 'mitigating')

  const signals: HealthReport['signals'] = []
  let score = 70 // neutral baseline

  // signal 1: recency of activity
  const lastActivityTs = activity[0]?.ts ?? 0
  const ageDays = lastActivityTs ? (now - lastActivityTs) / oneDay : 999
  if (lastActivityTs === 0) {
    signals.push({ label: 'No activity in 14 days', weight: -25, positive: false })
    score -= 25
  } else if (ageDays > 5) {
    signals.push({ label: `Last activity ${Math.round(ageDays)} days ago`, weight: -10, positive: false })
    score -= 10
  } else {
    signals.push({ label: 'Active in the last few days', weight: 10, positive: true })
    score += 10
  }

  // signal 2: PR / issue throughput
  const prs = activity.filter(a => a.sourceKind === 'pull_request' || a.sourceKind.startsWith('pr.'))
  const issues = activity.filter(a => a.sourceKind === 'issue' || a.sourceKind.startsWith('issue.'))
  if (prs.length >= 3) {
    signals.push({ label: `${prs.length} PR events in 14d`, weight: 8, positive: true })
    score += 8
  }
  if (issues.length > prs.length * 3 && issues.length > 5) {
    signals.push({ label: 'Issue volume far exceeds PR throughput', weight: -10, positive: false })
    score -= 10
  }

  // signal 3: open risks
  if (risks.some(r => r.severity === 'critical')) {
    signals.push({ label: 'Critical risk open', weight: -25, positive: false })
    score -= 25
  } else if (risks.some(r => r.severity === 'high')) {
    signals.push({ label: 'High-severity risk open', weight: -12, positive: false })
    score -= 12
  }

  // signal 4: connected resources
  if (resources.length === 0) {
    signals.push({ label: 'No tracked resources', weight: -15, positive: false, detail: 'Add a Slack channel, repo, or Jira project to enable live updates.' })
    score -= 15
  } else if (resources.length >= 3) {
    signals.push({ label: `${resources.length} resources connected`, weight: 5, positive: true })
    score += 5
  }

  score = Math.max(0, Math.min(100, score))
  const riskLevel: HealthReport['riskLevel'] =
    score >= 80 ? 'low' :
    score >= 60 ? 'medium' :
    score >= 35 ? 'high' :
    'critical'

  // persist score + risk + a metric sample
  updateProject(projectId, { healthScore: score, riskLevel })
  recordMetric(projectId, { metricKey: 'health_score', ts: now, value: score, unit: null })

  return { healthScore: score, riskLevel, signals }
}

// ─── alerts ─────────────────────────────────────────────────────────────────

export interface AlertEvaluationResult {
  fired: { alert: ProjectAlertRow; reason: string }[]
}

const QUIET_PERIOD_MS = 6 * 60 * 60 * 1000

export async function evaluateAlerts(projectId: string): Promise<AlertEvaluationResult> {
  const alerts = listAlerts(projectId).filter(a => a.enabled)
  const fired: AlertEvaluationResult['fired'] = []
  if (!alerts.length) return { fired }

  const now = Date.now()
  const activity = listActivity(projectId, { limit: 500 })

  for (const alert of alerts) {
    if (alert.lastFiredAt && now - alert.lastFiredAt < QUIET_PERIOD_MS) continue
    const reason = checkAlert(alert, activity)
    if (reason) {
      markAlertFired(alert.id, now)
      fired.push({ alert, reason })
    }
  }
  return { fired }
}

function checkAlert(alert: ProjectAlertRow, activity: ProjectActivityRow[]): string | null {
  const now = Date.now()
  const oneDay = 24 * 60 * 60 * 1000
  switch (alert.ruleKind) {
    case 'no_activity': {
      const days = Number((alert.config as { days?: number })?.days ?? 5)
      const last = activity[0]?.ts ?? 0
      const elapsed = (now - last) / oneDay
      if (!last) return `No activity recorded yet`
      if (elapsed >= days) return `No activity for ${Math.round(elapsed)} days (threshold ${days}d)`
      return null
    }
    case 'pr_stale': {
      const hours = Number((alert.config as { hours?: number })?.hours ?? 48)
      const opens = activity.filter(a =>
        a.sourceApp === 'github' && (a.sourceKind === 'pull_request' || a.sourceKind === 'pr.opened')
      )
      for (const pr of opens) {
        if (now - pr.ts > hours * 60 * 60 * 1000) {
          return `${pr.title} — open for ${Math.round((now - pr.ts) / 3600_000)}h`
        }
      }
      return null
    }
    case 'p1_open': {
      const hit = activity.find(a =>
        /(p[01]|priority\/(p?1|critical))/i.test(a.title) || /(p[01]|critical)/i.test(JSON.stringify(a.payload ?? ''))
      )
      return hit ? `P0/P1 mention: ${hit.title}` : null
    }
    default:
      return null
  }
}
