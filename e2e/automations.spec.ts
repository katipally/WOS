/**
 * d3: automations — DB schema and the 3 supported kinds.
 *
 * Covers (post-OpenClaw rebuild):
 *   - The automations table has the expected schema columns
 *   - All 3 AutomationKind values (`schedule`, `hook`, `webhook`) can be
 *     inserted directly via SQL
 *
 * The chat-driven `automation_create` tool is exercised by unit tests in
 * `electron/main/automations/__tests__/` (vitest); this file focuses on
 * schema correctness only.
 */

import { test, expect } from '@playwright/test'
import { withStub, stubPath } from './harness/withStub'

const ALL_AUTOMATION_KINDS = ['schedule', 'hook', 'webhook'] as const

test('d3: all AutomationKind values can be inserted directly into DB', async () => {
  const { wos, db } = await withStub({ scriptPath: stubPath('simple-reply.json') })
  try {
    for (const kind of ALL_AUTOMATION_KINDS) {
      const config = getDefaultConfig(kind)
      const nowMs = Date.now()
      await db.queryAll(`
        INSERT OR REPLACE INTO automations
          (id, kind, name, description, enabled, prompt, tools_allow, config, result_delivery, created_at, updated_at)
        VALUES
          ('e2e-${kind}', '${kind}', 'E2E ${kind} test', 'Inserted by E2E', 1, 'Do ${kind} stuff', '[]', '${JSON.stringify(config)}', 'silent', ${nowMs}, ${nowMs})
      `)
    }

    const rows = await db.queryAll<{ kind: string; name: string }>(
      `SELECT kind, name FROM automations WHERE id LIKE 'e2e-%' ORDER BY kind`,
    )
    expect(rows).toHaveLength(ALL_AUTOMATION_KINDS.length)

    const kinds = rows.map((r) => r.kind).sort()
    expect(kinds).toEqual([...ALL_AUTOMATION_KINDS].sort())
  } finally {
    db.close()
    await wos.close()
  }
})

test('d3: automations table has expected schema columns', async () => {
  const { wos, db } = await withStub({ scriptPath: stubPath('simple-reply.json') })
  try {
    const cols = await db.queryAll<{ name: string }>(
      `SELECT name FROM pragma_table_info('automations') ORDER BY name`,
    )
    const colNames = cols.map((c) => c.name)
    for (const col of ['id', 'kind', 'name', 'enabled', 'prompt', 'tools_allow', 'config', 'result_delivery', 'created_at', 'updated_at']) {
      expect(colNames).toContain(col)
    }
  } finally {
    db.close()
    await wos.close()
  }
})

// --- helpers ---

function getDefaultConfig(kind: (typeof ALL_AUTOMATION_KINDS)[number]): Record<string, unknown> {
  switch (kind) {
    case 'schedule': return { mode: 'cron', cron: '0 9 * * *', tz: 'UTC' }
    case 'hook':     return { event: 'app:connected' }
    case 'webhook':  return { slug: 'e2e-test' }
  }
}
