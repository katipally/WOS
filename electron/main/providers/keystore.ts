import { getDb, schema } from '../db'
import { eq } from 'drizzle-orm'
import { decryptApiKey } from '../crypto'
import type { ModelProviderId } from './types'

export async function getDecryptedApiKey(provider: ModelProviderId): Promise<string> {
  const db = getDb()
  const row = db.select().from(schema.apiKeys).where(eq(schema.apiKeys.provider, provider)).get()
  if (!row) throw new Error(`No API key stored for ${provider}. Please add it in Settings.`)
  return decryptApiKey(row.encryptedKey, row.iv)
}

export async function getDecryptedApiKeyOrNull(provider: ModelProviderId): Promise<string | null> {
  try {
    return await getDecryptedApiKey(provider)
  } catch {
    return null
  }
}
