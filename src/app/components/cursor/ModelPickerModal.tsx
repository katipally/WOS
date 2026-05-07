import { useEffect, useMemo, useState } from 'react'
import { Cpu, Loader2, X } from 'lucide-react'
import type { ModelInfo } from '../../../types'

const PROVIDER_ORDER = ['anthropic', 'openai', 'huggingface-space'] as const
const PROVIDER_LABELS: Record<ModelInfo['provider'], string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'huggingface-space': 'HF Space',
}

function getProviderLabel(provider: ModelInfo['provider']): string {
  return PROVIDER_LABELS[provider]
}

export function ModelPickerModal({ current, onSelect, onClose }: {
  current: string
  onSelect: (modelId: string) => void | Promise<void>
  onClose: () => void
}) {
  const [models, setModels] = useState<ModelInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [provider, setProvider] = useState<ModelInfo['provider']>('anthropic')
  const [selected, setSelected] = useState(current)

  useEffect(() => {
    let alive = true
    const load = async () => {
      setLoading(true)
      try {
        const res = await window.wos.fetchSavedModels()
        if (!alive) return
        if (res?.models?.length) {
          setModels(res.models)
          return
        }
        const fallback = await window.wos.getFallbackModels()
        if (alive) setModels(fallback)
      } catch {
        const fallback = await window.wos.getFallbackModels().catch(() => [])
        if (alive) setModels(fallback)
      } finally {
        if (alive) setLoading(false)
      }
    }
    void load()
    return () => { alive = false }
  }, [])

  useEffect(() => {
    const currentProvider = models.find(model => model.id === current)?.provider
    if (currentProvider) setProvider(currentProvider)
  }, [current, models])

  const providers = useMemo(() => {
    const present = new Set(models.map(model => model.provider))
    return PROVIDER_ORDER.filter(id => present.has(id))
  }, [models])

  useEffect(() => {
    if (!providers.length) return
    if (!providers.includes(provider)) setProvider(providers[0])
  }, [provider, providers])

  const providerModels = useMemo(
    () => models.filter(model => model.provider === provider),
    [models, provider],
  )

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="rounded-2xl overflow-hidden flex flex-col"
        style={{
          background: 'var(--popover)',
          border: '1px solid var(--border)',
          boxShadow: '0 24px 60px rgba(0,0,0,0.7)',
          width: '380px',
          maxHeight: '480px',
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 pt-4 pb-3"
          style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="flex items-center gap-2">
            <Cpu size={14} style={{ color: 'var(--primary)' }} />
            <span className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>Choose Model</span>
          </div>
          <button onMouseDown={onClose} style={{ color: 'var(--muted-foreground)' }} className="hover:opacity-70">
            <X size={14} />
          </button>
        </div>

        {/* Provider tabs */}
        <div className="flex gap-1 px-4 pt-3 pb-2">
          {providers.map(p => (
            <button
              key={p}
              onMouseDown={() => setProvider(p)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-colors"
              style={{
                background: provider === p ? 'var(--primary)' : 'var(--card)',
                color: provider === p ? 'white' : 'var(--muted-foreground)',
                border: '1px solid var(--border)',
              }}
            >
              {getProviderLabel(p)}
            </button>
          ))}
        </div>

        {/* Model list */}
        <div className="overflow-y-auto flex-1 px-2 pb-2">
          {loading && providerModels.length === 0 && (
            <div className="px-3 py-4 flex items-center gap-2 text-xs" style={{ color: 'var(--muted-foreground)' }}>
              <Loader2 size={12} className="animate-spin" /> Loading models…
            </div>
          )}
          {!loading && providerModels.length === 0 && (
            <div className="px-3 py-4 text-xs" style={{ color: 'var(--muted-foreground)' }}>
              {provider === 'huggingface-space'
                ? 'No HF Space models are saved yet. Add a Space in Settings → AI & Agents first.'
                : 'No models available for this provider.'}
            </div>
          )}
          {providerModels.map(m => {
            const isActive = selected === m.id
            return (
              <button
                key={m.id}
                onMouseDown={() => setSelected(m.id)}
                className="w-full text-left px-3 py-2.5 rounded-xl flex items-start gap-3 mb-0.5 transition-colors"
                style={{
                  background: isActive ? 'rgba(var(--primary-rgb, 99, 102, 241), 0.12)' : 'transparent',
                  border: `1px solid ${isActive ? 'var(--primary)' : 'transparent'}`,
                }}
              >
                <div className="mt-0.5 shrink-0 w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center"
                  style={{ borderColor: isActive ? 'var(--primary)' : 'var(--border)' }}>
                  {isActive && <div className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--primary)' }} />}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium" style={{ color: 'var(--foreground)' }}>{m.name}</span>
                    {m.id === current && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full"
                        style={{ background: 'rgba(var(--primary-rgb,99,102,241),0.15)', color: 'var(--primary)' }}>
                        Current
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] mt-0.5" style={{ color: 'var(--muted-foreground)' }}>
                    {m.description ?? (m.provider === 'huggingface-space' ? 'Model served by a saved Hugging Face Space' : m.id)}
                  </div>
                </div>
              </button>
            )
          })}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 flex gap-2 justify-end" style={{ borderTop: '1px solid var(--border)' }}>
          <button onMouseDown={onClose}
            className="px-3 py-1.5 rounded-lg text-xs transition-colors"
            style={{ color: 'var(--muted-foreground)', border: '1px solid var(--border)' }}>
            Cancel
          </button>
          <button
            onMouseDown={() => { void onSelect(selected); onClose() }}
            className="px-4 py-1.5 rounded-lg text-xs font-medium transition-colors"
            style={{ background: 'var(--primary)', color: 'white' }}
          >
            Apply Model
          </button>
        </div>
      </div>
    </div>
  )
}
