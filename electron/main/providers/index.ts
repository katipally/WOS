/**
 * Provider registry — multi-instance.
 *
 * The legacy registry hard-coded one OpenAI and one Anthropic provider and
 * routed by model-id prefix. The new registry treats every provider as a row
 * in the `provider_instances` table and dispatches by either:
 *   - explicit providerId (preferred), or
 *   - model-id lookup against each instance's persisted modelsJson, with a
 *     conservative legacy prefix fallback for the bundled built-ins.
 */
import { eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { encryptApiKey } from '../crypto'
import { getDb, schema } from '../db'
import type { ApiStyle, ModelInfo, ModelProvider, ProviderKind } from './types'
import { OpenAIProvider } from './openai'
import { AnthropicProvider } from './anthropic'
import { OpenAICompatibleProvider, probeApiStyle } from './openaiCompatible'
import { getDecryptedApiKeyForInstance } from './keystore'

export interface ProviderInstanceSummary {
  id: string
  kind: ProviderKind
  label: string
  baseUrl: string | null
  apiStyle: ApiStyle | null
  enabled: boolean
  models: ModelInfo[]
  customHeaders: Record<string, string> | null
  hasKey: boolean
}

function rowToSummary(row: typeof schema.providerInstances.$inferSelect): ProviderInstanceSummary {
  // drizzle returns json/timestamp columns already parsed.
  const models = Array.isArray(row.modelsJson) ? row.modelsJson as ModelInfo[] : []
  const customHeaders = (row.customHeadersJson && typeof row.customHeadersJson === 'object'
    ? row.customHeadersJson as Record<string, string>
    : null)
  return {
    id: row.id,
    kind: row.kind as ProviderKind,
    label: row.label,
    baseUrl: row.baseUrl,
    apiStyle: row.apiStyle as ApiStyle | null,
    enabled: !!row.enabled,
    models,
    customHeaders,
    hasKey: !!row.encryptedKey,
  }
}

/** Instantiate the streaming adapter for a given provider instance row. */
function adapterFor(row: typeof schema.providerInstances.$inferSelect): ModelProvider {
  const kind = row.kind as ProviderKind
  const customHeaders = (row.customHeadersJson && typeof row.customHeadersJson === 'object')
    ? row.customHeadersJson as Record<string, string>
    : undefined
  if (kind === 'openai') {
    return new OpenAIProvider({
      providerId: row.id,
      baseURL: row.baseUrl ?? undefined,
      customHeaders,
    })
  }
  if (kind === 'anthropic') {
    return new AnthropicProvider({ providerId: row.id })
  }
  return new OpenAICompatibleProvider({
    providerId: row.id,
    baseURL: row.baseUrl ?? '',
    apiStyle: (row.apiStyle as ApiStyle) || 'chat-completions',
    customHeaders,
  })
}

export function listProviderInstances(): ProviderInstanceSummary[] {
  const db = getDb()
  return db.select().from(schema.providerInstances).all().map(rowToSummary)
}

export function getProviderInstance(id: string): ProviderInstanceSummary | null {
  const db = getDb()
  const row = db.select().from(schema.providerInstances).where(eq(schema.providerInstances.id, id)).get()
  return row ? rowToSummary(row) : null
}

/** Get the adapter for a specific provider instance id. */
export function getProviderById(providerId: string): ModelProvider {
  const db = getDb()
  const row = db.select().from(schema.providerInstances).where(eq(schema.providerInstances.id, providerId)).get()
  if (!row) throw new Error(`Unknown provider instance "${providerId}". Configure it in Settings → Providers.`)
  return adapterFor(row)
}

/**
 * Find the right adapter for a model id. Search order:
 *   1. Each enabled provider_instances row whose modelsJson contains the id.
 *   2. Built-in 'anthropic' instance for `claude*` ids.
 *   3. Built-in 'openai' instance for OpenAI-shaped ids (gpt-*, o1-*, …).
 * Throws if nothing matches.
 */
export function getProviderForModel(model: string): ModelProvider {
  const db = getDb()
  const rows = db.select().from(schema.providerInstances).all()
  // Find a row matching this model id within any enabled instance.
  for (const row of rows) {
    if (!row.enabled) continue
    const ids = Array.isArray(row.modelsJson) ? row.modelsJson as Array<{ id: string }> : []
    if (ids.some(m => m.id === model)) return adapterFor(row)
  }
  // Legacy prefix fallback against built-ins.
  if (model.startsWith('claude')) {
    const ant = rows.find(r => r.id === 'anthropic')
    if (ant) return adapterFor(ant)
  }
  if (model.startsWith('gpt-') || /^o\d/.test(model) || model.startsWith('chatgpt')) {
    const oa = rows.find(r => r.id === 'openai')
    if (oa) return adapterFor(oa)
  }
  throw new Error(
    `No provider instance lists model "${model}". ` +
    `Add it under Settings → Providers, or refresh the model list for the relevant provider.`,
  )
}

/** Compatibility shim — old name, same behavior. */
export const getProvider = getProviderForModel

// ── CRUD: provider instances ────────────────────────────────────────────────

export interface AddProviderOptions {
  kind: ProviderKind
  label: string
  apiKey: string
  baseUrl?: string
  customHeaders?: Record<string, string>
  /** When omitted on openai-compatible kinds, probeApiStyle() is invoked. */
  apiStyle?: ApiStyle
  /** Optional explicit id (e.g. 'openai' / 'anthropic' for built-ins). */
  id?: string
}

export async function addProviderInstance(opts: AddProviderOptions): Promise<ProviderInstanceSummary> {
  const db = getDb()
  const id = opts.id ?? randomUUID()
  let apiStyle: ApiStyle | null = opts.apiStyle ?? (opts.kind === 'anthropic' ? null : 'responses')
  let models: ModelInfo[] = []

  if (opts.kind === 'openai-compatible') {
    if (!opts.baseUrl) throw new Error('baseUrl is required for openai-compatible providers.')
    const probe = await probeApiStyle({ baseURL: opts.baseUrl, apiKey: opts.apiKey, customHeaders: opts.customHeaders })
    apiStyle = opts.apiStyle ?? probe.apiStyle
    models = probe.models.map(m => ({ ...m, providerId: id }))
  }

  const enc = encryptApiKey(opts.apiKey)
  const nowDate = new Date()
  db.insert(schema.providerInstances).values({
    id,
    kind: opts.kind,
    label: opts.label,
    baseUrl: opts.baseUrl ?? null,
    apiStyle,
    encryptedKey: enc.encrypted,
    iv: enc.iv,
    modelsJson: models,
    capabilitiesJson: null,
    customHeadersJson: opts.customHeaders ?? null,
    enabled: true,
    createdAt: nowDate,
    updatedAt: nowDate,
  }).onConflictDoUpdate({
    target: schema.providerInstances.id,
    set: {
      kind: opts.kind,
      label: opts.label,
      baseUrl: opts.baseUrl ?? null,
      apiStyle,
      encryptedKey: enc.encrypted,
      iv: enc.iv,
      customHeadersJson: opts.customHeaders ?? null,
      enabled: true,
      updatedAt: nowDate,
    },
  }).run()

  // Best-effort initial models fetch for built-in kinds (openai-compatible
  // already populated above).
  if (opts.kind !== 'openai-compatible') {
    try {
      const adapter = adapterFor({
        id, kind: opts.kind, label: opts.label, baseUrl: opts.baseUrl ?? null,
        apiStyle, encryptedKey: enc.encrypted, iv: enc.iv, modelsJson: [],
        capabilitiesJson: null, customHeadersJson: opts.customHeaders ?? null,
        enabled: true, createdAt: nowDate, updatedAt: nowDate,
      })
      const fetched = await adapter.fetchModels(opts.apiKey)
      db.update(schema.providerInstances)
        .set({ modelsJson: fetched, updatedAt: new Date() })
        .where(eq(schema.providerInstances.id, id))
        .run()
    } catch {
      // If the upstream blocks `models.list`, leave modelsJson empty — the
      // user can pick a model manually and Refresh later.
    }
  }

  return getProviderInstance(id)!
}

export interface UpdateProviderOptions {
  label?: string
  baseUrl?: string | null
  customHeaders?: Record<string, string> | null
  apiKey?: string
  enabled?: boolean
}

export async function updateProviderInstance(id: string, patch: UpdateProviderOptions): Promise<ProviderInstanceSummary> {
  const db = getDb()
  const row = db.select().from(schema.providerInstances).where(eq(schema.providerInstances.id, id)).get()
  if (!row) throw new Error(`Unknown provider instance "${id}".`)
  const set: Partial<typeof schema.providerInstances.$inferInsert> = { updatedAt: new Date() }
  if (patch.label !== undefined) set.label = patch.label
  if (patch.baseUrl !== undefined) set.baseUrl = patch.baseUrl
  if (patch.customHeaders !== undefined) {
    set.customHeadersJson = patch.customHeaders ?? null
  }
  if (patch.enabled !== undefined) set.enabled = patch.enabled
  if (patch.apiKey) {
    const enc = encryptApiKey(patch.apiKey)
    set.encryptedKey = enc.encrypted
    set.iv = enc.iv
  }
  db.update(schema.providerInstances).set(set).where(eq(schema.providerInstances.id, id)).run()
  return getProviderInstance(id)!
}

export function removeProviderInstance(id: string): void {
  const db = getDb()
  db.delete(schema.providerInstances).where(eq(schema.providerInstances.id, id)).run()
}

/** Refresh modelsJson by hitting the upstream's models endpoint. */
export async function refreshProviderModels(id: string): Promise<ModelInfo[]> {
  const inst = getProviderInstance(id)
  if (!inst) throw new Error(`Unknown provider instance "${id}".`)
  const apiKey = await getDecryptedApiKeyForInstance(id)
  const adapter = getProviderById(id)
  const models = await adapter.fetchModels(apiKey)
  const db = getDb()
  db.update(schema.providerInstances)
    .set({ modelsJson: models, updatedAt: new Date() })
    .where(eq(schema.providerInstances.id, id))
    .run()
  return models
}

/** Aggregated model list across all enabled provider instances. */
export function listAllModels(): ModelInfo[] {
  const out: ModelInfo[] = []
  for (const inst of listProviderInstances()) {
    if (!inst.enabled) continue
    out.push(...inst.models)
  }
  return out
}

export type { ModelProvider, ModelInfo }
