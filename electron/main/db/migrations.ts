/**
 * Versioned database migrations framework.
 *
 * The initial schema is created in `electron/main/db/index.ts` as a series of
 * `CREATE TABLE IF NOT EXISTS` statements followed by inline `ALTER TABLE`
 * patches. That keeps existing installs alive but makes the next round of
 * schema changes ad-hoc and easy to forget.
 *
 * This module introduces a tiny migration runner: each migration is a function
 * that mutates the raw better-sqlite3 database, gated on a monotonically
 * increasing `version` number tracked in the `schema_version` table. New
 * migrations are appended to the `MIGRATIONS` array and run in order;
 * idempotency is guaranteed by the version gate (each migration runs once per
 * install).
 */
import type Database from 'better-sqlite3'

type SqliteDb = Database.Database

export interface Migration {
  version: number
  description: string
  up(db: SqliteDb): void
}

/**
 * Append new migrations to the END of this array. Never edit a published
 * migration's `version` or `up` once it's shipped — write a follow-up instead.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Baseline schema (created by initDatabase()).',
    up() {
      // Intentionally a no-op. The baseline tables are created by the
      // CREATE TABLE IF NOT EXISTS block in initDatabase(), which runs
      // before this migration framework. We just record version=1 so
      // future migrations have a starting point.
    },
  },
  {
    version: 2,
    description: 'Automations: collapse cron+heartbeat into unified schedule kind; drop standing_order and task_flow rows (replaced by Rules + native flows).',
    up(db) {
      // Skip if automations table doesn't exist yet (fresh DB initialised
      // before migrations run, or test fixtures without app schema).
      const hasTable = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='automations'`,
      ).get()
      if (!hasTable) return
      // cron → schedule (mode=cron). Old cfg: { expr, tz?|timezone? }.
      db.exec(`
        UPDATE automations
        SET kind = 'schedule',
            config = json_object(
              'mode', 'cron',
              'cron', json_extract(config, '$.expr'),
              'tz', coalesce(json_extract(config, '$.tz'), json_extract(config, '$.timezone'))
            )
        WHERE kind = 'cron';
      `)
      // heartbeat → schedule (mode=every). Old cfg: { intervalSec, jitterSec? }.
      db.exec(`
        UPDATE automations
        SET kind = 'schedule',
            config = json_object(
              'mode', 'every',
              'every', (json_extract(config, '$.intervalSec') || 's'),
              'jitterSec', json_extract(config, '$.jitterSec')
            )
        WHERE kind = 'heartbeat';
      `)
      // standing_order rows are deleted — Rules feature (~/.wos/rules/*.md)
      // already handles persistent prompt rules.
      db.exec(`DELETE FROM automations WHERE kind = 'standing_order';`)
      // task_flow is now an orchestration concern, not an automation kind.
      db.exec(`DELETE FROM automations WHERE kind = 'task_flow';`)
    },
  },
  {
    version: 3,
    description: 'Projects feature: ensure project tables exist (no-op for fresh DBs since initDatabase() already created them; this version pin lets future migrations target the projects schema).',
    up() {
      // No-op. The CREATE TABLE IF NOT EXISTS block in initDatabase()
      // already creates the projects.* tables on every boot. This entry
      // exists so subsequent migrations can target schema_version >= 3.
    },
  },
  {
    version: 4,
    description: 'Provider instances: backfill provider_instances from legacy api_keys (one row per stored key) so existing installs keep streaming after the multi-instance refactor.',
    up(db) {
      const hasInstances = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='provider_instances'`,
      ).get()
      const hasApiKeys = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='api_keys'`,
      ).get()
      if (!hasInstances || !hasApiKeys) return
      const now = Date.now()
      const rows = db.prepare(
        'SELECT provider, encrypted_key, iv FROM api_keys',
      ).all() as Array<{ provider: string; encrypted_key: string; iv: string }>
      const insert = db.prepare(`
        INSERT OR IGNORE INTO provider_instances
          (id, kind, label, base_url, api_style, encrypted_key, iv,
           models_json, capabilities_json, custom_headers_json, enabled, created_at, updated_at)
        VALUES (?, ?, ?, NULL, ?, ?, ?, '[]', NULL, NULL, 1, ?, ?)
      `)
      for (const r of rows) {
        const kind = r.provider === 'openai' || r.provider === 'anthropic' ? r.provider : 'openai-compatible'
        const apiStyle = kind === 'anthropic' ? null : 'responses'
        insert.run(
          r.provider, // use provider name as id for built-ins so legacy lookups stay stable
          kind,
          r.provider === 'openai' ? 'OpenAI' : r.provider === 'anthropic' ? 'Anthropic' : r.provider,
          apiStyle,
          r.encrypted_key,
          r.iv,
          now,
          now,
        )
      }
    },
  },
  {
    version: 5,
    description: 'Per-agent settings cleanup: configJson is now free-form per agentDef.settingsSchema. Strip the no-longer-meaningful per-row openaiApiKey/anthropicApiKey fields so they cannot mask provider_instances entries.',
    up(db) {
      const hasTable = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='agent_settings'`,
      ).get()
      if (!hasTable) return
      const rows = db.prepare('SELECT agent_key, config_json FROM agent_settings').all() as Array<{ agent_key: string; config_json: string | null }>
      const upd = db.prepare('UPDATE agent_settings SET config_json = ?, updated_at = ? WHERE agent_key = ?')
      for (const r of rows) {
        if (!r.config_json) continue
        try {
          const cfg = JSON.parse(r.config_json) as Record<string, unknown>
          delete cfg.openaiApiKey
          delete cfg.anthropicApiKey
          delete cfg.providerKey
          upd.run(JSON.stringify(cfg), Date.now(), r.agent_key)
        } catch { /* ignore malformed rows */ }
      }
    },
  },
  {
    version: 6,
    description: 'Custom agents table (added in initDatabase baseline; no-op version pin so future migrations can target schema_version >= 6).',
    up() { /* no-op — table is created in initDatabase() */ },
  },
  {
    version: 7,
    description: 'Conversations.agent_key column for per-conversation persona selection. Backfill existing rows to the wos default; ALTER is also tried in initDatabase() for safety.',
    up(db) {
      try { db.exec(`ALTER TABLE conversations ADD COLUMN agent_key TEXT`) } catch { /* already added */ }
      try { db.exec(`UPDATE conversations SET agent_key = 'wos' WHERE agent_key IS NULL`) } catch { /* table missing in bare-bones test fixtures */ }
    },
  },
  {
    version: 8,
    description: 'Drop deprecated agent_settings.inherit_from column (inheritance no longer used).',
    up(db) {
      const hasTable = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='agent_settings'`,
      ).get()
      if (!hasTable) return
      const cols = db.prepare(`PRAGMA table_info(agent_settings)`).all() as Array<{ name: string }>
      if (!cols.some(c => c.name === 'inherit_from')) return
      try {
        db.exec(`ALTER TABLE agent_settings DROP COLUMN inherit_from`)
      } catch {
        // SQLite < 3.35 fallback: rebuild the table without the legacy column.
        db.exec(`
          CREATE TABLE agent_settings_new (
            agent_key TEXT PRIMARY KEY,
            model TEXT,
            mode TEXT,
            system_prompt TEXT,
            config_json TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          INSERT INTO agent_settings_new (agent_key, model, mode, system_prompt, config_json, created_at, updated_at)
            SELECT agent_key, model, mode, system_prompt, config_json, created_at, updated_at FROM agent_settings;
          DROP TABLE agent_settings;
          ALTER TABLE agent_settings_new RENAME TO agent_settings;
        `)
      }
    },
  },
  {
    version: 9,
    description: "Rename agent_settings row from 'automationsSpec' to 'automation' (Settings now exposes a single Automation agent).",
    up(db) {
      const hasTable = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='agent_settings'`,
      ).get()
      if (!hasTable) return
      const existing = db
        .prepare(`SELECT 1 AS x FROM agent_settings WHERE agent_key='automation'`)
        .get() as { x: number } | undefined
      if (existing) {
        // 'automation' already configured — drop the legacy row.
        db.exec(`DELETE FROM agent_settings WHERE agent_key='automationsSpec'`)
      } else {
        db.exec(`UPDATE agent_settings SET agent_key='automation' WHERE agent_key='automationsSpec'`)
      }
    },
  },
  {
    version: 10,
    description: 'Skills: add agent_scope column so a skill can belong to a specific agent pack (~/.wos/agents/<id>/skills/).',
    up(db) {
      const hasTable = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='skills'`,
      ).get()
      if (!hasTable) return
      const cols = db.prepare(`PRAGMA table_info(skills)`).all() as Array<{ name: string }>
      if (!cols.some(c => c.name === 'agent_scope')) {
        db.exec(`ALTER TABLE skills ADD COLUMN agent_scope TEXT`)
      }
    },
  },
]

function ensureSchemaVersionTable(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL,
      description TEXT
    );
  `)
}

function getCurrentVersion(db: SqliteDb): number {
  ensureSchemaVersionTable(db)
  const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null } | undefined
  return row?.v ?? 0
}

/**
 * Run any pending migrations against the given better-sqlite3 database.
 * Returns the version the database is at when the call returns.
 */
export function runMigrations(db: SqliteDb): number {
  ensureSchemaVersionTable(db)
  const current = getCurrentVersion(db)
  const pending = MIGRATIONS.filter(m => m.version > current).sort((a, b) => a.version - b.version)
  const insert = db.prepare(
    'INSERT INTO schema_version (version, applied_at, description) VALUES (?, ?, ?)',
  )
  for (const m of pending) {
    m.up(db)
    insert.run(m.version, Date.now(), m.description)
  }
  return getCurrentVersion(db)
}
