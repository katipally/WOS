/**
 * Projects manager: per-entity ledger ops (resources, activity, widgets,
 * summaries, alerts, risks, decisions, metrics).
 *
 * Project-table CRUD lives in `./crud.ts` and is re-exported from this module
 * for back-compat — callers can keep importing from `./manager`.
 *
 * Pure thin layer over the SQLite schema. All time fields stored as unix-ms
 * integers (consistent with neighbouring modules using `runRaw`/`queryRaw`).
 */

import { randomUUID } from 'node:crypto'
import { runRaw, queryRaw, notifyWrite } from '../db'
import type {
  ProjectResourceRow,
  ProjectResourceInput,
  ProjectActivityRow,
  ProjectWidgetRow,
  ProjectSummaryRow,
  ProjectAlertRow,
  ProjectRiskRow,
  ProjectDecisionRow,
  ProjectMetricSample,
} from './types'
import { parseJson } from './_helpers'
import { getProject } from './crud'

// Re-export project CRUD so call sites that import from `./manager` keep working.
export {
  listProjects,
  getProject,
  getProjectBySlug,
  findProjectsByName,
  createProject,
  updateProject,
  deleteProject,
  setProjectStatus,
  setProjectPinned,
} from './crud'

// ─── resources ──────────────────────────────────────────────────────────────

type RawResource = {
  id: string
  project_id: string
  kind: string
  ref: string
  label: string
  description: string | null
  added_at: number
  last_fetched_at: number | null
  refresh_interval_sec: number | null

  [key: string]: unknown
}

function resourceFromRow(r: RawResource): ProjectResourceRow {
  return {
    id: r.id,
    projectId: r.project_id,
    kind: r.kind,
    ref: parseJson<unknown>(r.ref, null),
    label: r.label,
    description: r.description,
    addedAt: r.added_at,
    lastFetchedAt: r.last_fetched_at,
    refreshIntervalSec: r.refresh_interval_sec,
  }
}

export function listResources(projectId: string): ProjectResourceRow[] {
  const rows = queryRaw<RawResource>(
    'SELECT * FROM project_resources WHERE project_id = ? ORDER BY added_at ASC',
    [projectId]
  )
  return rows.map(resourceFromRow)
}

export function findResourceById(resourceId: string): ProjectResourceRow | null {
  const rows = queryRaw<RawResource>('SELECT * FROM project_resources WHERE id = ?', [resourceId])
  if (rows.length === 0) return null
  return resourceFromRow(rows[0])
}

