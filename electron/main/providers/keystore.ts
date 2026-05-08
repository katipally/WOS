import { getDb, schema } from '../db'
import { eq } from 'drizzle-orm'
import { decryptApiKey } from '../crypto'

/**
 * Decrypt the API key for a specific provider instance (provider_instances.id).
 * Falls back to the legacy api_keys table when no instance row exists yet —
 * that lets the migration v4 backfill happen lazily and keeps E2E fixtures
 * working without rewriting them.
 */
export async function getDecryptedApiKeyForInstance(providerId: string): Promise<string> {
  const db = getDb()
  const inst = db
    .select()
    .from(schema.providerInstances)
    .where(eq(schema.providerInstances.id, providerId))
    .get()
  if (inst) return decryptApiKey(inst.encryptedKey, inst.iv)

  // Legacy fallback: built-in provider names ('openai' | 'anthropic') still
  // resolve via the api_keys table for one release after the multi-instance
  // refactor lands.
  const legacy = db.select().from(schema.apiKeys).where(eq(schema.apiKeys.provider, providerId)).get()
  if (legacy) return decryptApiKey(legacy.encryptedKey, legacy.iv)

  throw new Error(`No API key stored for provider instance "${providerId}". Add it in Settings → Providers.`)
}

export async function getDecryptedApiKeyForInstanceOrNull(providerId: string): Promise<string | null> {
  try {
    return await getDecryptedApiKeyForInstance(providerId)
  } catch {
    return null
  }
}

// ── Legacy named-provider helpers ────────────────────────────────────────────
// Kept for backwards compatibility with code paths that still reach for
// 'openai' / 'anthropic' by name (e.g. probe flows + E2E harness). New code
// should call getDecryptedApiKeyForInstance(providerId) instead.
export async function getDecryptedApiKey(provider: 'openai' | 'anthropic'): Promise<string> {
  return getDecryptedApiKeyForInstance(provider)
}

export async function getDecryptedApiKeyOrNull(provider: 'openai' | 'anthropic'): Promise<string | null> {
  return getDecryptedApiKeyForInstanceOrNull(provider)
}
