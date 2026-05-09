import fs from 'node:fs'
import path from 'node:path'
import matter from 'gray-matter'
import { getDb, schema, notifyWrite } from '../db'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { skillsDir, agentSkillsDir, ensureDir } from '../paths'
import type { Tool } from '../tools'
import { listConnectedAppSkills, getConnectedAppSkillBody } from '../apps/manager'

export interface SkillRecord {
  id: string
  source: 'user' | 'workspace'
  name: string
  description: string
  path: string
  enabled: boolean
  triggers: string[]
  /**
   * If set, this skill is scoped to the given agent key (lives under
   * `~/.wos/agents/<agentKey>/skills/`). When undefined the skill is
   * global (`~/.wos/skills/`).
   */
  agentScope?: string
}

function parseSkill(dir: string): { name: string; description: string; triggers: string[]; body: string } | null {
  const p = path.join(dir, 'SKILL.md')
  if (!fs.existsSync(p)) return null
  try {
    const raw = fs.readFileSync(p, 'utf8')
    const parsed = matter(raw)
    const data = parsed.data as Record<string, unknown>
    const rawTriggers = data.triggers ?? data.keywords ?? []
    const triggers = Array.isArray(rawTriggers)
      ? rawTriggers.map(String)
      : typeof rawTriggers === 'string'
        ? rawTriggers.split(',').map(s => s.trim()).filter(Boolean)
        : []
    return {
      name: (data.name as string) || path.basename(dir),
      description: (data.description as string) || '',
      triggers,
      body: parsed.content,
    }
  } catch (err) {
    console.error('[skills] parse error', p, err)
    return null
  }
}

function listSkillDirs(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) return []
  const out: string[] = []
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const full = path.join(rootDir, entry.name)
    if (fs.existsSync(path.join(full, 'SKILL.md'))) out.push(full)
  }
  return out
}

/** Pack ids that get a per-agent skills folder under `~/.wos/agents/<id>/skills/`. */
const AGENT_SCOPES = ['wos', 'meeting', 'projects', 'automation', 'code'] as const

export function scanSkills(): SkillRecord[] {
  ensureDir(skillsDir())
  const db = getDb()
  const records: SkillRecord[] = []
  const now = new Date()

  type ScanItem = { dir: string; scope: string | null }
  const items: ScanItem[] = []
  for (const dir of listSkillDirs(skillsDir())) items.push({ dir, scope: null })
  for (const scope of AGENT_SCOPES) {
    const root = agentSkillsDir(scope)
    for (const dir of listSkillDirs(root)) items.push({ dir, scope })
  }

  // Upsert each found skill; keep existing `enabled` state.
  for (const { dir, scope } of items) {
    const parsed = parseSkill(dir)
    if (!parsed) continue
    const existing = db.select().from(schema.skills).where(eq(schema.skills.path, dir)).get()
    const id = existing?.id ?? randomUUID()
    const enabled = existing?.enabled ?? true
    if (existing) {
      db.update(schema.skills).set({
        name: parsed.name,
        description: parsed.description,
        triggersJson: parsed.triggers,
        agentScope: scope,
        updatedAt: now,
      }).where(eq(schema.skills.id, id)).run()
    } else {
      db.insert(schema.skills).values({
        id,
        source: 'user',
        name: parsed.name,
        description: parsed.description,
        path: dir,
        enabled: true,
        triggersJson: parsed.triggers,
        agentScope: scope,
        createdAt: now,
        updatedAt: now,
      }).run()
    }
    records.push({
      id,
      source: 'user',
      name: parsed.name,
      description: parsed.description,
      path: dir,
      enabled,
      triggers: parsed.triggers,
      agentScope: scope ?? undefined,
    })
  }

  // Prune rows whose folder is gone.
  const presentPaths = new Set(items.map(i => i.dir))
  for (const row of db.select().from(schema.skills).all()) {
    if (!presentPaths.has(row.path)) {
      db.delete(schema.skills).where(eq(schema.skills.id, row.id)).run()
    }
  }
  notifyWrite()
  return records
}

export function listSkills(): SkillRecord[] {
  const db = getDb()
  return db.select().from(schema.skills).all().map(r => ({
    id: r.id,
    source: r.source as 'user' | 'workspace',
    name: r.name,
    description: r.description,
    path: r.path,
    enabled: !!r.enabled,
    triggers: (r.triggersJson as string[] | null) ?? [],
    agentScope: r.agentScope ?? undefined,
  }))
}

export function setSkillEnabled(id: string, enabled: boolean) {
  const db = getDb()
  db.update(schema.skills).set({ enabled, updatedAt: new Date() }).where(eq(schema.skills.id, id)).run()
  notifyWrite()
}

export function readSkillBody(id: string): { meta: Record<string, unknown>; body: string } | null {
  const db = getDb()
  const row = db.select().from(schema.skills).where(eq(schema.skills.id, id)).get()
  if (!row) return null
  const p = path.join(row.path, 'SKILL.md')
  if (!fs.existsSync(p)) return null
  const parsed = matter(fs.readFileSync(p, 'utf8'))
  return { meta: parsed.data, body: parsed.content }
}