export function addResource(projectId: string, input: ProjectResourceInput): ProjectResourceRow {
  if (!getProject(projectId)) throw new Error(`Project ${projectId} not found`)
  const id = randomUUID()
  const now = Date.now()
  runRaw(
    `INSERT INTO project_resources (id, project_id, kind, ref, label, description, added_at, refresh_interval_sec)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      projectId,
      input.kind,
      JSON.stringify(input.ref ?? null),
      input.label,
      input.description ?? null,
      now,
      input.refreshIntervalSec ?? null,
    ]
  )
  notifyWrite()
  const rows = queryRaw<RawResource>('SELECT * FROM project_resources WHERE id = ?', [id])
  return resourceFromRow(rows[0]!)
}

export function removeResource(resourceId: string): void {
  runRaw('DELETE FROM project_resources WHERE id = ?', [resourceId])
  notifyWrite()
}

export function markResourceFetched(resourceId: string, ts: number = Date.now()): void {
  runRaw('UPDATE project_resources SET last_fetched_at = ? WHERE id = ?', [ts, resourceId])
  notifyWrite()
}

// ─── activity ───────────────────────────────────────────────────────────────

type RawActivity = {
  id: string
  project_id: string
  source_app: string
  source_kind: string
  ts: number
  actor: string | null
  title: string
  url: string | null
  payload_json: string | null
  dedupe_key: string

  [key: string]: unknown
}

function activityFromRow(r: RawActivity): ProjectActivityRow {
  return {
    id: r.id,
    projectId: r.project_id,
    sourceApp: r.source_app,
    sourceKind: r.source_kind,
    ts: r.ts,
    actor: r.actor,
    title: r.title,
    url: r.url,
    payload: parseJson<unknown>(r.payload_json, null),
    dedupeKey: r.dedupe_key,
  }
}

export function listActivity(projectId: string, opts: { since?: number; limit?: number } = {}): ProjectActivityRow[] {
  const params: (string | number)[] = [projectId]
  let where = 'WHERE project_id = ?'
  if (typeof opts.since === 'number') { where += ' AND ts >= ?'; params.push(opts.since) }
  const limit = Math.max(1, Math.min(500, opts.limit ?? 100))
  const rows = queryRaw<RawActivity>(
    `SELECT * FROM project_activity ${where} ORDER BY ts DESC LIMIT ${limit}`,
    params
  )
  return rows.map(activityFromRow)
}

export interface ActivityInput {
  projectId: string
  sourceApp: string
  sourceKind: string
  ts: number
  actor?: string | null
  title: string
  url?: string | null
  payload?: unknown
  dedupeKey: string
}

export function recordActivity(input: ActivityInput): ProjectActivityRow | null {
  // INSERT OR IGNORE — dedupe_key uniqueness prevents duplicates from
  // overlapping refresh windows or webhook retries.
  const id = randomUUID()
  runRaw(
    `INSERT OR IGNORE INTO project_activity
       (id, project_id, source_app, source_kind, ts, actor, title, url, payload_json, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.projectId,
      input.sourceApp,
      input.sourceKind,
      input.ts,
      input.actor ?? null,
      input.title,
      input.url ?? null,
      input.payload != null ? JSON.stringify(input.payload) : null,
      input.dedupeKey,
    ]
  )
  notifyWrite()
  const rows = queryRaw<RawActivity>(
    'SELECT * FROM project_activity WHERE project_id = ? AND dedupe_key = ?',
    [input.projectId, input.dedupeKey]
  )
  return rows[0] ? activityFromRow(rows[0]) : null
}

// ─── widgets ────────────────────────────────────────────────────────────────

type RawWidget = {
  id: string
  project_id: string
  tab: string
  widget_kind: string
  config_json: string | null
  x: number
  y: number
  w: number
  h: number
  hidden: number
  sort: number

  [key: string]: unknown
}

function widgetFromRow(r: RawWidget): ProjectWidgetRow {
  return {
    id: r.id,
    projectId: r.project_id,
    tab: r.tab,
    widgetKind: r.widget_kind,
    config: parseJson<Record<string, unknown> | null>(r.config_json, null),
    x: r.x,
    y: r.y,
    w: r.w,
    h: r.h,
    hidden: !!r.hidden,
    sort: r.sort,
  }
}

export function listWidgets(projectId: string): ProjectWidgetRow[] {
  const rows = queryRaw<RawWidget>(
    'SELECT * FROM project_widgets WHERE project_id = ? ORDER BY tab ASC, sort ASC, y ASC, x ASC',
    [projectId]
  )
  return rows.map(widgetFromRow)
}

export interface WidgetInput {
  tab: string
  widgetKind: string
  config?: Record<string, unknown> | null
  x?: number; y?: number; w?: number; h?: number
  sort?: number
  hidden?: boolean
}

