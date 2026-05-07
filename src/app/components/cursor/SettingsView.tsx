import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft, Key, Settings as SettingsIcon, Info, CheckCircle2, XCircle, Loader2, RefreshCw,
  ChevronDown, Eye, Brain, Folder, Trash2, Plus, Sparkles, ScrollText, Sun, Moon, Monitor,
  Link, BarChart2, Activity,
} from 'lucide-react'
import { toast } from 'sonner'
import type { ModelInfo, AgentMode } from '../../../types'
import { useSettingsStore } from '../../../store/settingsStore'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { useAgentStore } from '../../../store/agentStore'
import { modelSupportsReasoning } from '../../../lib/modelCapabilities'
import { formatRelativeTime, getProviderFromModel } from '../../../lib/utils'

interface SettingsViewProps {
  onBack: () => void
}

type SectionId = 'preferences' | 'ai-agents' | 'automations' | 'connections' | 'account'

const SECTIONS: Array<{ id: SectionId; label: string; icon: React.ElementType; description: string }> = [
  { id: 'preferences', label: 'Preferences', icon: SettingsIcon, description: 'Appearance, theme, default mode' },
  { id: 'ai-agents', label: 'AI & Agents', icon: Brain, description: 'Models, agents, workspaces' },
  { id: 'automations', label: 'Automations', icon: Activity, description: 'Background runs, webhooks, safety' },
  { id: 'connections', label: 'Connections', icon: Link, description: 'API keys and integrations' },
  { id: 'account', label: 'Account', icon: BarChart2, description: 'Usage, billing, and about' },
]

const PROVIDER_ORDER = ['anthropic', 'openai', 'huggingface-space'] as const
const PROVIDER_LABELS: Record<ModelInfo['provider'], string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'huggingface-space': 'HF Space',
}

