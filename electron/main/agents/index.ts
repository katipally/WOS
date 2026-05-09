/**
 * AgentPack registry. Each pack lives at `electron/main/agents/<id>/` and
 * has an `AGENTS.md` file holding the persona (frontmatter + body) plus
 * optional pack-specific tools/skills/hooks folders.
 *
 * The pack layer wraps the legacy `AgentDef` contract — runtime code keeps
 * resolving `AgentDef`, but the persona text now comes from AGENTS.md so
 * users (and humans editing the repo) can read and tweak personas without
 * navigating TypeScript files. Per-agent skills/hooks live under
 * `~/.wos/agents/<id>/skills/` and `~/.wos/agents/<id>/hooks/` and are
 * resolved by the global skills/hooks managers (override-then-fallback).
 */

import fs from 'node:fs'
import path from 'node:path'
import matter from 'gray-matter'
import { agentSkillsDir, ensureDir } from '../paths'

export interface AgentPackManifest {
  id: string
  label?: string
  role?: 'orchestrator' | 'domain' | 'runtime' | string
  acceptedTags?: string[]
  delegatesTo?: string[]
  parallel?: { allow: boolean; maxConcurrency: number }
}

export interface AgentPack {
  id: string
  manifest: AgentPackManifest
  /** Body of AGENTS.md (frontmatter stripped). Used as the persona/system prompt. */
  persona: string
  /** Absolute path to the pack folder on disk. */
  packDir: string
  /** Absolute path to AGENTS.md. */
  manifestPath: string
}

const PACK_IDS = ['wos', 'meeting', 'projects', 'automation', 'code'] as const
export type PackId = (typeof PACK_IDS)[number]

function packsRoot(): string {
  // We resolve relative to this file because the packs ship inside the
  // app bundle, not the user's WOS home.
  return path.resolve(__dirname)
}

function loadPack(id: string): AgentPack | null {
  const packDir = path.join(packsRoot(), id)
  const manifestPath = path.join(packDir, 'AGENTS.md')
  if (!fs.existsSync(manifestPath)) return null
  try {
    const raw = fs.readFileSync(manifestPath, 'utf8')
    const parsed = matter(raw)
    const data = (parsed.data ?? {}) as Record<string, unknown>
    const manifest: AgentPackManifest = {
      id: (data.id as string) ?? id,
      label: data.label as string | undefined,
      role: data.role as string | undefined,
      acceptedTags: Array.isArray(data.acceptedTags) ? data.acceptedTags.map(String) : undefined,
      delegatesTo: Array.isArray(data.delegatesTo) ? data.delegatesTo.map(String) : undefined,
      parallel: (data.parallel as AgentPackManifest['parallel']) ?? undefined,
    }
    return {
      id: manifest.id,
      manifest,
      persona: parsed.content.trim(),
      packDir,
      manifestPath,
    }
  } catch (err) {
    console.error(`[packs] failed to load AGENTS.md for "${id}"`, err)
    return null
  }
}

let CACHE: Map<string, AgentPack> | null = null

/** Copy bundled SKILL.md files from app's agents/<id>/skills/ to
 *  ~/.wos/agents/<id>/skills/. Skips files that already exist so
 *  user edits are never overwritten. */
function seedPackSkills(id: string, packDir: string): void {
  const src = path.join(packDir, 'skills')
  if (!fs.existsSync(src)) return
  const dst = agentSkillsDir(id)
  ensureDir(dst)
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const srcFile = path.join(src, entry.name, 'SKILL.md')
    const dstFile = path.join(dst, entry.name, 'SKILL.md')
    if (!fs.existsSync(srcFile) || fs.existsSync(dstFile)) continue
    fs.mkdirSync(path.dirname(dstFile), { recursive: true })
    fs.copyFileSync(srcFile, dstFile)
  }
}

function loadAll(): Map<string, AgentPack> {
  if (CACHE) return CACHE
  const map = new Map<string, AgentPack>()
  for (const id of PACK_IDS) {
    const packDir = path.join(packsRoot(), id)
    const pack = loadPack(id)
    if (pack) {
      map.set(pack.id, pack)
      seedPackSkills(id, packDir)
    }
  }
  CACHE = map
  return map
}

export function getAgentPack(id: string | undefined | null): AgentPack | undefined {
  if (!id) return undefined
  return loadAll().get(id)
}

export function listAgentPacks(): AgentPack[] {
  return [...loadAll().values()]
}

/** Reset the in-process cache. Used by tests. */
export function _resetPackCache(): void {
  CACHE = null
}
