import { eq } from 'drizzle-orm'
import { decryptApiKey } from '../crypto'
import { getDb, schema } from '../db'
import { getDecryptedApiKeyOrNull } from '../providers/keystore'
import { getProviderNameForModel } from '../providers'
import type { ModelProviderId } from '../providers/types'
import { getAgentDef } from './agentDefs'
import { DEFAULT_MEETING_SYSTEM_PROMPT } from './agentDefs/meeting'

export { DEFAULT_MEETING_SYSTEM_PROMPT }

export type AgentKey = 'wos' | 'meeting' | string

export interface AgentRuntimeSettings {
  agentKey: string
  inheritFrom: string | null
  model: string
  mode: 'default' | 'plan' | 'yolo'
  systemPrompt: string
  config: AgentConfig
  apiKeyOverride?: string
}

export interface AgentConfig {
  // v1 ships captions-only. The other values are kept as types so existing
  // DB rows from earlier builds still parse — they're treated as 'captions'
  // by liveSession (see notes there).
  liveSource?: 'captions' | 'captions-webrtc' | 'webrtc'
  autoSummarize?: boolean
  defaultSlackChannel?: string
  openaiApiKeyEncrypted?: string
  openaiApiKeyIv?: string
  anthropicApiKeyEncrypted?: string
  anthropicApiKeyIv?: string
  huggingFaceApiKeyEncrypted?: string
  huggingFaceApiKeyIv?: string
  [key: string]: unknown
}

export const DEFAULT_MEETING_SYSTEM_PROMPT_LOCAL = DEFAULT_MEETING_SYSTEM_PROMPT
// Re-exported above for backward compat with callers/tests that imported
// DEFAULT_MEETING_SYSTEM_PROMPT from './settings'.

function parseSettingValue(value: unknown): string {
  if (typeof value !== 'string') return ''
  try {
    const parsed = JSON.parse(value)
    return typeof parsed === 'string' ? parsed : ''
  } catch {
    return value.replace(/^"|"$/g, '')
  }
}

function parseConfig(value: unknown): AgentConfig {
  if (!value) return {}
  if (typeof value === 'object') return value as AgentConfig
  if (typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed as AgentConfig : {}
  } catch {
    return {}
  }
}

function getGlobalDefaults() {
  const db = getDb()
  const modelRow = db.select().from(schema.settings).where(eq(schema.settings.key, 'defaultModel')).get()
  const modeRow = db.select().from(schema.settings).where(eq(schema.settings.key, 'defaultMode')).get()
  const model = parseSettingValue(modelRow?.value) || ''
  const mode = parseSettingValue(modeRow?.value) || 'default'
  return {
    model,
    mode: (mode === 'plan' || mode === 'yolo' ? mode : 'default') as 'default' | 'plan' | 'yolo',
  }
}

function decryptAgentKey(config: AgentConfig, provider: ModelProviderId): string | undefined {
  const encrypted = provider === 'openai'
    ? config.openaiApiKeyEncrypted
    : provider === 'anthropic'
      ? config.anthropicApiKeyEncrypted
      : config.huggingFaceApiKeyEncrypted
  const iv = provider === 'openai'
    ? config.openaiApiKeyIv
    : provider === 'anthropic'
      ? config.anthropicApiKeyIv
      : config.huggingFaceApiKeyIv
  if (!encrypted || !iv) return undefined
  return decryptApiKey(String(encrypted), String(iv))
}

export async function resolveAgent(agentKey: AgentKey): Promise<AgentRuntimeSettings> {
  const db = getDb()
  const defaults = getGlobalDefaults()
  const chain: Array<typeof schema.agentSettings.$inferSelect> = []
  const seen = new Set<string>()
  let current: string | null = agentKey

  while (current && !seen.has(current)) {
    seen.add(current)
    const row = db.select().from(schema.agentSettings).where(eq(schema.agentSettings.agentKey, current)).get()
    if (row) {
      chain.unshift(row)
      current = row.inheritFrom
    } else {
      current = null
    }
  }

  if (current && seen.has(current)) {
    throw new Error(`Agent settings inheritance cycle detected at "${current}"`)
  }

  let model = defaults.model
  let mode = defaults.mode
  const def = getAgentDef(agentKey)
  let systemPrompt = def?.systemPrompt ?? ''
  let config: AgentConfig = {}
  let inheritFrom: string | null = def?.defaultInheritFrom ?? null

  for (const row of chain) {
    inheritFrom = row.inheritFrom
    const rowConfig = parseConfig(row.configJson)
    config = { ...config, ...rowConfig }
    if (row.model) model = row.model
    if (row.mode === 'default' || row.mode === 'plan' || row.mode === 'yolo') mode = row.mode
    if (row.systemPrompt) systemPrompt = row.systemPrompt
  }

  if (def?.defaultConfig) {
    config = { ...def.defaultConfig, ...config }
  }

  if (!model) model = defaults.model
  const provider = getProviderNameForModel(model)
  const apiKeyOverride = decryptAgentKey(config, provider) ?? await getDecryptedApiKeyOrNull(provider) ?? undefined

  return {
    agentKey,
    inheritFrom,
    model,
    mode,
    systemPrompt,
    config,
    apiKeyOverride,
  }
}

export function redactAgentConfig(config: AgentConfig): AgentConfig & {
  openaiApiKeySet?: boolean
  anthropicApiKeySet?: boolean
  huggingFaceApiKeySet?: boolean
} {
  const {
    openaiApiKeyEncrypted,
    openaiApiKeyIv,
    anthropicApiKeyEncrypted,
    anthropicApiKeyIv,
    huggingFaceApiKeyEncrypted,
    huggingFaceApiKeyIv,
    ...rest
  } = config
  return {
    ...rest,
    openaiApiKeySet: Boolean(openaiApiKeyEncrypted && openaiApiKeyIv),
    anthropicApiKeySet: Boolean(anthropicApiKeyEncrypted && anthropicApiKeyIv),
    huggingFaceApiKeySet: Boolean(huggingFaceApiKeyEncrypted && huggingFaceApiKeyIv),
  }
}
