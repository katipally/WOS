/**
 * Projects table CRUD.
 *
 * Pure thin layer over the SQLite `projects` table. All time fields are
 * unix-ms integers. Cascade deletes are issued explicitly so the function
 * works even when PRAGMA foreign_keys is disabled (e.g. in some test contexts).
 *
 * Re-exported from `manager.ts` for back-compat. Prefer importing from
 * `manager.ts` (or `index.ts`) at call sites.
 */

import { randomUUID } from 'node:crypto'
import { runRaw, queryRaw, notifyWrite } from '../db'
import type {
  ProjectRow,
  ProjectInput,
  ProjectStatus,
} from './types'
import { parseJson } from './_helpers'

// ─── helpers ────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'project'
}

function uniqueSlug(base: string): string {
  const taken = new Set(
    queryRaw<{ slug: string }>('SELECT slug FROM projects WHERE slug LIKE ?', [`${base}%`])
      .map(r => r.slug)
  )
  if (!taken.has(base)) return base
  let i = 2
  while (taken.has(`${base}-${i}`)) i++
  return `${base}-${i}`
}

type RawProject = {
  id: string
  name: string
  slug: string
  icon: string | null
  color: string | null
  status: string
  owner_email: string | null
  description: string | null
  summary: string | null
  health_score: number | null
  risk_level: string | null
  model_override: string | null
  pinned: number
  metadata_json: string | null
  created_at: number
  updated_at: number
  archived_at: number | null

  [key: string]: unknown
}

function projectFromRow(r: RawProject): ProjectRow {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    icon: r.icon,
    color: r.color,
    status: r.status as ProjectStatus,
    ownerEmail: r.owner_email,
    description: r.description,
    summary: r.summary,
    healthScore: r.health_score,
    riskLevel: r.risk_level as ProjectRow['riskLevel'],
    modelOverride: r.model_override,
    pinned: !!r.pinned,
    metadata: parseJson<Record<string, unknown> | null>(r.metadata_json, null),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    archivedAt: r.archived_at,
  }
}

// ─── projects CRUD ───────────────────────────────────────────────────────────

export function listProjects(opts: { includeArchived?: boolean } = {}): ProjectRow[] {
  const where = opts.includeArchived ? '' : 'WHERE status != \'archived\''
  const rows = queryRaw<RawProject>(
    `SELECT * FROM projects ${where} ORDER BY pinned DESC, updated_at DESC`
  )
  return rows.map(projectFromRow)
}

export function getProject(id: string): ProjectRow | null {
  const rows = queryRaw<RawProject>('SELECT * FROM projects WHERE id = ?', [id])
  return rows[0] ? projectFromRow(rows[0]) : null
}

export function getProjectBySlug(slug: string): ProjectRow | null {
  const rows = queryRaw<RawProject>('SELECT * FROM projects WHERE slug = ?', [slug])
  return rows[0] ? projectFromRow(rows[0]) : null
}

export function findProjectsByName(query: string): ProjectRow[] {
  const q = `%${query.toLowerCase()}%`
  const rows = queryRaw<RawProject>(
    `SELECT * FROM projects
       WHERE LOWER(name) LIKE ? OR LOWER(slug) LIKE ?
       ORDER BY pinned DESC, updated_at DESC
       LIMIT 20`,
    [q, q]
  )
  return rows.map(projectFromRow)
}

export function createProject(input: ProjectInput): ProjectRow {
  const id = randomUUID()
  const now = Date.now()
  const slug = uniqueSlug(input.slug ? slugify(input.slug) : slugify(input.name))
  runRaw(
    `INSERT INTO projects
       (id, name, slug, icon, color, status, owner_email, description, summary,
        health_score, risk_level, model_override, pinned, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?)`,
    [
      id,
      input.name,
      slug,
      input.icon ?? null,
      input.color ?? null,
      input.status ?? 'draft',
      input.ownerEmail ?? null,
      input.description ?? null,
      input.modelOverride ?? null,
      input.pinned ? 1 : 0,
      input.metadata ? JSON.stringify(input.metadata) : null,
      now,
      now,
    ]
  )
  notifyWrite()
  const row = getProject(id)
  if (!row) throw new Error('Failed to load newly created project')
  return row
}

export function updateProject(id: string, patch: Partial<ProjectInput> & {
  status?: ProjectStatus
  summary?: string | null
  healthScore?: number | null
  riskLevel?: ProjectRow['riskLevel']
}): ProjectRow {
  const cur = getProject(id)
  if (!cur) throw new Error(`Project ${id} not found`)

  const fields: string[] = []
  const params: (string | number | null)[] = []
  const set = (col: string, val: string | number | null) => { fields.push(`${col} = ?`); params.push(val) }

  if (patch.name !== undefined) set('name', patch.name)
  if (patch.slug !== undefined) set('slug', uniqueSlug(slugify(patch.slug)))
  if (patch.icon !== undefined) set('icon', patch.icon ?? null)
  if (patch.color !== undefined) set('color', patch.color ?? null)
  if (patch.status !== undefined) set('status', patch.status)
  if (patch.ownerEmail !== undefined) set('owner_email', patch.ownerEmail ?? null)
  if (patch.description !== undefined) set('description', patch.description ?? null)
  if (patch.summary !== undefined) set('summary', patch.summary)
  if (patch.healthScore !== undefined) set('health_score', patch.healthScore)
  if (patch.riskLevel !== undefined) set('risk_level', patch.riskLevel)
  if (patch.modelOverride !== undefined) set('model_override', patch.modelOverride ?? null)
  if (patch.pinned !== undefined) set('pinned', patch.pinned ? 1 : 0)
  if (patch.metadata !== undefined) set('metadata_json', patch.metadata ? JSON.stringify(patch.metadata) : null)
  if (patch.status === 'archived') set('archived_at', Date.now())

  if (!fields.length) return cur
  set('updated_at', Date.now())
  runRaw(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`, [...params, id])
  notifyWrite()
  return getProject(id)!
}

export function deleteProject(id: string): void {
  for (const table of [
    'project_resources', 'project_widgets', 'project_alerts',
    'project_summaries', 'project_activity', 'project_metrics',
    'project_decisions', 'project_risks',
  ]) {
    runRaw(`DELETE FROM ${table} WHERE project_id = ?`, [id])
  }
  runRaw('DELETE FROM projects WHERE id = ?', [id])
  notifyWrite()
}

export function setProjectStatus(id: string, status: ProjectStatus): ProjectRow {
  return updateProject(id, { status })
}

export function setProjectPinned(id: string, pinned: boolean): ProjectRow {
  return updateProject(id, { pinned })
}
