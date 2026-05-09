import { ipcMain, app, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import { getDb, schema, notifyWrite } from '../db'
import { eq } from 'drizzle-orm'
import {
  listProviderInstances,
  addProviderInstance,
  updateProviderInstance,
  removeProviderInstance,
  refreshProviderModels,
  addManualModel,
  removeManualModel,
  listAllModels,
  getProviderById,
  type AddProviderOptions,
  type UpdateProviderOptions,
} from '../providers'
import { resolveAgent, redactAgentConfig, type AgentConfig } from '../agent/settings'
import { listAgentDefs, listVisibleAgentDefs } from '../agent/agentDefs'

type AgentSettingsUpdate = {
  agentKey: string
  model?: string | null
  mode?: string | null
  systemPrompt?: string | null
  config?: AgentConfig
}

export function registerSettingsHandlers() {
  ipcMain.handle('settings:get', () => {
    const db = getDb()
    const rows = db.select().from(schema.settings).all()
    const result: Record<string, unknown> = {}
    for (const row of rows) {
      try {
        result[row.key] = JSON.parse(row.value as string)
      } catch {
        result[row.key] = row.value
      }
    }
    return result
  })

  ipcMain.handle('settings:set', (_event, { key, value }: { key: string; value: unknown }) => {
    const db = getDb()
    db.insert(schema.settings)
      .values({ key, value: JSON.stringify(value), updatedAt: new Date() })
      .onConflictDoUpdate({
        target: schema.settings.key,
        set: { value: JSON.stringify(value), updatedAt: new Date() },
      })
      .run()
    notifyWrite()
    return { success: true }
  })

  // ── Agents ────────────────────────────────────────────────────────────────

  ipcMain.handle('settings:agents:get', async () => {
    const db = getDb()
    const rows = db.select().from(schema.agentSettings).all()
    const direct = rows.map(row => ({
      agentKey: row.agentKey,
      model: row.model,
      mode: row.mode,
      systemPrompt: row.systemPrompt,
      config: redactAgentConfig((row.configJson ?? {}) as AgentConfig),
    }))
    const visible = listVisibleAgentDefs()
    const resolved = await Promise.all(visible.map(async def => {
      const agent = await resolveAgent(def.key)
      return {
        agentKey: def.key,
        label: def.label ?? def.key,
        model: agent.model,
        mode: agent.mode,
        systemPrompt: agent.systemPrompt,
        config: redactAgentConfig(agent.config),
        settingsSchema: def.settingsSchema ?? [],
      }
    }))
    const defs = listAgentDefs().map(d => ({
      key: d.key,
      label: d.label ?? d.key,
      surfaceInSettings: d.surfaceInSettings !== false,
      settingsSchema: d.settingsSchema ?? [],
      acceptedTags: d.acceptedTags ?? [],
    }))
    return { success: true, agents: direct, resolved, defs }
  })

  ipcMain.handle('settings:agents:save', (_event, update: AgentSettingsUpdate) => {
    const db = getDb()
    const existing = db.select().from(schema.agentSettings).where(eq(schema.agentSettings.agentKey, update.agentKey)).get()
    const config: AgentConfig = {
      ...((existing?.configJson ?? {}) as AgentConfig),
      ...(update.config ?? {}),
    }
    const now = new Date()
    db.insert(schema.agentSettings)
      .values({
        agentKey: update.agentKey,
        model: update.model || null,
        mode: update.mode || null,
        systemPrompt: update.systemPrompt || null,
        configJson: config,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.agentSettings.agentKey,
        set: {
          model: update.model || null,
          mode: update.mode || null,
          systemPrompt: update.systemPrompt || null,
          configJson: config,
          updatedAt: now,
        },
      })
      .run()
    notifyWrite()
    return { success: true, config: redactAgentConfig(config) }
  })

  // ── Provider instances (multi-instance, openai-compatible) ────────────────

  ipcMain.handle('providers:list', () => {
    return { success: true, providers: listProviderInstances() }
  })

  ipcMain.handle('providers:add', async (_event, opts: AddProviderOptions) => {
    try {
      const summary = await addProviderInstance(opts)
      notifyWrite()
      return { success: true, id: summary.id, provider: summary }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('providers:update', async (_event, { id, patch }: { id: string; patch: UpdateProviderOptions }) => {
    try {
      const summary = await updateProviderInstance(id, patch)
      notifyWrite()
      return { success: true, provider: summary }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('providers:remove', (_event, { id }: { id: string }) => {
    try {
      removeProviderInstance(id)
      notifyWrite()
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('providers:refresh-models', async (_event, { id }: { id: string }) => {
    try {
      const models = await refreshProviderModels(id)
      notifyWrite()
      return { success: true, models }
    } catch (err) {
      return { success: false, error: (err as Error).message, models: [] }
    }
  })

  ipcMain.handle(
    'providers:add-model',
    async (
      _event,
      {
        id,
        model,
      }: {
        id: string
        model: { id?: string; baseUrl?: string; name?: string; contextWindow?: number; supportsReasoning?: boolean }
      },
    ) => {
      try {
        const models = await addManualModel(id, model)
        notifyWrite()
        return { success: true, models }
      } catch (err) {
        return { success: false, error: (err as Error).message, models: [] }
      }
    },
  )

  ipcMain.handle(
    'providers:remove-model',
    (_event, { id, modelId }: { id: string; modelId: string }) => {
      try {
        const models = removeManualModel(id, modelId)
        notifyWrite()
        return { success: true, models }
      } catch (err) {
        return { success: false, error: (err as Error).message, models: [] }
      }
    },
  )

  ipcMain.handle('providers:test', async (_event, { id, apiKey }: { id: string; apiKey?: string }) => {
    try {
      const p = getProviderById(id)
      const models = await p.fetchModels(apiKey ?? '')
      return { success: true, modelCount: models.length, models }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  // ── Models (read-only, aggregated across all enabled instances) ───────────

  ipcMain.handle('models:list', () => {
    return { success: true, models: listAllModels() }
  })

  // ── App ───────────────────────────────────────────────────────────────────

  ipcMain.handle('app:version', () => app.getVersion())

  ipcMain.handle('app:open-logs', () => {
    shell.openPath(app.getPath('logs'))
  })

  ipcMain.handle('app:restart-and-update', () => {
    autoUpdater.quitAndInstall()
  })
}
