import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

/**
 * WOS keeps user-editable configuration in a dedicated top-level folder
 * (`~/.wos/`) so skills, rules, and MCP definitions are git-able and can
 * be edited with any editor. Secrets (OAuth tokens, API keys, encrypted
 * env vars) remain inside SQLite under `app.getPath('userData')`.
 */

let _wosHome: string | null = null

function getHome(): string {
  // Tests can override via env var.
  return process.env.WOS_HOME ?? path.join(os.homedir(), '.wos')
}

export function wosHome(): string {
  if (_wosHome) return _wosHome
  _wosHome = getHome()
  ensureDir(_wosHome)
  ensureDir(path.join(_wosHome, 'apps'))
  ensureDir(path.join(_wosHome, 'skills'))
  ensureDir(path.join(_wosHome, 'rules'))
  return _wosHome
}

/** @internal Reset the cached home (test-only). */
export function _resetWosHomeForTests(): void {
  _wosHome = null
}

export function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

export function wosSubpath(...segments: string[]): string {
  return path.join(wosHome(), ...segments)
}

export function appDataPath(...segments: string[]): string {
  return path.join(app.getPath('userData'), ...segments)
}

export function mcpConfigPath(): string {
  return wosSubpath('mcp.json')
}

export function skillsDir(): string {
  return wosSubpath('skills')
}

/**
 * Per-agent skills directory: `~/.wos/agents/<agentKey>/skills/`. When an
 * agent (Meeting, Projects, Automation, ...) reads a skill with the same
 * id present both globally and in its own folder, the per-agent copy wins.
 */
export function agentSkillsDir(agentKey: string): string {
  return wosSubpath('agents', agentKey, 'skills')
}

/**
 * Per-agent hooks directory: `~/.wos/agents/<agentKey>/hooks/`. Reserved
 * for future use (per-agent hook overrides).
 */
export function agentHooksDir(agentKey: string): string {
  return wosSubpath('agents', agentKey, 'hooks')
}

export function userRulesDir(): string {
  return wosSubpath('rules')
}

export function pluginsDir(): string {
  return wosSubpath('plugins')
}

/**
 * Per-workspace Cursor-compatible rules directory.
 * Returns null if workspacePath is null or the directory doesn't exist.
 */
export function workspaceRulesDir(workspacePath: string | null): string | null {
  if (!workspacePath) return null
  const d = path.join(workspacePath, '.cursor', 'rules')
  return fs.existsSync(d) ? d : null
}
