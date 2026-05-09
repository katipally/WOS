import { randomUUID } from 'node:crypto'
import { getDb, schema, notifyWrite } from '../db'
import { eq, desc } from 'drizzle-orm'

export type RunStatus = 'running' | 'success' | 'error' | 'cancelled' | 'dryrun'

export interface AuditRunRow {
  id: string
  automationId: string
  startedAt: Date
  endedAt: Date | null
  status: RunStatus
  trigger: unknown
  toolCalls: unknown
  output: string | null
  error: string | null
  scratchDir: string | null
}

export const audit = {
  startRun(automationId: string, trigger: unknown, scratchDir: string | null): string {
    const db = getDb()
    const id = randomUUID()
    db.insert(schema.automationRuns).values({
      id,
      automationId,
      startedAt: new Date(),
      status: 'running',
      trigger: JSON.stringify(trigger ?? null),
      toolCalls: JSON.stringify([]),
      scratchDir,
    } as unknown as typeof schema.automationRuns.$inferInsert).run()
    notifyWrite()
    return id
  },

  endRun(
    runId: string,
    status: RunStatus,
    output: string | null,
    error: string | null,
    toolCalls: unknown[] = [],
  ): void {
    const db = getDb()
    db.update(schema.automationRuns)
      .set({
        endedAt: new Date(),
        status,
        output,
        error,
        toolCalls: JSON.stringify(toolCalls ?? []),
      })
      .where(eq(schema.automationRuns.id, runId))
      .run()
    notifyWrite()
  },

  get(runId: string): AuditRunRow | undefined {
    const db = getDb()
    const row = db.select().from(schema.automationRuns)
      .where(eq(schema.automationRuns.id, runId))
      .get() as typeof schema.automationRuns.$inferSelect | undefined
    if (!row) return undefined
    return {
      id: row.id,
      automationId: row.automationId,
      startedAt: row.startedAt,
      endedAt: row.endedAt ?? null,
      status: row.status as RunStatus,
      trigger: typeof row.trigger === 'string' ? safeParse(row.trigger as string) : row.trigger,
      toolCalls: typeof row.toolCalls === 'string' ? safeParse(row.toolCalls as string) : row.toolCalls,
      output: row.output ?? null,
      error: row.error ?? null,
      scratchDir: row.scratchDir ?? null,
    }
  },

  list(automationId?: string, limit = 100): AuditRunRow[] {
    const db = getDb()
    let q = db.select().from(schema.automationRuns).$dynamic()
    if (automationId) q = q.where(eq(schema.automationRuns.automationId, automationId))
    const rows = q.orderBy(desc(schema.automationRuns.startedAt)).limit(limit).all()
    return rows.map(r => ({
      id: r.id,
      automationId: r.automationId,
      startedAt: r.startedAt,
      endedAt: r.endedAt ?? null,
      status: r.status as RunStatus,
      trigger: typeof r.trigger === 'string' ? safeParse(r.trigger) : r.trigger,
      toolCalls: typeof r.toolCalls === 'string' ? safeParse(r.toolCalls) : r.toolCalls,
      output: r.output ?? null,
      error: r.error ?? null,
      scratchDir: r.scratchDir ?? null,
    }))
  },
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s) } catch { return s }
}