type HuggingFaceSpaceInfo = {
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

function getProviderLabel(provider: ModelInfo['provider'] | 'unknown'): string {
  if (provider === 'unknown') return 'Unknown'
  return PROVIDER_LABELS[provider]
}

export function SettingsView({ onBack }: SettingsViewProps) {
  const [section, setSection] = useState<SectionId>('preferences')
  return (
    <div className="w-full h-full flex" style={{ background: 'var(--background)' }}>
      {/* Settings sidebar nav */}
      <div className="shrink-0 w-56 flex flex-col" style={{ background: 'var(--sidebar)', borderRight: '1px solid var(--border)' }}>
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-3 py-2.5 wos-hover-sm transition-colors"
          style={{ fontSize: '12px', color: 'var(--muted-foreground)', borderBottom: '1px solid var(--border)' }}
        >
          <ArrowLeft size={12} />
          Back
        </button>
        <div className="mt-2 px-2 space-y-0.5">
          {SECTIONS.map(s => {
            const Icon = s.icon
            const active = section === s.id
            return (
              <button
                key={s.id}
                onClick={() => setSection(s.id)}
                className={`flex items-center gap-2.5 w-full px-3 py-2 rounded-md transition-colors text-left ${
                  active ? 'wos-sidebar-active' : 'wos-hover-sm'
                }`}
              >
                <Icon size={13} style={{ color: active ? 'var(--amber)' : 'var(--zinc-500)', flexShrink: 0 }} />
                <span style={{ fontSize: '13px', color: active ? 'var(--foreground)' : 'var(--zinc-400)', fontWeight: active ? 500 : 400 }}>
                  {s.label}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Settings content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto p-8">
          {section === 'preferences' && <PreferencesSection />}
          {section === 'ai-agents' && <AIAgentsSection />}
          {section === 'automations' && <AutomationsSection />}
          {section === 'connections' && <ConnectionsSection />}
          {section === 'account' && <AccountSection />}
        </div>
      </div>
    </div>
  )
}

// Preferences = Appearance + Default Mode (from former General, minus model/reasoning)
function PreferencesSection() {
  const { defaultMode, theme, saveSetting } = useSettingsStore()

  const THEME_OPTIONS: Array<{ id: 'dark' | 'light' | 'system'; label: string; icon: React.ElementType }> = [
    { id: 'dark', label: 'Dark', icon: Moon },
    { id: 'light', label: 'Light', icon: Sun },
    { id: 'system', label: 'System', icon: Monitor },
  ]

  return (
    <div className="space-y-8">
      <SectionHeader title="Preferences" subtitle="Appearance and default behavior for new chats" />

      <Field label="Appearance" hint="Choose your color theme">
        <div className="flex items-center gap-1">
          {THEME_OPTIONS.map(opt => {
            const Icon = opt.icon
            const active = (theme ?? 'dark') === opt.id
            return (
              <button
                key={opt.id}
                onClick={() => saveSetting('theme', opt.id)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-colors"
                style={{
                  fontSize: '12px',
                  background: active ? 'var(--amber-muted)' : 'var(--surface-base)',
                  color: active ? 'var(--amber)' : 'var(--muted-foreground)',
                  border: active ? '1px solid var(--surface-stronger)' : '1px solid transparent',
                }}
              >
                <Icon size={12} />
                {opt.label}
              </button>
            )
          })}
        </div>
      </Field>

      <Field label="Default Mode" hint="Starting agent mode for new chats">
        <div className="flex items-center gap-1">
          {(['default', 'plan', 'yolo'] as AgentMode[]).map(m => (
            <button
              key={m}
              onClick={() => saveSetting('defaultMode', m)}
              className="px-3 py-1.5 rounded-md capitalize transition-colors"
              style={{
                fontSize: '12px',
                background: defaultMode === m ? 'var(--amber-muted)' : 'var(--surface-base)',
                color: defaultMode === m ? 'var(--amber)' : 'var(--muted-foreground)',
                border: defaultMode === m ? '1px solid var(--surface-stronger)' : '1px solid transparent',
              }}
            >
              {m}
            </button>
          ))}
        </div>
        <div className="mt-2 text-xs" style={{ color: 'var(--muted-foreground)' }}>
          <strong className="font-medium" style={{ color: 'var(--foreground)' }}>Default</strong> — asks permission before each action.{' '}
          <strong className="font-medium" style={{ color: 'var(--foreground)' }}>Plan</strong> — plans first, waits for your approval.{' '}
          <strong className="font-medium" style={{ color: 'var(--foreground)' }}>Yolo</strong> — fully autonomous.
        </div>
      </Field>
    </div>
  )
}

// AI & Agents = Model + Reasoning + Agents + Workspaces
function AIAgentsSection() {
  const { defaultModel, reasoningEffort, intentModel, intentEnabled, maxSubagentDepth, maxSubagentBreadth, memoryEnabled, saveSetting } = useSettingsStore()
  const { models, loading, refresh } = useSavedModels()

  const selected = models.find(m => m.id === defaultModel)
  const supportsReasoning = selected
    ? selected.supportsReasoning === true
    : modelSupportsReasoning(defaultModel)

  return (
    <div className="space-y-10">
      <SectionHeader title="AI & Agents" subtitle="Model, reasoning, agent configuration, and workspaces. Skills and Rules now live under Apps & MCP." />

      {/* Model */}
      <div className="space-y-6">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>Default Model</h3>
        <Field label="Model" hint="Used for new conversations">
          <ModelAutocomplete
            models={models}
            loading={loading}
            value={defaultModel}
            onChange={(id) => saveSetting('defaultModel', id)}
            onRefresh={refresh}
          />
          {selected?.description && (
            <div className="mt-2" style={{ color: 'var(--muted-foreground)', fontSize: '11px' }}>{selected.description}</div>
          )}
        </Field>
        <Field
          label="Reasoning Effort"
          hint={supportsReasoning
            ? 'Controls how much the model reasons before answering'
            : 'The selected model does not support reasoning.'}
        >
          <div className={supportsReasoning ? '' : 'opacity-40 pointer-events-none'}>
            <div className="flex items-center gap-1">
              {(['low', 'medium', 'high', 'max'] as const).map(e => (
                <button
                  key={e}
                  disabled={!supportsReasoning}
                  onClick={() => saveSetting('reasoningEffort', e)}
                  className="px-3 py-1.5 rounded-md capitalize transition-colors"
                  style={{
                    fontSize: '12px',
                    background: reasoningEffort === e ? 'var(--amber-muted)' : 'var(--surface-base)',
                    color: reasoningEffort === e ? 'var(--amber)' : 'var(--muted-foreground)',
                    border: reasoningEffort === e ? '1px solid var(--surface-stronger)' : '1px solid transparent',
                  }}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>
        </Field>
      </div>

      <div style={{ height: '1px', background: 'var(--border)' }} />

      <div className="space-y-6">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>Hugging Face Spaces</h3>
        <HuggingFaceSpacesSection onModelsChanged={refresh} />
      </div>

      <div style={{ height: '1px', background: 'var(--border)' }} />

      {/* Agents */}
      <div className="space-y-6">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>Agents</h3>
        <AgentsSection />
      </div>

      <div style={{ height: '1px', background: 'var(--border)' }} />

      {/* Intent Engine */}
      <div className="space-y-4">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>Intent Engine</h3>
        <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
          Automatically selects the right tools based on what you're asking — reduces noise and speeds up responses.
        </p>
        <Field label="Enable Intent Routing" hint="Pre-classifies each message with a fast model to filter to relevant tools">
          <div className="flex items-center gap-2">
            <button
              onClick={() => saveSetting('intentEnabled', !intentEnabled)}
              className="px-3 py-1.5 rounded-md text-xs transition-colors"
              style={{
                background: intentEnabled ? 'var(--amber-muted)' : 'var(--surface-base)',
                color: intentEnabled ? 'var(--amber)' : 'var(--muted-foreground)',
                border: intentEnabled ? '1px solid var(--surface-stronger)' : '1px solid var(--border)',
              }}
            >
              {intentEnabled ? 'Enabled' : 'Disabled'}
            </button>
          </div>
        </Field>
        <div className={intentEnabled ? '' : 'opacity-40 pointer-events-none'}>
          <Field label="Intent Model" hint="Lightweight model used for pre-call intent classification">
            <ModelAutocomplete
              models={models}
              loading={loading}
              value={intentModel}
              onChange={(id) => saveSetting('intentModel', id)}
              onRefresh={refresh}
            />
            <p className="mt-1 text-xs" style={{ color: 'var(--muted-foreground)' }}>
              Default: claude-haiku-4-5-20251001 (fast, cheap, recommended)
            </p>
          </Field>
        </div>
      </div>

      <div style={{ height: '1px', background: 'var(--border)' }} />

      {/* Subagent Limits */}
      <div className="space-y-4">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>Subagent Limits</h3>
        <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
          Prevent unbounded subagent spawning that can exhaust memory and API quota.
        </p>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Max Depth" hint="Nesting levels (1 = top-level only)">
            <input
              type="number"
              min={1}
              max={10}
              value={maxSubagentDepth}
              onChange={e => saveSetting('maxSubagentDepth', Math.max(1, parseInt(e.target.value, 10) || 3))}
              className="w-full px-3 py-2 rounded-lg text-xs"
              style={{ background: 'var(--input)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
            />
          </Field>
          <Field label="Max Breadth" hint="Parallel subagents per parent">
            <input
              type="number"
              min={1}
              max={20}
              value={maxSubagentBreadth}
              onChange={e => saveSetting('maxSubagentBreadth', Math.max(1, parseInt(e.target.value, 10) || 5))}
              className="w-full px-3 py-2 rounded-lg text-xs"
              style={{ background: 'var(--input)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
            />
          </Field>
        </div>
      </div>

      <div style={{ height: '1px', background: 'var(--border)' }} />

      {/* Memory */}
      <div className="space-y-4">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>Cross-Conversation Memory</h3>
        <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
          Extracts key facts from conversations and recalls them in future sessions. Stored locally, never synced.
        </p>
        <Field label="Enable Memory" hint="Facts are extracted by a background haiku call after each turn">
          <button
            onClick={() => saveSetting('memoryEnabled', !memoryEnabled)}
            className="px-3 py-1.5 rounded-md text-xs transition-colors"
            style={{
              background: memoryEnabled ? 'var(--amber-muted)' : 'var(--surface-base)',
              color: memoryEnabled ? 'var(--amber)' : 'var(--muted-foreground)',
              border: memoryEnabled ? '1px solid var(--surface-stronger)' : '1px solid var(--border)',
            }}
          >
            {memoryEnabled ? 'Enabled' : 'Disabled'}
          </button>
        </Field>
      </div>

      <div style={{ height: '1px', background: 'var(--border)' }} />

      {/* Workspaces */}
      <div className="space-y-6">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>Workspaces</h3>
        <WorkspacesSection />
      </div>
    </div>
  )
}

// Connections = API Keys (+ future integrations)
function ConnectionsSection() {
  return (
    <div className="space-y-8">
      <SectionHeader title="Connections" subtitle="API keys and external integrations" />
      <ApiKeysSection />
    </div>
  )
}

// Account = Usage + About
function AccountSection() {
  return (
    <div className="space-y-10">
      <SectionHeader title="Account" subtitle="Usage, billing, and application info" />
      <div className="space-y-6">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>Usage</h3>
        <UsageSection />
      </div>
      <div style={{ height: '1px', background: 'var(--border)' }} />
      <div className="space-y-6">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>About</h3>
        <AboutSection />
      </div>
    </div>
  )
}

// ---------------- Models hook ----------------

function useSavedModels() {
  const [models, setModels] = useState<ModelInfo[]>([])
  const [loading, setLoading] = useState(false)

  const sortModels = (list: ModelInfo[]) => [...list].sort((left, right) => {
    const providerDelta = PROVIDER_ORDER.indexOf(left.provider) - PROVIDER_ORDER.indexOf(right.provider)
    if (providerDelta !== 0) return providerDelta
    return left.name.localeCompare(right.name)
  })

  const fetch = async () => {
    setLoading(true)
    try {
      const res = await window.wos.fetchSavedModels()
      if (res?.models?.length) setModels(sortModels(res.models))
      else {
        const fb = await window.wos.getFallbackModels()
        setModels(sortModels(fb))
      }
    } catch {
      try {
        const fb = await window.wos.getFallbackModels()
        setModels(sortModels(fb))
      } catch {}
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { fetch() }, [])
  return { models, loading, refresh: fetch }
}

function HuggingFaceSpacesSection({ onModelsChanged }: { onModelsChanged: () => Promise<void> | void }) {
  const [spaces, setSpaces] = useState<HuggingFaceSpaceInfo[]>([])
  const [source, setSource] = useState('')
  const [baseUrlOverride, setBaseUrlOverride] = useState('')
  const [loading, setLoading] = useState(false)

  const load = async () => {
    const res = await window.wos.listHuggingFaceSpaces()
    if (res.success) setSpaces(res.spaces)
  }

  useEffect(() => { void load() }, [])

  const inspect = async () => {
    if (!source.trim()) return
    setLoading(true)
    try {
      const res = await window.wos.inspectHuggingFaceSpace({
        source,
        baseUrlOverride: baseUrlOverride.trim() || null,
      })
      if (!res.success || !res.space) {
        toast.error(res.error ?? 'Could not load the Hugging Face Space.')
        return
      }
      toast.success(`Loaded ${res.space.spaceId}`)
      setSource('')
      setBaseUrlOverride('')
      await load()
      await Promise.resolve(onModelsChanged())
    } finally {
      setLoading(false)
    }
  }

  const remove = async (spaceId: string) => {
    await window.wos.removeHuggingFaceSpace(spaceId)
    toast.success(`Removed ${spaceId}`)
    await load()
    await Promise.resolve(onModelsChanged())
  }

  return (
    <div className="space-y-4">
      <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
        Add an OpenAI-compatible HF Space by slug or Hugging Face URL. Its exposed models will be merged into the main model selectors for both WOS and Meeting.
      </p>
      <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
        <input
          value={source}
          onChange={e => setSource(e.target.value)}
          placeholder="owner/space or https://huggingface.co/spaces/owner/space"
          className="w-full px-3 py-2 rounded-lg text-xs"
          style={{ background: 'var(--input)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
        />
        <input
          value={baseUrlOverride}
          onChange={e => setBaseUrlOverride(e.target.value)}
          placeholder="Optional base URL override"
          className="w-full px-3 py-2 rounded-lg text-xs"
          style={{ background: 'var(--input)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
        />
        <button
          onClick={() => { void inspect() }}
          disabled={!source.trim() || loading}
          className="px-3 py-2 rounded-lg text-xs font-medium disabled:opacity-40"
          style={{ background: 'var(--surface-raised)', color: 'var(--amber)', border: '1px solid var(--surface-strong)' }}
        >
          {loading ? 'Loading…' : 'Load Space'}
        </button>
      </div>
      <div className="space-y-2">
        {spaces.length === 0 && (
          <div style={{ color: 'var(--muted-foreground)', fontSize: '12px' }}>
            No Hugging Face Spaces saved yet.
          </div>
        )}
        {spaces.map(space => {
          const updatedLabel = space.updatedAt ? formatRelativeTime(new Date(space.updatedAt)) : null
          return (
            <div
              key={space.spaceId}
              className="rounded-xl p-4 space-y-3"
              style={{ background: 'var(--card)', border: '1px solid var(--border)' }}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium" style={{ color: 'var(--foreground)' }}>
                      {space.title ?? space.spaceId}
                    </span>
                    <span className="px-1.5 py-0.5 rounded text-[10px]"
                      style={{ background: 'var(--surface-base)', color: 'var(--secondary-foreground)' }}>
                      {space.sdk ?? 'unknown sdk'}
                    </span>
                    {space.runtimeStage && (
                      <span className="px-1.5 py-0.5 rounded text-[10px]"
                        style={{ background: 'var(--amber-muted)', color: 'var(--amber)' }}>
                        {space.runtimeStage}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 font-mono text-[11px] truncate" style={{ color: 'var(--border-strong)' }}>
                    {space.spaceId}
                  </div>
                  <div className="mt-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                    Owner: {space.author ?? 'unknown'}
                    {updatedLabel ? ` · Updated ${updatedLabel}` : ''}
                    {Array.isArray(space.modelIds) ? ` · ${space.modelIds.length} model${space.modelIds.length === 1 ? '' : 's'}` : ''}
                  </div>
                </div>
                <button
                  onClick={() => { void remove(space.spaceId) }}
                  className="p-1 rounded hover:text-red-400 transition-colors"
                  style={{ color: 'var(--border-strong)' }}
                  title="Remove space"
                >
                  <Trash2 size={12} />
                </button>
              </div>
              <div className="font-mono text-[10px] truncate" style={{ color: 'var(--secondary-foreground)' }}>
                {space.baseUrl}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---------------- General ----------------

function GeneralSection() {
  const { defaultModel, reasoningEffort, defaultMode, theme, saveSetting } = useSettingsStore()
  const { models, loading, refresh } = useSavedModels()

  const selected = models.find(m => m.id === defaultModel)
  const supportsReasoning = selected
    ? selected.supportsReasoning === true
    : modelSupportsReasoning(defaultModel)

  const THEME_OPTIONS: Array<{ id: 'dark' | 'light' | 'system'; label: string; icon: React.ElementType }> = [
    { id: 'dark', label: 'Dark', icon: Moon },
    { id: 'light', label: 'Light', icon: Sun },
    { id: 'system', label: 'System', icon: Monitor },
  ]

  return (
    <div className="space-y-8">
      <SectionHeader title="General" subtitle="Default model, reasoning, agent mode, and appearance" />

      <Field label="Default Model" hint="Used for new conversations">
        <ModelAutocomplete
          models={models}
          loading={loading}
          value={defaultModel}
          onChange={(id) => saveSetting('defaultModel', id)}
          onRefresh={refresh}
        />
        {selected?.description && (
          <div className="mt-2" style={{ color: 'var(--muted-foreground)', fontSize: '11px' }}>{selected.description}</div>
        )}
      </Field>

      <Field
        label="Reasoning Effort"
        hint={supportsReasoning
          ? 'Controls how much the model reasons before answering'
          : 'The selected model does not support reasoning.'}
      >
        <div className={supportsReasoning ? '' : 'opacity-40 pointer-events-none'}>
          <div className="flex items-center gap-1">
            {(['low', 'medium', 'high', 'max'] as const).map(e => (
              <button
                key={e}
                disabled={!supportsReasoning}
                onClick={() => saveSetting('reasoningEffort', e)}
                className="px-3 py-1 rounded-md capitalize transition-colors"
                style={{
                  fontSize: '11px',
                  background: reasoningEffort === e ? 'var(--surface-raised)' : 'var(--surface-base)',
                  color: reasoningEffort === e ? 'var(--amber)' : 'var(--muted-foreground)',
                  border: reasoningEffort === e ? '1px solid var(--surface-stronger)' : '1px solid transparent',
                }}
              >
                {e}
              </button>
            ))}
          </div>
        </div>
      </Field>

      <Field label="Default Mode" hint="Starting mode for new chats">
        <div className="flex items-center gap-1">
          {(['default', 'plan', 'yolo'] as AgentMode[]).map(m => (
            <button
              key={m}
              onClick={() => saveSetting('defaultMode', m)}
              className="px-3 py-1 rounded-md capitalize transition-colors"
              style={{
                fontSize: '11px',
                background: defaultMode === m ? 'var(--surface-raised)' : 'var(--surface-base)',
                color: defaultMode === m ? 'var(--amber)' : 'var(--muted-foreground)',
                border: defaultMode === m ? '1px solid var(--surface-stronger)' : '1px solid transparent',
              }}
            >
              {m}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Appearance" hint="Choose your color theme">
        <div className="flex items-center gap-1">
          {THEME_OPTIONS.map(opt => {
            const Icon = opt.icon
            const active = (theme ?? 'dark') === opt.id
            return (
              <button
                key={opt.id}
                onClick={() => saveSetting('theme', opt.id)}
                className="flex items-center gap-1.5 px-3 py-1 rounded-md transition-colors"
                style={{
                  fontSize: '11px',
                  background: active ? 'var(--surface-raised)' : 'var(--surface-base)',
                  color: active ? 'var(--amber)' : 'var(--muted-foreground)',
                  border: active ? '1px solid var(--surface-stronger)' : '1px solid transparent',
                }}
              >
                <Icon size={11} />
                {opt.label}
              </button>
            )
          })}
        </div>
      </Field>
    </div>
  )
}

// ---------------- Agents ----------------

type AgentSettingsRecord = {
  agentKey: string
  inheritFrom: string | null
  model: string | null
  mode: string | null
  systemPrompt: string | null
  config: Record<string, unknown>
}

function AgentsSection() {
  const { models, loading, refresh } = useSavedModels()
  const [agents, setAgents] = useState<Record<string, AgentSettingsRecord>>({})
  const [resolved, setResolved] = useState<Record<string, AgentSettingsRecord>>({})
  const [saving, setSaving] = useState<string | null>(null)

  const load = async () => {
    const res = await window.wos.getAgentSettings()
    const direct = Object.fromEntries(res.agents.map(a => [a.agentKey, a]))
    const resolvedMap = Object.fromEntries(res.resolved.map(a => [a.agentKey, a]))
    setAgents(direct)
    setResolved(resolvedMap)
  }

  useEffect(() => { void load() }, [])

  const save = async (agentKey: 'wos' | 'meeting', patch: Partial<AgentSettingsRecord>, apiKeys?: Record<string, string>) => {
    const current = agents[agentKey] ?? { agentKey, inheritFrom: agentKey === 'meeting' ? 'wos' : null, model: null, mode: null, systemPrompt: null, config: {} }
    setSaving(agentKey)
    await window.wos.saveAgentSettings({
      ...current,
      ...patch,
      config: { ...current.config, ...(patch.config ?? {}) },
      apiKeys,
    })
    await load()
    setSaving(null)
    toast.success(`${agentKey === 'meeting' ? 'Meeting Agent' : 'WOS Main Agent'} saved`)
  }

  return (
    <div className="space-y-6">
      <SectionHeader title="Agents" subtitle="Configure WOS Main and the dedicated Meeting Agent independently." />
      <AgentCard
        title="WOS Main Agent"
        agentKey="wos"
        agent={agents.wos}
        resolved={resolved.wos}
        models={models}
        loading={loading}
        onRefreshModels={refresh}
        saving={saving === 'wos'}
        onSave={save}
      />
      <AgentCard
        title="Meeting Agent"
        agentKey="meeting"
        agent={agents.meeting}
        resolved={resolved.meeting}
        models={models}
        loading={loading}
        onRefreshModels={refresh}
        saving={saving === 'meeting'}
        onSave={save}
      />
    </div>
  )
}

function AgentCard({
  title,
  agentKey,
  agent,
  resolved,
  models,
  loading,
  onRefreshModels,
  saving,
  onSave,
}: {
  title: string
  agentKey: 'wos' | 'meeting'
  agent?: AgentSettingsRecord
  resolved?: AgentSettingsRecord
  models: ModelInfo[]
  loading: boolean
  onRefreshModels: () => void
  saving: boolean
  onSave: (agentKey: 'wos' | 'meeting', patch: Partial<AgentSettingsRecord>, apiKeys?: Record<string, string>) => Promise<void>
}) {
  const inherits = agentKey === 'meeting' && (agent?.inheritFrom ?? 'wos') === 'wos'
  const [model, setModel] = useState(agent?.model ?? resolved?.model ?? '')
  const [mode, setMode] = useState((agent?.mode ?? resolved?.mode ?? 'default') as AgentMode)
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt ?? resolved?.systemPrompt ?? '')
  const [inherit, setInherit] = useState(inherits)
  const [openaiKey, setOpenaiKey] = useState('')
  const [anthropicKey, setAnthropicKey] = useState('')
  const [huggingFaceKey, setHuggingFaceKey] = useState('')

  useEffect(() => {
    setModel(agent?.model ?? resolved?.model ?? '')
    setMode((agent?.mode ?? resolved?.mode ?? 'default') as AgentMode)
    setSystemPrompt(agent?.systemPrompt ?? resolved?.systemPrompt ?? '')
    setInherit(agentKey === 'meeting' && (agent?.inheritFrom ?? 'wos') === 'wos')
  }, [agent, resolved, agentKey])

  const disabledByInherit = agentKey === 'meeting' && inherit
  const inputStyle = { background: 'var(--input)', border: '1px solid var(--border)', color: 'var(--foreground)', fontSize: '12px' }

  return (
    <div className="rounded-xl p-4 space-y-4" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-medium" style={{ color: 'var(--foreground)', fontSize: '14px' }}>{title}</h3>
          <p style={{ color: 'var(--muted-foreground)', fontSize: '11px' }}>
            Resolved model: {resolved?.model || 'not selected'}
          </p>
        </div>
        {agentKey === 'meeting' && (
          <label className="flex items-center gap-2" style={{ color: 'var(--secondary-foreground)', fontSize: '12px' }}>
            <input type="checkbox" checked={inherit} onChange={e => setInherit(e.target.checked)} />
            Inherit WOS Main
          </label>
        )}
      </div>

      <div className={disabledByInherit ? 'opacity-50 pointer-events-none' : ''}>
        <Field label="Model">
          <ModelAutocomplete models={models} loading={loading} value={model} onChange={setModel} onRefresh={onRefreshModels} />
        </Field>
      </div>

      <Field label="Mode">
        <div className={`flex items-center gap-1 ${disabledByInherit ? 'opacity-50 pointer-events-none' : ''}`}>
          {(['default', 'plan', 'yolo'] as AgentMode[]).map(m => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className="px-3 py-1 rounded-md capitalize"
              style={{
                fontSize: '11px',
                background: mode === m ? 'var(--surface-raised)' : 'var(--surface-base)',
                color: mode === m ? 'var(--amber)' : 'var(--muted-foreground)',
              }}
            >
              {m}
            </button>
          ))}
        </div>
      </Field>

      <Field label="System Prompt">
        <textarea
          value={systemPrompt}
          disabled={disabledByInherit}
          onChange={e => setSystemPrompt(e.target.value)}
          className="w-full min-h-[110px] px-3 py-2 rounded-md outline-none font-mono disabled:opacity-50"
          style={inputStyle}
        />
      </Field>

      <div className="grid gap-3 md:grid-cols-3">
        <Field label={`OpenAI key ${agent?.config?.openaiApiKeySet ? '(configured)' : ''}`}>
          <input type="password" value={openaiKey} onChange={e => setOpenaiKey(e.target.value)} className="w-full px-3 py-2 rounded-md outline-none" style={inputStyle} placeholder="Leave blank to keep current" />
        </Field>
        <Field label={`Anthropic key ${agent?.config?.anthropicApiKeySet ? '(configured)' : ''}`}>
          <input type="password" value={anthropicKey} onChange={e => setAnthropicKey(e.target.value)} className="w-full px-3 py-2 rounded-md outline-none" style={inputStyle} placeholder="Leave blank to keep current" />
        </Field>
        <Field label={`Hugging Face token ${agent?.config?.huggingFaceApiKeySet ? '(configured)' : ''}`}>
          <input type="password" value={huggingFaceKey} onChange={e => setHuggingFaceKey(e.target.value)} className="w-full px-3 py-2 rounded-md outline-none" style={inputStyle} placeholder="Leave blank to keep current" />
        </Field>
      </div>

      <button
        disabled={saving}
        onClick={() => onSave(agentKey, {
          inheritFrom: agentKey === 'meeting' && inherit ? 'wos' : null,
          model: disabledByInherit ? null : model,
          mode: disabledByInherit ? null : mode,
          systemPrompt: disabledByInherit ? null : systemPrompt,
        }, {
          ...(openaiKey ? { openai: openaiKey } : {}),
          ...(anthropicKey ? { anthropic: anthropicKey } : {}),
          ...(huggingFaceKey ? { 'huggingface-space': huggingFaceKey } : {}),
        }).then(() => { setOpenaiKey(''); setAnthropicKey(''); setHuggingFaceKey('') })}
        className="px-3 py-1.5 rounded-md disabled:opacity-50"
        style={{ background: 'var(--surface-raised)', color: 'var(--amber)', border: '1px solid var(--surface-strong)', fontSize: '12px' }}
      >
        {saving ? 'Saving...' : 'Save Agent'}
      </button>
    </div>
  )
}

function ModelAutocomplete({
  models, loading, value, onChange, onRefresh,
}: {
  models: ModelInfo[]
  loading: boolean
  value: string
  onChange: (id: string) => void
  onRefresh: () => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return models
    return models.filter(m =>
      m.id.toLowerCase().includes(q) ||
      m.name.toLowerCase().includes(q) ||
      getProviderLabel(m.provider).toLowerCase().includes(q)
    )
  }, [models, query])

  const selected = models.find(m => m.id === value)
  const selectedProvider = selected?.provider ?? getProviderFromModel(value)

  return (
    <div ref={ref} className="relative">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setOpen(o => !o)}
          className="flex items-center justify-between flex-1 px-3 py-1.5 rounded-md wos-hover transition-colors"
          style={{ background: 'var(--card)', border: '1px solid var(--border)', fontSize: '12px' }}
        >
          <span className="flex items-center gap-2 truncate" style={{ color: 'var(--foreground)' }}>
            <span style={{ color: 'var(--muted-foreground)' }}>{getProviderLabel(selectedProvider)}</span>
            <span>{selected?.name ?? value}</span>
            {selected && <ModelCapPills m={selected} />}
          </span>
          <ChevronDown size={12} style={{ color: 'var(--muted-foreground)' }} />
        </button>
        <button
          onClick={onRefresh}
          title="Refresh model list"
          className="p-1.5 rounded-md wos-hover"
          style={{ color: 'var(--muted-foreground)' }}
        >
          {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
        </button>
      </div>

      {open && (
        <div
          className="absolute top-full left-0 right-0 mt-1 rounded-md overflow-hidden z-50 max-h-80 overflow-y-auto"
          style={{ background: 'var(--popover)', border: '1px solid var(--border)', boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }}
        >
          <div className="sticky top-0 p-2" style={{ background: 'var(--popover)', borderBottom: '1px solid var(--border)' }}>
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={`Search ${models.length} models…`}
              className="w-full px-2 py-1 rounded outline-none"
              style={{ background: 'var(--input)', border: '1px solid var(--border)', color: 'var(--foreground)', fontSize: '12px' }}
            />
          </div>
          {filtered.length === 0 && (
            <div className="px-3 py-4" style={{ color: 'var(--muted-foreground)', fontSize: '12px' }}>
              {loading ? 'Loading…' : 'No models match. Add an API key in API Keys.'}
            </div>
          )}
          {filtered.map(m => (
            <button
              key={m.id}
              onClick={() => { onChange(m.id); setOpen(false); setQuery('') }}
              className={`w-full text-left px-3 py-1.5 flex items-center justify-between wos-hover-sm ${
                m.id === value ? 'wos-sidebar-active' : ''
              }`}
            >
              <span className="flex items-center gap-2 min-w-0">
                <span className="font-mono uppercase" style={{ color: 'var(--border-strong)', fontSize: '9px' }}>
                  {getProviderLabel(m.provider)}
                </span>
                <span className="truncate" style={{ color: 'var(--foreground)', fontSize: '12px' }}>
                  {m.name}
                </span>
              </span>
              <ModelCapPills m={m} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ModelCapPills({ m }: { m: ModelInfo }) {
  const pills: React.ReactNode[] = []
  if (m.contextWindow) {
    const k = m.contextWindow >= 1_000_000 ? `${(m.contextWindow / 1_000_000).toFixed(0)}M` : `${Math.round(m.contextWindow / 1000)}k`
    pills.push(
      <span key="ctx" className="px-1.5 py-0.5 rounded" style={{ background: 'var(--card)', color: 'var(--border-strong)', fontSize: '9px' }}>{k}</span>
    )
  }
  if (m.supportsReasoning) {
    pills.push(
      <span key="r" title="Reasoning" className="px-1 rounded flex items-center gap-0.5 text-purple-300"
        style={{ background: 'rgba(139, 92, 246, 0.1)', fontSize: '9px' }}>
        <Brain size={8} />R
      </span>
    )
  }
  if (m.supportsVision) {
    pills.push(
      <span key="v" title="Vision" className="px-1 rounded flex items-center gap-0.5 text-emerald-300"
        style={{ background: 'rgba(16, 185, 129, 0.1)', fontSize: '9px' }}>
        <Eye size={8} />V
      </span>
    )
  }
  return <span className="flex items-center gap-1 shrink-0">{pills}</span>
}

// ---------------- API Keys ----------------

function ApiKeysSection() {
  const [presence, setPresence] = useState<Record<string, boolean>>({})
  useEffect(() => {
    window.wos.getApiKeysPresence().then(setPresence)
  }, [])

  const refreshPresence = async () => setPresence(await window.wos.getApiKeysPresence())

  return (
    <div className="space-y-6">
      <SectionHeader title="API Keys" subtitle="Keys are stored encrypted using your OS keychain" />
      <ApiKeyRow provider="openai" label="OpenAI" hasKey={!!presence.openai} onChange={refreshPresence} />
      <ApiKeyRow provider="anthropic" label="Anthropic" hasKey={!!presence.anthropic} onChange={refreshPresence} />
      <ApiKeyRow provider="huggingface-space" label="Hugging Face" hasKey={!!presence['huggingface-space']} onChange={refreshPresence} />
    </div>
  )
}

function ApiKeyRow({
  provider, label, hasKey, onChange,
}: { provider: 'openai' | 'anthropic' | 'huggingface-space'; label: string; hasKey: boolean; onChange: () => void }) {
  const [value, setValue] = useState('')
  const [state, setState] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const credentialLabel = provider === 'huggingface-space' ? 'token' : 'API key'

  const test = async () => {
    if (!value) return
    setState('testing'); setError(null)
    const r = await window.wos.testApiKey(provider, value)
    if (r.ok) setState('ok')
    else { setState('error'); setError(r.error ?? 'Failed') }
  }

  const save = async () => {
    if (!value) return
    setState('testing'); setError(null)
    const r = await window.wos.testApiKey(provider, value)
    if (!r.ok) { setState('error'); setError(r.error ?? 'Failed'); return }
    await window.wos.saveApiKey(provider, value)
    toast.success(`${label} key saved`)
    setValue(''); setState('idle')
    onChange()
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <div style={{ color: 'var(--foreground)', fontSize: '13px' }}>{label}</div>
          <div style={{ color: 'var(--muted-foreground)', fontSize: '11px' }}>
            {hasKey ? '✓ Key configured' : 'No key saved'}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="password"
          value={value}
          onChange={e => setValue(e.target.value)}
          placeholder={hasKey ? '••••••••  (paste to replace)' : `Paste ${label} ${credentialLabel}`}
          className="flex-1 px-3 py-1.5 rounded-md outline-none"
          style={{ background: 'var(--input)', border: '1px solid var(--border)', color: 'var(--foreground)', fontSize: '12px' }}
        />
        <button
          onClick={test}
          disabled={!value || state === 'testing'}
          className="px-3 py-1.5 rounded-md wos-hover disabled:opacity-30 transition-colors"
          style={{ background: 'var(--card)', color: 'var(--foreground)', fontSize: '12px', border: '1px solid var(--border)' }}
        >
          {state === 'testing' ? <Loader2 size={12} className="animate-spin" /> : 'Test'}
        </button>
        <button
          onClick={save}
          disabled={!value || state === 'testing'}
          className="px-3 py-1.5 rounded-md disabled:opacity-30 transition-colors"
          style={{ background: 'var(--surface-strong)', color: 'var(--amber)', border: '1px solid var(--surface-stronger)', fontSize: '12px' }}
        >
          Save
        </button>
      </div>
      {state === 'ok' && (
        <div className="flex items-center gap-1 text-emerald-400" style={{ fontSize: '11px' }}>
          <CheckCircle2 size={12} /> {provider === 'huggingface-space' ? 'Token is valid' : 'Key is valid'}
        </div>
      )}
      {state === 'error' && error && (
        <div className="flex items-center gap-1 text-red-400" style={{ fontSize: '11px' }}>
          <XCircle size={12} /> {error}
        </div>
      )}
    </div>
  )
}

// ---------------- Workspaces ----------------

function WorkspacesSection() {
  const { workspaces, activeWorkspaceId, addWorkspace, removeWorkspace, setActiveWorkspace } = useWorkspaceStore()
  return (
    <div className="space-y-6">
      <SectionHeader title="Workspaces" subtitle="Directories the agent can access" />
      <div className="space-y-2">
        {workspaces.length === 0 && (
          <div style={{ color: 'var(--muted-foreground)', fontSize: '12px' }}>No workspaces yet</div>
        )}
        {workspaces.map(ws => (
          <div
            key={ws.id}
            className="flex items-center gap-2 px-3 py-2 rounded-md"
            style={{ background: 'var(--card)', border: '1px solid var(--border)' }}
          >
            <Folder size={12} className="shrink-0" style={{ color: 'var(--muted-foreground)' }} />
            <div className="flex-1 min-w-0">
              <div className="truncate" style={{ color: 'var(--foreground)', fontSize: '12px' }}>{ws.name}</div>
              <div className="truncate font-mono" style={{ color: 'var(--border-strong)', fontSize: '10px' }}>{ws.path}</div>
            </div>
            {activeWorkspaceId === ws.id ? (
              <span className="text-emerald-400" style={{ fontSize: '10px' }}>Active</span>
            ) : (
              <button
                onClick={() => setActiveWorkspace(ws.id)}
                className="hover:opacity-100 opacity-70 transition-opacity"
                style={{ color: 'var(--secondary-foreground)', fontSize: '11px' }}
              >
                Set active
              </button>
            )}
            <button
              onClick={() => removeWorkspace(ws.id)}
              className="p-1 rounded hover:text-red-400 transition-colors"
              style={{ color: 'var(--border-strong)' }}
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
      <button
        onClick={() => addWorkspace()}
        className="flex items-center gap-2 px-3 py-1.5 rounded-md transition-colors"
        style={{ background: 'var(--surface-raised)', color: 'var(--amber)', border: '1px solid var(--surface-strong)', fontSize: '12px' }}
      >
        <Plus size={12} /> Open workspace…
      </button>
    </div>
  )
}

// ---------------- Usage ----------------

function UsageSection() {
  const sessionTokens = (useAgentStore(s => s.sessionTokens) ?? { input: 0, output: 0 })
  const total = sessionTokens.input + sessionTokens.output
  return (
    <div className="space-y-4">
      <SectionHeader title="Usage" subtitle="Session-scoped token totals. Resets when the app restarts." />
      <div className="grid grid-cols-3 gap-3">
        <StatCard label="Input tokens" value={sessionTokens.input.toLocaleString()} />
        <StatCard label="Output tokens" value={sessionTokens.output.toLocaleString()} />
        <StatCard label="Total" value={total.toLocaleString()} highlight />
      </div>
      <p style={{ color: 'var(--border-strong)', fontSize: '11px' }}>
        Cost estimates require per-model pricing which is provider-specific and changes frequently. We show
        raw token totals only to avoid stale numbers.
      </p>
    </div>
  )
}

function StatCard({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div
      className="rounded-md p-3"
      style={{
        background: highlight ? 'var(--surface-subtle)' : 'var(--card)',
        border: `1px solid ${highlight ? 'var(--surface-strong)' : 'var(--border)'}`,
      }}
    >
      <div style={{ color: 'var(--muted-foreground)', fontSize: '11px' }}>{label}</div>
      <div className="mt-1 font-medium" style={{ color: 'var(--foreground)', fontSize: '20px' }}>{value}</div>
    </div>
  )
}

// ---------------- About ----------------

function AboutSection() {
  const [version, setVersion] = useState('')
  useEffect(() => { window.wos.getVersion().then(setVersion) }, [])
  return (
    <div className="space-y-4">
      <SectionHeader title="About" subtitle={`WOS ${version ? 'v' + version : ''}`} />
      <button
        onClick={() => window.wos.openLogs()}
        className="px-3 py-1.5 rounded-md wos-hover transition-colors"
        style={{ background: 'var(--card)', color: 'var(--foreground)', border: '1px solid var(--border)', fontSize: '12px' }}
      >
        Open logs folder
      </button>
    </div>
  )
}

// ---------------- Automations ----------------

interface AutomationsConfig {
  masterEnabled: boolean
  launchAtLogin: boolean
  defaultTimezone: string
  webhookPort: number
  tunnelProvider: 'cloudflared' | 'none'
  ledgerRetentionDays: number
  sandboxDir: string
  subagentPromptOverride: string
}

const AUTOMATIONS_DEFAULTS: AutomationsConfig = {
  masterEnabled: true,
  launchAtLogin: false,
  defaultTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  webhookPort: 47817,
  tunnelProvider: 'none',
  ledgerRetentionDays: 30,
  sandboxDir: '',
  subagentPromptOverride: '',
}

const AUTOMATIONS_KEYS: (keyof AutomationsConfig)[] = [
  'masterEnabled', 'launchAtLogin', 'defaultTimezone', 'webhookPort',
  'tunnelProvider', 'ledgerRetentionDays', 'sandboxDir',
  'subagentPromptOverride',
]

function AutomationsSection() {
  const [cfg, setCfg] = useState<AutomationsConfig>(AUTOMATIONS_DEFAULTS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)
  const [counts, setCounts] = useState<{ total: number; enabled: number }>({ total: 0, enabled: 0 })

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const all = (await window.wos.getSettings()) as Record<string, unknown>
        if (cancelled) return
        const next: AutomationsConfig = { ...AUTOMATIONS_DEFAULTS }
        for (const k of AUTOMATIONS_KEYS) {
          const v = all[`automations.${k}`]
          if (v !== undefined && v !== null) (next as unknown as Record<string, unknown>)[k] = v
        }
        setCfg(next)
        try {
          const list = await window.wos.automations.list()
          setCounts({ total: list.length, enabled: list.filter(a => a.enabled).length })
        } catch { /* ignore */ }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const update = async <K extends keyof AutomationsConfig>(key: K, value: AutomationsConfig[K]) => {
    setSaving(key as string)
    setCfg(c => ({ ...c, [key]: value }))
    try {
      await window.wos.setSetting(`automations.${key}`, value)
      // Trigger runtime reload so changes apply (esp. webhook port / tunnel)
      try { await window.wos.automations.reloadAll() } catch { /* ignore */ }
      toast.success('Saved', { id: 'auto-save', duration: 1200 })
    } catch (err) {
      toast.error(`Save failed: ${(err as Error).message}`)
    } finally {
      setSaving(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-4 w-4 animate-spin" style={{ color: 'var(--muted-foreground)' }} />
      </div>
    )
  }

  return (
    <div className="space-y-10">
      <SectionHeader
        title="Automations"
        subtitle={`${counts.enabled} active · ${counts.total} total. Settings affect the background daemon.`}
      />

      {/* Master controls */}
      <div className="space-y-6">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>Master controls</h3>

        <Toggle
          label="Automations enabled"
          hint="Master switch. When off, no schedules, hooks, or webhooks fire."
          checked={cfg.masterEnabled}
          saving={saving === 'masterEnabled'}
          onChange={v => update('masterEnabled', v)}
        />

        <Toggle
          label="Launch at login"
          hint="Start WOS in the background when you log in so automations run unattended."
          checked={cfg.launchAtLogin}
          saving={saving === 'launchAtLogin'}
          onChange={v => update('launchAtLogin', v)}
        />

        <Field label="Default timezone" hint="Used when scheduling new cron automations.">
          <input
            type="text"
            value={cfg.defaultTimezone}
            onChange={e => setCfg(c => ({ ...c, defaultTimezone: e.target.value }))}
            onBlur={e => update('defaultTimezone', e.target.value)}
            className="w-full px-2 py-1.5 rounded-md font-mono"
            style={{ background: 'var(--surface-base)', border: '1px solid var(--border)', color: 'var(--foreground)', fontSize: '12px' }}
          />
        </Field>
      </div>

      {/* Webhooks */}
      <div className="space-y-6">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>Webhooks & tunnels</h3>

        <Field label="Local webhook port" hint="Embedded HTTP server for incoming webhook events.">
          <input
            type="number"
            min={1024}
            max={65535}
            value={cfg.webhookPort}
            onChange={e => setCfg(c => ({ ...c, webhookPort: Number(e.target.value) }))}
            onBlur={e => update('webhookPort', Number(e.target.value))}
            className="w-32 px-2 py-1.5 rounded-md font-mono"
            style={{ background: 'var(--surface-base)', border: '1px solid var(--border)', color: 'var(--foreground)', fontSize: '12px' }}
          />
        </Field>

        <Field label="Public tunnel" hint="How webhook URLs are exposed to the internet.">
          <div className="flex items-center gap-1">
            {(['cloudflared', 'none'] as const).map(p => (
              <button
                key={p}
                onClick={() => update('tunnelProvider', p)}
                className="px-3 py-1.5 rounded-md transition-colors"
                style={{
                  fontSize: '12px',
                  background: cfg.tunnelProvider === p ? 'var(--amber-muted)' : 'var(--surface-base)',
                  color: cfg.tunnelProvider === p ? 'var(--amber)' : 'var(--muted-foreground)',
                  border: cfg.tunnelProvider === p ? '1px solid var(--surface-stronger)' : '1px solid transparent',
                }}
              >
                {p === 'cloudflared' ? 'Cloudflared (auto-tunnel)' : 'None (local only)'}
              </button>
            ))}
          </div>
        </Field>
      </div>

      {/* Limits & safety */}
      <div className="space-y-6">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>Limits & safety</h3>

        <Field label="Tasks ledger retention (days)" hint="Older entries are auto-pruned.">
          <input
            type="number"
            min={1}
            value={cfg.ledgerRetentionDays}
            onChange={e => setCfg(c => ({ ...c, ledgerRetentionDays: Number(e.target.value) }))}
            onBlur={e => update('ledgerRetentionDays', Number(e.target.value))}
            className="w-32 px-2 py-1.5 rounded-md font-mono"
            style={{ background: 'var(--surface-base)', border: '1px solid var(--border)', color: 'var(--foreground)', fontSize: '12px' }}
          />
        </Field>

        <Field label="Sandbox directory override" hint="Defaults to ~/.wos/automations/runs/ — leave blank for default.">
          <input
            type="text"
            value={cfg.sandboxDir}
            placeholder="~/.wos/automations/runs/"
            onChange={e => setCfg(c => ({ ...c, sandboxDir: e.target.value }))}
            onBlur={e => update('sandboxDir', e.target.value)}
            className="w-full px-2 py-1.5 rounded-md font-mono"
            style={{ background: 'var(--surface-base)', border: '1px solid var(--border)', color: 'var(--foreground)', fontSize: '12px' }}
          />
        </Field>
      </div>

      {/* Author subagent */}
      <div className="space-y-6">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>Automation author subagent</h3>
        <Field
          label="System prompt override"
          hint="Leave blank to use the built-in prompt. Custom prompt is appended after the default."
        >
          <textarea
            value={cfg.subagentPromptOverride}
            onChange={e => setCfg(c => ({ ...c, subagentPromptOverride: e.target.value }))}
            onBlur={e => update('subagentPromptOverride', e.target.value)}
            rows={6}
            placeholder="(uses default subagent prompt)"
            className="w-full px-2 py-1.5 rounded-md font-mono"
            style={{ background: 'var(--surface-base)', border: '1px solid var(--border)', color: 'var(--foreground)', fontSize: '11px' }}
          />
        </Field>
      </div>
    </div>
  )
}

function Toggle({ label, hint, checked, saving, onChange }: {
  label: string
  hint?: string
  checked: boolean
  saving?: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="space-y-1.5">
      <label className="flex items-center justify-between gap-3">
        <span style={{ color: 'var(--secondary-foreground)', fontSize: '12px' }}>{label}</span>
        <button
          type="button"
          onClick={() => onChange(!checked)}
          disabled={saving}
          className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors"
          style={{ background: checked ? 'var(--amber)' : 'var(--surface-base)', border: '1px solid var(--border)' }}
        >
          <span
            className="inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform"
            style={{ transform: checked ? 'translateX(18px)' : 'translateX(2px)' }}
          />
        </button>
      </label>
      {hint && <div style={{ color: 'var(--muted-foreground)', fontSize: '11px' }}>{hint}</div>}
    </div>
  )
}

// ---------------- Shared ----------------

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div>
      <h2 className="font-medium" style={{ color: 'var(--foreground)', fontSize: '18px' }}>{title}</h2>
      {subtitle && <p className="mt-1" style={{ color: 'var(--muted-foreground)', fontSize: '12px' }}>{subtitle}</p>}
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="block" style={{ color: 'var(--secondary-foreground)', fontSize: '12px' }}>{label}</label>
      {children}
      {hint && <div style={{ color: 'var(--muted-foreground)', fontSize: '11px' }}>{hint}</div>}
    </div>
  )
}

