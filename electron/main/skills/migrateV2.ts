/**
 * Filesystem migration v2 for skills.
 *
 * Pre-v2 layout:
 *   ~/.wos/skills/<id>/SKILL.md   (single global namespace; some skills carried
 *                                 a frontmatter `agent: <packKey>` to mark scope)
 *
 * v2 layout (this file):
 *   ~/.wos/skills/<id>/                 — global, agent-agnostic skills
 *   ~/.wos/agents/<packKey>/skills/<id>/ — per-pack skills
 *
 * This module performs a one-shot move at startup. Skills whose frontmatter
 * has `agent: <packKey>` (matching one of the recognised pack ids) are moved
 * into `~/.wos/agents/<packKey>/skills/<id>/`. All others stay where they are.
 *
 * The migration is idempotent: a sentinel file (`~/.wos/.migration_v2_done`)
 * is written on success and the function short-circuits on subsequent runs.
 *
 * Skipped entirely when `WOS_E2E=1` so the e2e harness can manage its own
 * fixture layout without being mutated.
 */
import fs from 'node:fs'
import path from 'node:path'
import matter from 'gray-matter'
import { skillsDir, agentSkillsDir, wosHome, ensureDir } from '../paths'

const KNOWN_PACKS = new Set(['wos', 'meeting', 'projects', 'automation', 'code'])

function sentinelPath(): string {
  return path.join(wosHome(), '.migration_v2_done')
}

export function isMigrationV2Done(): boolean {
  try {
    return fs.existsSync(sentinelPath())
  } catch {
    return false
  }
}

function writeSentinel(): void {
  try {
    fs.writeFileSync(sentinelPath(), new Date().toISOString())
  } catch (err) {
    console.warn('[skills/migrateV2] failed to write sentinel', err)
  }
}

interface MoveResult {
  moved: Array<{ id: string; from: string; to: string; pack: string }>
  skipped: Array<{ id: string; reason: string }>
}

/**
 * Run the v2 filesystem move. Safe to call on every startup; no-ops once the
 * sentinel exists or when running under the e2e harness.
 */
export function runSkillsMigrationV2(): MoveResult | null {
  if (process.env.WOS_E2E === '1') return null
  if (isMigrationV2Done()) return null

  const root = skillsDir()
  const result: MoveResult = { moved: [], skipped: [] }
  if (!fs.existsSync(root)) {
    writeSentinel()
    return result
  }

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch (err) {
    console.warn('[skills/migrateV2] failed to read skills root', err)
    return null
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const id = entry.name
    const src = path.join(root, id)
    const skillFile = path.join(src, 'SKILL.md')
    if (!fs.existsSync(skillFile)) {
      result.skipped.push({ id, reason: 'no SKILL.md' })
      continue
    }
    let pack: string | null = null
    try {
      const raw = fs.readFileSync(skillFile, 'utf8')
      const parsed = matter(raw)
      const data = parsed.data as Record<string, unknown>
      const candidate = typeof data.agent === 'string' ? data.agent.trim().toLowerCase() : ''
      if (candidate && KNOWN_PACKS.has(candidate)) pack = candidate
    } catch (err) {
      result.skipped.push({ id, reason: `parse error: ${err instanceof Error ? err.message : String(err)}` })
      continue
    }
    if (!pack) continue

    const destRoot = agentSkillsDir(pack)
    ensureDir(destRoot)
    const dest = path.join(destRoot, id)
    if (fs.existsSync(dest)) {
      result.skipped.push({ id, reason: `destination exists: ${dest}` })
      continue
    }

    try {
      fs.renameSync(src, dest)
      result.moved.push({ id, from: src, to: dest, pack })
    } catch (err) {
      result.skipped.push({ id, reason: `move failed: ${err instanceof Error ? err.message : String(err)}` })
    }
  }

  writeSentinel()
  if (result.moved.length > 0) {
    console.log(`[skills/migrateV2] moved ${result.moved.length} skill(s) into per-agent folders`)
  }
  return result
}
