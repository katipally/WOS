import { useEffect, useMemo, useState } from 'react'
import { Cpu, X } from 'lucide-react'
import type { ModelInfo } from '../../../types'

interface PickerModel {
  id: string
  name: string
  providerId: string
  providerLabel: string
  kind: 'openai' | 'anthropic' | 'openai-compatible' | 'runpod'
  description?: string
}

export function ModelPickerModal({ current, onSelect, onClose }: {
  current: string
  onSelect: (modelId: string) => void | Promise<void>
  onClose: () => void
}) {
  const [models, setModels] = useState<PickerModel[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState(current)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [list, providers] = await Promise.all([
          window.wos.models.list(),
          window.wos.providers.list(),
        ])
        if (cancelled) return
        const providerLabels = new Map<string, string>()
        for (const p of providers) providerLabels.set(p.id, p.label || p.kind)
        const ms: PickerModel[] = (list as ModelInfo[]).map(m => ({
          id: m.id,
          name: m.name || m.id,
          providerId: m.providerId,
          providerLabel: providerLabels.get(m.providerId) || m.providerId,
          kind: m.kind,
          description: m.description,
        }))
        setModels(ms)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const providersWithModels = useMemo(() => {
    const seen = new Map<string, string>()
    for (const m of models) if (!seen.has(m.providerId)) seen.set(m.providerId, m.providerLabel)
    return Array.from(seen.entries()).map(([id, label]) => ({ id, label }))
  }, [models])

  const initialProvider = models.find(m => m.id === current)?.providerId
    ?? providersWithModels[0]?.id
    ?? null
  const [providerId, setProviderId] = useState<string | null>(initialProvider)

  useEffect(() => {
    if (!providerId && providersWithModels.length) setProviderId(providersWithModels[0].id)
  }, [providerId, providersWithModels])

  const visibleModels = providerId ? models.filter(m => m.providerId === providerId) : models

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
          width: '420px',
          maxHeight: '520px',
        }}
      >
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

        {providersWithModels.length > 1 && (
          <div className="flex flex-wrap gap-1 px-4 pt-3 pb-2">
            {providersWithModels.map(p => (
              <button
                key={p.id}
                onMouseDown={() => setProviderId(p.id)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                style={{
                  background: providerId === p.id ? 'var(--primary)' : 'var(--card)',
                  color: providerId === p.id ? 'white' : 'var(--muted-foreground)',
                  border: '1px solid var(--border)',
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
        )}

        <div className="overflow-y-auto flex-1 px-2 pb-2">
          {loading && (
            <div className="px-4 py-6 text-xs" style={{ color: 'var(--muted-foreground)' }}>
              Loading models…
            </div>
          )}
          {error && !loading && (
            <div className="px-4 py-6 text-xs" style={{ color: 'var(--destructive, #ef4444)' }}>
              {error}
            </div>
          )}
          {!loading && !error && visibleModels.length === 0 && (
            <div className="px-4 py-6 text-xs" style={{ color: 'var(--muted-foreground)' }}>
              No models available. Add a provider in Settings → Providers.
            </div>
          )}
          {!loading && !error && visibleModels.map(m => {
            const isActive = selected === m.id
            return (
              <button
                key={`${m.providerId}:${m.id}`}
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
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium truncate" style={{ color: 'var(--foreground)' }}>{m.name}</span>
                    {m.id === current && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full"
                        style={{ background: 'rgba(var(--primary-rgb,99,102,241),0.15)', color: 'var(--primary)' }}>
                        Current
                      </span>
                    )}
                  </div>
                  {m.description && (
                    <div className="text-[11px] mt-0.5" style={{ color: 'var(--muted-foreground)' }}>{m.description}</div>
                  )}
                </div>
              </button>
            )
          })}
        </div>

        <div className="px-4 py-3 flex gap-2 justify-end" style={{ borderTop: '1px solid var(--border)' }}>
          <button onMouseDown={onClose}
            className="px-3 py-1.5 rounded-lg text-xs transition-colors"
            style={{ color: 'var(--muted-foreground)', border: '1px solid var(--border)' }}>
            Cancel
          </button>
          <button
            onMouseDown={() => { if (selected) { void onSelect(selected); onClose() } }}
            disabled={!selected}
            className="px-4 py-1.5 rounded-lg text-xs font-medium transition-colors"
            style={{ background: 'var(--primary)', color: 'white', opacity: selected ? 1 : 0.5 }}
          >
            Apply Model
          </button>
        </div>
      </div>
    </div>
  )
}
