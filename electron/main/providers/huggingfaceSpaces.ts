import { eq } from 'drizzle-orm'
import { getDb, notifyWrite, schema } from '../db'
import { enrichModel } from './capabilities'
import type { ModelInfo } from './types'

export const HUGGINGFACE_SPACE_PROVIDER = 'huggingface-space' as const
export const HUGGINGFACE_SPACES_SETTING_KEY = 'huggingFaceSpaces'
const HUGGINGFACE_SPACE_MODEL_PREFIX = 'hfspace:'

export interface HuggingFaceSpaceConfig {
  spaceId: string
  source: string
  baseUrl: string
  baseUrlOverride?: string | null
  title?: string | null
  author?: string | null
  sdk?: string | null
  updatedAt?: string | null
  runtimeStage?: string | null
  likes?: number | null
  private?: boolean
  modelIds?: string[]
  lastSyncedAt?: string | null
}

type HuggingFaceSpaceApiResponse = {
  id?: string
  author?: string
  sdk?: string
  private?: boolean
  likes?: number
  updatedAt?: string | null
  lastModified?: string | null
  cardData?: { title?: string }
  title?: string
}

type HuggingFaceSpaceRuntimeResponse = {
  stage?: string
}

function parseStoredValue<T>(value: unknown, fallback: T): T {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T
    } catch {
      return fallback
    }
  }
  if (value == null) return fallback
  return value as T
}

export function normalizeHuggingFaceSpaceId(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  const direct = trimmed.match(/^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/)
  if (direct) return `${direct[1]}/${direct[2]}`

  try {
    const url = new URL(trimmed)
    const parts = url.pathname.split('/').filter(Boolean)
    if (url.hostname === 'huggingface.co' && parts[0] === 'spaces' && parts[1] && parts[2]) {
      return `${parts[1]}/${parts[2]}`
    }
  } catch {
    return null
  }

  return null
}

export function buildDefaultHuggingFaceSpaceBaseUrl(spaceId: string): string {
  return `https://${spaceId.replace('/', '-')}.hf.space/v1`
}