export function createSkill(input: {
  name: string
  description?: string
  body: string
  triggers?: string[]
}): { id: string; dir: string } {
  ensureDir(skillsDir())
  const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'skill'
  const dir = path.join(skillsDir(), slug)
  ensureDir(dir)
  const frontmatter = [
    '---',
    `name: ${JSON.stringify(input.name)}`,
    `description: ${JSON.stringify(input.description ?? '')}`,
    `triggers: ${JSON.stringify(input.triggers ?? [])}`,
    '---',
    '',
  ].join('\n')
  fs.writeFileSync(path.join(dir, 'SKILL.md'), frontmatter + input.body + '\n')
  const records = scanSkills()
  const row = records.find(r => r.path === dir)
  return { id: row?.id ?? '', dir }
}

export function deleteSkill(id: string) {
  const db = getDb()
  const row = db.select().from(schema.skills).where(eq(schema.skills.id, id)).get()
  if (!row) return
  try {
    fs.rmSync(row.path, { recursive: true, force: true })
  } catch (err) {
    console.error('[skills] failed to rm folder', err)
  }
  db.delete(schema.skills).where(eq(schema.skills.id, id)).run()
  notifyWrite()
}

/**
 * Compact index inserted into the system prompt so the model knows what
 * skills exist and what triggers them. Actual skill bodies are pulled via
 * the ReadSkill tool.
 *
 * If `agentKey` is provided, the index is scoped to:
 *   - global skills (agentScope == null), AND
 *   - skills owned by that agent (agentScope == agentKey).
 * Per-agent skills with the same name as a global skill take precedence.
 */
export function buildSkillIndex(agentKey?: string): string {
  let skills = listSkills().filter(s => s.enabled)
  if (agentKey) {
    skills = skills.filter(s => !s.agentScope || s.agentScope === agentKey)
    // Per-agent override: if a per-agent skill shares a name with a
    // global one, drop the global copy.
    const ownedNames = new Set(skills.filter(s => s.agentScope === agentKey).map(s => s.name))
    skills = skills.filter(s => s.agentScope === agentKey || !ownedNames.has(s.name))
  } else {
    // Default behaviour (back-compat): only show global skills in
    // generic contexts where no agent is identified.
    skills = skills.filter(s => !s.agentScope)
  }
  const appSkills = listConnectedAppSkills()
  if (skills.length === 0 && appSkills.length === 0) return ''
  const lines: string[] = []
  if (skills.length > 0) {
    lines.push('## Available skills', '', 'Call the `ReadSkill` tool with an id below when one of the triggers matches.', '')
    for (const s of skills) {
      const trig = s.triggers.length ? ` [triggers: ${s.triggers.join(', ')}]` : ''
      const scope = s.agentScope ? ` (${s.agentScope})` : ''
      lines.push(`- **${s.id.slice(0, 8)}** — ${s.name}${scope}: ${s.description}${trig}`)
    }
  }
  if (appSkills.length > 0) {
    if (lines.length) lines.push('')
    lines.push('## App skills', '', 'Call the `ReadAppSkill` tool with `appId` + `skillId` to load the body.', '')
    for (const s of appSkills) {
      lines.push(`- **${s.appId}/${s.id}** (${s.appName}) — ${s.description}`)
    }
  }
  return lines.join('\n')
}

/** Built-in tool that lets the agent pull a full SKILL.md body on demand. */
export const readSkillTool: Tool = {
  name: 'ReadSkill',
  description: 'Load a Skill by id (first 8 chars of UUID). Returns its SKILL.md body.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'Skill id (first 8 chars are enough).' } },
    required: ['id'],
  },
  async execute(input) {
    const { id } = input as { id: string }
    const skills = listSkills()
    const match = skills.find(s => s.id === id || s.id.startsWith(id))
    if (!match) return { output: '', error: `No skill found for id "${id}"` }
    if (!match.enabled) return { output: '', error: `Skill "${match.name}" is disabled.` }
    const parsed = readSkillBody(match.id)
    if (!parsed) return { output: '', error: 'Skill file is missing on disk.' }
    return { output: `# ${match.name}\n\n${parsed.body}` }
  },
}

/** Built-in tool that loads an app-declared skill body. */
export const readAppSkillTool: Tool = {
  name: 'ReadAppSkill',
  description: 'Load an app-declared skill body (e.g. "github/post-update"). Returns markdown.',
  inputSchema: {
    type: 'object',
    properties: {
      appId: { type: 'string', description: 'App id, e.g. "github", "slack".' },
      skillId: { type: 'string', description: 'Skill id within that app.' },
    },
    required: ['appId', 'skillId'],
  },
  async execute(input) {
    const { appId, skillId } = input as { appId: string; skillId: string }
    const body = getConnectedAppSkillBody(appId, skillId)
    if (!body) return { output: '', error: `App skill "${appId}/${skillId}" not found or app not connected.` }
    return { output: body }
  },
}
