/**
 * d2: apps-context — app_context_snapshots can be seeded and queried via the harness DB.
 *
 * Covers:
 *   - harnessDb can INSERT into app_context_snapshots (bypasses the real app connector)
 *   - Seeded rows survive a query — the DB schema is correct
 *   - The context is available to the app during a run (basic read-back check)
 */

import { test, expect } from '@playwright/test'
import { withStub, stubPath } from './harness/withStub'
import { dumpState } from './harness/artifacts'

test('d2: app_context_snapshots can be seeded via harnessDb', async () => {
  const { wos, db } = await withStub({ scriptPath: stubPath('simple-reply.json') })
  try {
    const now = Date.now()

    // Seed a Slack channel snapshot.
    await db.queryAll(`
      INSERT OR REPLACE INTO app_context_snapshots (app_id, scope, data_json, fetched_at)
      VALUES (
        'slack',
        'channels',
        '[{"id":"C001","name":"general"},{"id":"C002","name":"engineering"}]',
        ${now}
      )
    `)

    // Seed a GitHub repos snapshot.
    await db.queryAll(`
      INSERT OR REPLACE INTO app_context_snapshots (app_id, scope, data_json, fetched_at)
      VALUES (
        'github',
        'repos',
        '[{"full_name":"org/repo1","description":"Main repo"},{"full_name":"org/repo2","description":"Lib"}]',
        ${now}
      )
    `)

    // Verify both rows are queryable.
    const rows = await db.queryAll<{ appId: string; scope: string; fetchedAt: number }>(
      `SELECT app_id as appId, scope, fetched_at as fetchedAt FROM app_context_snapshots ORDER BY app_id, scope`,
    )
    expect(rows.length).toBe(2)
    expect(rows[0].appId).toBe('github')
    expect(rows[0].scope).toBe('repos')
    expect(rows[1].appId).toBe('slack')
    expect(rows[1].scope).toBe('channels')

    // fetchedAt round-trips correctly.
    expect(rows[0].fetchedAt).toBe(now)

    await dumpState(wos.window, wos, 'd2-snapshot-seeded')
  } finally {
    db.close()
    await wos.close()
  }
})

test('d2: snapshot data is parseable JSON', async () => {
  const { wos, db } = await withStub({ scriptPath: stubPath('simple-reply.json') })
  try {
    const channels = [
      { id: 'C001', name: 'general' },
      { id: 'C002', name: 'engineering' },
    ]
    await db.queryAll(`
      INSERT OR REPLACE INTO app_context_snapshots (app_id, scope, data_json, fetched_at)
      VALUES ('slack', 'channels', '${JSON.stringify(channels)}', ${Date.now()})
    `)

    const row = await db.queryOne<{ data: string }>(
      `SELECT data_json as data FROM app_context_snapshots WHERE app_id='slack' AND scope='channels'`,
    )
    expect(row).toBeDefined()
    const parsed = JSON.parse(row!.data) as Array<{ id: string; name: string }>
    expect(parsed).toHaveLength(2)
    expect(parsed[0].name).toBe('general')
  } finally {
    db.close()
    await wos.close()
  }
})

test('d2: snapshot survives re-launch with same userDataDir', async () => {
  let savedUserDataDir: string
  const now = Date.now()

  {
    const { wos, db } = await withStub({ scriptPath: stubPath('simple-reply.json') })
    savedUserDataDir = wos.userDataDir
    try {
      await db.queryAll(`
        INSERT OR REPLACE INTO app_context_snapshots (app_id, scope, data_json, fetched_at)
        VALUES ('slack', 'channels', '[{"id":"C001","name":"general"}]', ${now})
      `)
    } finally {
      db.close()
      await wos.close()
    }
  }

  // Re-launch with same data dir.
  const { wos: wos2, db: db2 } = await withStub({
    scriptPath: stubPath('simple-reply.json'),
    userDataDir: savedUserDataDir,
  })
  try {
    const row = await db2.queryOne<{ data: string; fetchedAt: number }>(
      `SELECT data_json as data, fetched_at as fetchedAt FROM app_context_snapshots WHERE app_id='slack' AND scope='channels'`,
    )
    expect(row).toBeDefined()
    expect(row!.fetchedAt).toBe(now)
    const parsed = JSON.parse(row!.data) as Array<{ id: string; name: string }>
    expect(parsed[0].id).toBe('C001')
  } finally {
    db2.close()
    await wos2.close()
  }
})

test.skip('d2: context picker UI renders seeded apps [TODO: needs app auth flow]', async () => {
  // TODO: The context picker is only visible when the user connects an app.
  // Without a real OAuth flow or a mocked connection, triggering the @picker UI
  // via the chat composer is not straightforward. Wire up a mock connection row
  // in app_connections and revisit.
})