export function addWidget(projectId: string, input: WidgetInput): ProjectWidgetRow {
  const id = randomUUID()
  runRaw(
    `INSERT INTO project_widgets (id, project_id, tab, widget_kind, config_json, x, y, w, h, hidden, sort)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      projectId,
      input.tab,
      input.widgetKind,
      input.config ? JSON.stringify(input.config) : null,
      input.x ?? 0, input.y ?? 0, input.w ?? 4, input.h ?? 3,
      input.hidden ? 1 : 0, input.sort ?? 0,
    ]
  )
  notifyWrite()
  return widgetFromRow(
    queryRaw<RawWidget>('SELECT * FROM project_widgets WHERE id = ?', [id])[0]!
  )
}

export function updateWidget(widgetId: string, patch: Partial<WidgetInput>): void {
  const fields: string[] = []
  const params: (string | number | null)[] = []
  if (patch.config !== undefined) { fields.push('config_json = ?'); params.push(patch.config ? JSON.stringify(patch.config) : null) }
  if (patch.x !== undefined) { fields.push('x = ?'); params.push(patch.x) }
  if (patch.y !== undefined) { fields.push('y = ?'); params.push(patch.y) }
  if (patch.w !== undefined) { fields.push('w = ?'); params.push(patch.w) }
  if (patch.h !== undefined) { fields.push('h = ?'); params.push(patch.h) }
  if (patch.hidden !== undefined) { fields.push('hidden = ?'); params.push(patch.hidden ? 1 : 0) }
  if (patch.sort !== undefined) { fields.push('sort = ?'); params.push(patch.sort) }
  if (!fields.length) return
  runRaw(`UPDATE project_widgets SET ${fields.join(', ')} WHERE id = ?`, [...params, widgetId])
  notifyWrite()
}

export function removeWidget(widgetId: string): void {
  runRaw('DELETE FROM project_widgets WHERE id = ?', [widgetId])
  notifyWrite()
}

// ─── summaries ──────────────────────────────────────────────────────────────

type RawSummary = {
  id: string
  project_id: string
  kind: string
  body: string
  model_used: string | null
  generated_at: number
  source_fingerprint: string | null

  [key: string]: unknown
}

function summaryFromRow(r: RawSummary): ProjectSummaryRow {
  return {
    id: r.id,
    projectId: r.project_id,
    kind: r.kind,
    body: r.body,
    modelUsed: r.model_used,
    generatedAt: r.generated_at,
    sourceFingerprint: r.source_fingerprint,
  }
}

export function getLatestSummary(projectId: string, kind: string): ProjectSummaryRow | null {
  const rows = queryRaw<RawSummary>(
    `SELECT * FROM project_summaries WHERE project_id = ? AND kind = ?
       ORDER BY generated_at DESC LIMIT 1`,
    [projectId, kind]
  )
  return rows[0] ? summaryFromRow(rows[0]) : null
}

export function recordSummary(input: {
  projectId: string
  kind: string
  body: string
  modelUsed?: string | null
  sourceFingerprint?: string | null
}): ProjectSummaryRow {
  const id = randomUUID()
  const now = Date.now()
  runRaw(
    `INSERT INTO project_summaries (id, project_id, kind, body, model_used, generated_at, source_fingerprint)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, input.projectId, input.kind, input.body, input.modelUsed ?? null, now, input.sourceFingerprint ?? null]
  )
  notifyWrite()
  // Keep only the last 20 of each kind to bound storage.
  runRaw(
    `DELETE FROM project_summaries
       WHERE project_id = ? AND kind = ?
       AND id NOT IN (
         SELECT id FROM project_summaries WHERE project_id = ? AND kind = ?
           ORDER BY generated_at DESC LIMIT 20
       )`,
    [input.projectId, input.kind, input.projectId, input.kind]
  )
  return getLatestSummary(input.projectId, input.kind)!
}

// ─── alerts ─────────────────────────────────────────────────────────────────

type RawAlert = {
  id: string
  project_id: string
  rule_kind: string
  config_json: string | null
  enabled: number
  severity: string
  last_fired_at: number | null

  [key: string]: unknown
}

function alertFromRow(r: RawAlert): ProjectAlertRow {
  return {
    id: r.id,
    projectId: r.project_id,
    ruleKind: r.rule_kind,
    config: parseJson<Record<string, unknown> | null>(r.config_json, null),
    enabled: !!r.enabled,
    severity: r.severity as ProjectAlertRow['severity'],
    lastFiredAt: r.last_fired_at,
  }
}