export function normalizeHuggingFaceSpaceBaseUrl(baseUrl: string | null | undefined, spaceId: string): string {
  const raw = (baseUrl ?? '').trim()
  const normalized = (raw || buildDefaultHuggingFaceSpaceBaseUrl(spaceId)).replace(/\/+$/, '')
  return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`
}

export function encodeHuggingFaceSpaceModelId(spaceId: string, modelId: string): string {
  return `${HUGGINGFACE_SPACE_MODEL_PREFIX}${encodeURIComponent(spaceId)}:${encodeURIComponent(modelId)}`
}

export function decodeHuggingFaceSpaceModelId(model: string): { spaceId: string; modelId: string } | null {
  if (!model.startsWith(HUGGINGFACE_SPACE_MODEL_PREFIX)) return null
  const raw = model.slice(HUGGINGFACE_SPACE_MODEL_PREFIX.length)
  const separator = raw.indexOf(':')
  if (separator === -1) return null

  const encodedSpaceId = raw.slice(0, separator)
  const encodedModelId = raw.slice(separator + 1)
  if (!encodedSpaceId || !encodedModelId) return null

  try {
    return {
      spaceId: decodeURIComponent(encodedSpaceId),
      modelId: decodeURIComponent(encodedModelId),
    }
  } catch {
    return null
  }
}

export function isHuggingFaceSpaceModelId(model: string): boolean {
  return model.startsWith(HUGGINGFACE_SPACE_MODEL_PREFIX)
}

export function listHuggingFaceSpaces(): HuggingFaceSpaceConfig[] {
  const db = getDb()
  const row = db.select().from(schema.settings).where(eq(schema.settings.key, HUGGINGFACE_SPACES_SETTING_KEY)).get()
  const parsed = parseStoredValue<unknown[]>(row?.value, [])
  if (!Array.isArray(parsed)) return []
  return parsed.reduce<HuggingFaceSpaceConfig[]>((spaces, item) => {
    if (!item || typeof item !== 'object') return spaces
    const partial = item as Partial<HuggingFaceSpaceConfig>
    const spaceId = typeof partial.spaceId === 'string' ? partial.spaceId : ''
    if (!spaceId) return spaces
    spaces.push({
      spaceId,
      source: typeof partial.source === 'string' ? partial.source : spaceId,
      baseUrl: normalizeHuggingFaceSpaceBaseUrl(
        typeof partial.baseUrlOverride === 'string' ? partial.baseUrlOverride : typeof partial.baseUrl === 'string' ? partial.baseUrl : '',
        spaceId,
      ),
      baseUrlOverride: typeof partial.baseUrlOverride === 'string' ? partial.baseUrlOverride : null,
      title: typeof partial.title === 'string' ? partial.title : null,
      author: typeof partial.author === 'string' ? partial.author : null,
      sdk: typeof partial.sdk === 'string' ? partial.sdk : null,
      updatedAt: typeof partial.updatedAt === 'string' ? partial.updatedAt : null,
      runtimeStage: typeof partial.runtimeStage === 'string' ? partial.runtimeStage : null,
      likes: typeof partial.likes === 'number' ? partial.likes : null,
      private: typeof partial.private === 'boolean' ? partial.private : false,
      modelIds: Array.isArray(partial.modelIds) ? partial.modelIds.filter((value): value is string => typeof value === 'string') : [],
      lastSyncedAt: typeof partial.lastSyncedAt === 'string' ? partial.lastSyncedAt : null,
    })
    return spaces
  }, [])
}

export function getHuggingFaceSpace(spaceId: string): HuggingFaceSpaceConfig | null {
  return listHuggingFaceSpaces().find(space => space.spaceId === spaceId) ?? null
}

export function saveHuggingFaceSpace(space: HuggingFaceSpaceConfig): void {
  const db = getDb()
  const spaces = listHuggingFaceSpaces().filter(item => item.spaceId !== space.spaceId)
  spaces.push({
    ...space,
    baseUrl: normalizeHuggingFaceSpaceBaseUrl(space.baseUrlOverride ?? space.baseUrl, space.spaceId),
    baseUrlOverride: space.baseUrlOverride ?? null,
    modelIds: Array.isArray(space.modelIds) ? [...new Set(space.modelIds)] : [],
  })
  const now = new Date()
  db.insert(schema.settings)
    .values({ key: HUGGINGFACE_SPACES_SETTING_KEY, value: JSON.stringify(spaces), updatedAt: now })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: { value: JSON.stringify(spaces), updatedAt: now },
    })
    .run()
  notifyWrite()
}

export function removeHuggingFaceSpace(spaceId: string): void {
  const db = getDb()
  const spaces = listHuggingFaceSpaces().filter(item => item.spaceId !== spaceId)
  const now = new Date()
  db.insert(schema.settings)
    .values({ key: HUGGINGFACE_SPACES_SETTING_KEY, value: JSON.stringify(spaces), updatedAt: now })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: { value: JSON.stringify(spaces), updatedAt: now },
    })
    .run()
  notifyWrite()
}

function buildAuthHeaders(token?: string): HeadersInit | undefined {
  if (!token) return undefined
  return { Authorization: `Bearer ${token}` }
}

async function readJson<T>(url: string, token?: string): Promise<T> {
  const response = await fetch(url, { headers: buildAuthHeaders(token) })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(detail || `Request failed with ${response.status} ${response.statusText}`)
  }
  return await response.json() as T
}

export async function testHuggingFaceToken(token: string): Promise<void> {
  await readJson('https://huggingface.co/api/whoami-v2', token)
}

export async function fetchHuggingFaceSpaceModels(space: Pick<HuggingFaceSpaceConfig, 'spaceId' | 'baseUrl'>, token?: string): Promise<ModelInfo[]> {
  const payload = await readJson<{ data?: Array<{ id?: string; name?: string }> }>(`${space.baseUrl.replace(/\/+$/, '')}/models`, token)
  const seen = new Set<string>()
  const rows = Array.isArray(payload.data) ? payload.data : []
  return rows.reduce<ModelInfo[]>((models, row) => {
    const modelId = typeof row.id === 'string' ? row.id : ''
    if (!modelId || seen.has(modelId)) return models
    seen.add(modelId)
    models.push(enrichModel({
      id: encodeHuggingFaceSpaceModelId(space.spaceId, modelId),
      name: typeof row.name === 'string' && row.name.trim() ? row.name : modelId,
      provider: HUGGINGFACE_SPACE_PROVIDER,
    }))
    return models
  }, [])
}

export async function inspectHuggingFaceSpace(source: string, baseUrlOverride?: string | null, token?: string): Promise<{
  space: HuggingFaceSpaceConfig
  models: ModelInfo[]
}> {
  const spaceId = normalizeHuggingFaceSpaceId(source)
  if (!spaceId) {
    throw new Error('Enter a Hugging Face Space slug like owner/space or a https://huggingface.co/spaces/owner/space URL.')
  }

  const metadata = await readJson<HuggingFaceSpaceApiResponse>(`https://huggingface.co/api/spaces/${spaceId}`, token)
  let runtimeStage: string | null = null
  try {
    const runtime = await readJson<HuggingFaceSpaceRuntimeResponse>(`https://huggingface.co/api/spaces/${spaceId}/runtime`, token)
    runtimeStage = typeof runtime.stage === 'string' ? runtime.stage : null
  } catch {
    runtimeStage = null
  }

  const space: HuggingFaceSpaceConfig = {
    spaceId,
    source,
    baseUrl: normalizeHuggingFaceSpaceBaseUrl(baseUrlOverride, spaceId),
    baseUrlOverride: baseUrlOverride?.trim() ? baseUrlOverride.trim() : null,
    title: metadata.title ?? metadata.cardData?.title ?? spaceId.split('/')[1] ?? spaceId,
    author: metadata.author ?? spaceId.split('/')[0] ?? null,
    sdk: metadata.sdk ?? null,
    updatedAt: metadata.updatedAt ?? metadata.lastModified ?? null,
    runtimeStage,
    likes: typeof metadata.likes === 'number' ? metadata.likes : null,
    private: Boolean(metadata.private),
    modelIds: [],
    lastSyncedAt: new Date().toISOString(),
  }

  const models = await fetchHuggingFaceSpaceModels(space, token)
  space.modelIds = models.map(model => decodeHuggingFaceSpaceModelId(model.id)?.modelId).filter((value): value is string => Boolean(value))
  return { space, models }
}