export function listAlerts(projectId: string): ProjectAlertRow[] {
  const rows = queryRaw<RawAlert>(
    'SELECT * FROM project_alerts WHERE project_id = ? ORDER BY id ASC',
    [projectId]
  )
  return rows.map(alertFromRow)
}

export function addAlert(projectId: string, input: {
  ruleKind: string
  config?: Record<string, unknown> | null
  enabled?: boolean
  severity?: ProjectAlertRow['severity']
}): ProjectAlertRow {
  const id = randomUUID()
  runRaw(
    `INSERT INTO project_alerts (id, project_id, rule_kind, config_json, enabled, severity)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id,
      projectId,
      input.ruleKind,
      input.config ? JSON.stringify(input.config) : null,
      input.enabled === false ? 0 : 1,
      input.severity ?? 'important',
    ]
  )
  notifyWrite()
  return alertFromRow(
    queryRaw<RawAlert>('SELECT * FROM project_alerts WHERE id = ?', [id])[0]!
  )
}

export function removeAlert(alertId: string): void {
  runRaw('DELETE FROM project_alerts WHERE id = ?', [alertId])
  notifyWrite()
}

export function setAlertEnabled(alertId: string, enabled: boolean): void {
  runRaw('UPDATE project_alerts SET enabled = ? WHERE id = ?', [enabled ? 1 : 0, alertId])
  notifyWrite()
}

export function markAlertFired(alertId: string, ts: number = Date.now()): void {
  runRaw('UPDATE project_alerts SET last_fired_at = ? WHERE id = ?', [ts, alertId])
  notifyWrite()
}

// ─── risks / decisions ──────────────────────────────────────────────────────

type RawRisk = {
  id: string
  project_id: string
  title: string
  description: string | null
  severity: string
  status: string
  owner: string | null
  mitigation: string | null
  created_at: number
  resolved_at: number | null

  [key: string]: unknown
}

function riskFromRow(r: RawRisk): ProjectRiskRow {
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    description: r.description,
    severity: r.severity as ProjectRiskRow['severity'],
    status: r.status as ProjectRiskRow['status'],
    owner: r.owner,
    mitigation: r.mitigation,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  }
}

export function listRisks(projectId: string): ProjectRiskRow[] {
  const rows = queryRaw<RawRisk>(
    'SELECT * FROM project_risks WHERE project_id = ? ORDER BY created_at DESC',
    [projectId]
  )
  return rows.map(riskFromRow)
}

export function addRisk(projectId: string, input: Omit<ProjectRiskRow, 'id' | 'projectId' | 'createdAt' | 'resolvedAt'>): ProjectRiskRow {
  const id = randomUUID()
  const now = Date.now()
  runRaw(
    `INSERT INTO project_risks (id, project_id, title, description, severity, status, owner, mitigation, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, projectId, input.title, input.description, input.severity, input.status, input.owner, input.mitigation, now]
  )
  notifyWrite()
  return riskFromRow(queryRaw<RawRisk>('SELECT * FROM project_risks WHERE id = ?', [id])[0]!)
}

export function removeRisk(riskId: string): void {
  runRaw('DELETE FROM project_risks WHERE id = ?', [riskId])
  notifyWrite()
}

export function updateRisk(riskId: string, patch: {
  title?: string; description?: string | null; severity?: ProjectRiskRow['severity'];
  status?: ProjectRiskRow['status']; owner?: string | null; mitigation?: string | null
}): ProjectRiskRow | null {
  const rows = queryRaw<RawRisk>('SELECT * FROM project_risks WHERE id = ?', [riskId])
  if (!rows.length) return null
  const cur = rows[0]!
  runRaw(
    `UPDATE project_risks SET title=?, description=?, severity=?, status=?, owner=?, mitigation=? WHERE id=?`,
    [
      patch.title ?? cur.title,
      patch.description !== undefined ? patch.description : cur.description,
      patch.severity ?? cur.severity,
      patch.status ?? cur.status,
      patch.owner !== undefined ? patch.owner : cur.owner,
      patch.mitigation !== undefined ? patch.mitigation : cur.mitigation,
      riskId,
    ]
  )
  notifyWrite()
  return riskFromRow(queryRaw<RawRisk>('SELECT * FROM project_risks WHERE id = ?', [riskId])[0]!)
}

type RawDecision = {
  id: string
  project_id: string
  title: string
  body: string | null
  decided_at: number
  decided_by: string | null
  linked_activity_id: string | null

  [key: string]: unknown
}

function decisionFromRow(r: RawDecision): ProjectDecisionRow {
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    body: r.body,
    decidedAt: r.decided_at,
    decidedBy: r.decided_by,
    linkedActivityId: r.linked_activity_id,
  }
}

export function listDecisions(projectId: string): ProjectDecisionRow[] {
  const rows = queryRaw<RawDecision>(
    'SELECT * FROM project_decisions WHERE project_id = ? ORDER BY decided_at DESC',
    [projectId]
  )
  return rows.map(decisionFromRow)
}

export function addDecision(projectId: string, input: { title: string; body?: string | null; decidedBy?: string | null; linkedActivityId?: string | null }): ProjectDecisionRow {
  const id = randomUUID()
  const now = Date.now()
  runRaw(
    `INSERT INTO project_decisions (id, project_id, title, body, decided_at, decided_by, linked_activity_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, projectId, input.title, input.body ?? null, now, input.decidedBy ?? null, input.linkedActivityId ?? null]
  )
  notifyWrite()
  return decisionFromRow(queryRaw<RawDecision>('SELECT * FROM project_decisions WHERE id = ?', [id])[0]!)
}

export function removeDecision(decisionId: string): void {
  runRaw('DELETE FROM project_decisions WHERE id = ?', [decisionId])
  notifyWrite()
}

export function updateDecision(decisionId: string, patch: {
  title?: string; body?: string | null; decidedBy?: string | null
}): ProjectDecisionRow | null {
  const rows = queryRaw<RawDecision>('SELECT * FROM project_decisions WHERE id = ?', [decisionId])
  if (!rows.length) return null
  const cur = rows[0]!
  runRaw(
    `UPDATE project_decisions SET title=?, body=?, decided_by=? WHERE id=?`,
    [
      patch.title ?? cur.title,
      patch.body !== undefined ? patch.body : cur.body,
      patch.decidedBy !== undefined ? patch.decidedBy : cur.decided_by,
      decisionId,
    ]
  )
  notifyWrite()
  return decisionFromRow(queryRaw<RawDecision>('SELECT * FROM project_decisions WHERE id = ?', [decisionId])[0]!)
}

// ─── metrics ────────────────────────────────────────────────────────────────

export function recordMetric(projectId: string, sample: ProjectMetricSample): void {
  runRaw(
    `INSERT OR REPLACE INTO project_metrics (project_id, metric_key, ts, value, unit)
     VALUES (?, ?, ?, ?, ?)`,
    [projectId, sample.metricKey, sample.ts, sample.value, sample.unit]
  )
  notifyWrite()
}

export function listMetric(projectId: string, metricKey: string, opts: { since?: number; limit?: number } = {}): ProjectMetricSample[] {
  const params: (string | number)[] = [projectId, metricKey]
  let where = 'WHERE project_id = ? AND metric_key = ?'
  if (typeof opts.since === 'number') { where += ' AND ts >= ?'; params.push(opts.since) }
  const limit = Math.max(1, Math.min(2000, opts.limit ?? 200))
  const rows = queryRaw<{ metric_key: string; ts: number; value: number; unit: string | null }>(
    `SELECT metric_key, ts, value, unit FROM project_metrics ${where} ORDER BY ts ASC LIMIT ${limit}`,
    params
  )
  return rows.map(r => ({ metricKey: r.metric_key, ts: r.ts, value: r.value, unit: r.unit }))
}
