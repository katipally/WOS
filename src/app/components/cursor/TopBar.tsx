import React, { useEffect, useRef, useState } from 'react'
import { PanelLeft, Cpu, FolderOpen, Check, Plus, ChevronDown, Trash2 } from 'lucide-react'
import type { ViewType } from '../../../types'
import { useAgentStore } from '../../../store/agentStore'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { formatTokens } from '../../../lib/utils'

interface WorkspacePickerProps {
  activeConversationId?: string | null
}

interface TopBarProps {
  currentView: ViewType
  isSidebarCollapsed: boolean
  onToggleSidebar: () => void
  onRenameConversation?: (id: string, title: string) => void
}

export function TopBar({ currentView, isSidebarCollapsed, onToggleSidebar, onRenameConversation }: TopBarProps) {
  const { conversations, activeConversationId } = useAgentStore()
  const activeConv = conversations.find(c => c.id === activeConversationId)

  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [titleValue, setTitleValue] = useState('')
  const titleInputRef = useRef<HTMLInputElement>(null)

  const title = (() => {
    if (currentView === 'settings') return 'Settings'
    if (currentView === 'apps') return 'Apps'
    if (currentView === 'automations') return 'Automations'
    if (currentView === 'meetings') return 'Meetings'
    if (currentView === 'chat' && activeConv) return activeConv.title
    return null
  })()

  const isTitleEditable = currentView === 'chat' && !!activeConv && !!onRenameConversation

  const startEdit = () => {
    if (!isTitleEditable) return
    setTitleValue(activeConv!.title)
    setIsEditingTitle(true)
    setTimeout(() => titleInputRef.current?.select(), 0)
  }

  const commitEdit = () => {
    const trimmed = titleValue.trim()
    if (trimmed && activeConv && onRenameConversation) {
      onRenameConversation(activeConv.id, trimmed)
    }
    setIsEditingTitle(false)
  }

  const handleTitleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') commitEdit()
    else if (e.key === 'Escape') setIsEditingTitle(false)
  }

  useEffect(() => {
    if (!isEditingTitle) return
    if (activeConv?.id) setTitleValue(activeConv.title)
  }, [activeConv?.id])

  const showWorkspacePicker = currentView === 'chat' || currentView === 'home'

  return (
    <div
      className="shrink-0 h-[38px] flex items-center px-3 gap-2 titlebar-drag"
      style={{
        background: 'var(--topbar)',
        borderBottom: '1px solid var(--border)',
        WebkitAppRegion: 'drag',
      } as React.CSSProperties & { WebkitAppRegion?: string }}
    >
      {/* macOS traffic lights spacer */}
      <div className="shrink-0 w-16" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties & { WebkitAppRegion?: string }} />

      {/* Sidebar toggle */}
      <button
        onClick={onToggleSidebar}
        className="p-1 rounded wos-hover transition-colors shrink-0"
        style={{
          color: 'var(--zinc-500)',
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties & { WebkitAppRegion?: string }}
        title={isSidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
      >
        <PanelLeft size={13} />
      </button>

      {/* WOS wordmark */}
      <span
        className="shrink-0 font-bold tracking-widest select-none"
        style={{
          fontSize: '13px',
          letterSpacing: '0.18em',
          background: 'linear-gradient(135deg, var(--foreground) 0%, var(--zinc-400) 100%)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          backgroundClip: 'text',
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties & { WebkitAppRegion?: string }}
      >
        WOS
      </span>

      {/* Center: title + workspace picker */}
      <div
        className="flex-1 flex items-center justify-center gap-2 min-w-0"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties & { WebkitAppRegion?: string }}
      >
        {title && !isEditingTitle && (
          <span
            className="truncate max-w-[260px]"
            style={{
              fontSize: '13px',
              color: 'var(--secondary-foreground)',
              cursor: isTitleEditable ? 'text' : 'default',
            }}
            onClick={startEdit}
            title={isTitleEditable ? 'Click to rename' : undefined}
          >
            {title}
          </span>
        )}
        {isEditingTitle && (
          <input
            ref={titleInputRef}
            value={titleValue}
            onChange={e => setTitleValue(e.target.value)}
            onKeyDown={handleTitleKey}
            onBlur={commitEdit}
            className="rounded px-2 py-0.5 outline-none max-w-[260px]"
            style={{
              fontSize: '13px',
              background: 'var(--input)',
              border: '1px solid var(--amber)',
              color: 'var(--foreground)',
              minWidth: '180px',
            }}
          />
        )}
        {showWorkspacePicker && (
          <WorkspacePicker activeConversationId={activeConversationId} />
        )}
      </div>

      {/* Token counter */}
      {activeConv && currentView === 'chat' && (
        <TokenCounter used={activeConv.tokenCount} limit={activeConv.contextLimit} />
      )}
    </div>
  )
}

function WorkspacePicker({ activeConversationId }: WorkspacePickerProps) {
  const { workspaces, activeWorkspace, setActiveWorkspace, addWorkspace, removeWorkspace } = useWorkspaceStore()
  const { setConversationWorkspace } = useAgentStore()
  const [open, setOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const handleSelect = async (id: string | null) => {
    await setActiveWorkspace(id)
    if (activeConversationId) {
      await setConversationWorkspace(activeConversationId, id)
    }
    setOpen(false)
  }

  const handleDelete = async (id: string) => {
    // Block deleting the last workspace.
    if (workspaces.length <= 1) {
      setConfirmDelete(null)
      return
    }
    const wasActive = activeWorkspace?.id === id
    await removeWorkspace(id)
    if (wasActive) {
      const next = workspaces.find(w => w.id !== id) ?? null
      await setActiveWorkspace(next ? next.id : null)
      if (activeConversationId) {
        await setConversationWorkspace(activeConversationId, next ? next.id : null)
      }
    }
    setConfirmDelete(null)
  }

  const confirmTarget = confirmDelete ? workspaces.find(w => w.id === confirmDelete) : null

  return (
    <div ref={ref} className="relative" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties & { WebkitAppRegion?: string }}>
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1 px-2 py-0.5 rounded wos-hover transition-colors"
        style={{ fontSize: '11px', color: 'var(--zinc-600)' }}
      >
        <span>/</span>
        <FolderOpen size={10} style={{ color: activeWorkspace ? 'var(--zinc-500)' : 'var(--zinc-700)' }} />
        <span style={{ color: activeWorkspace ? 'var(--zinc-400)' : 'var(--zinc-700)', fontFamily: 'monospace' }}>
          {activeWorkspace ? activeWorkspace.name : 'No workspace'}
        </span>
        <ChevronDown size={10} />
      </button>
      {open && (
        <div
          className="absolute top-full mt-1 left-1/2 -translate-x-1/2 rounded-xl overflow-hidden z-50"
          style={{
            background: 'var(--popover)',
            border: '1px solid var(--border-strong)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
            minWidth: '240px',
          }}
        >
          <div
            className="px-3 py-1.5"
            style={{ fontSize: '10px', color: 'var(--zinc-600)', textTransform: 'uppercase', letterSpacing: '0.08em', borderBottom: '1px solid var(--border)' }}
          >
            Workspace
          </div>
          <button
            onClick={() => handleSelect(null)}
            className="w-full text-left px-3 py-1.5 wos-hover-sm flex items-center gap-2"
            style={{ fontSize: '12px', color: 'var(--zinc-400)' }}
          >
            {!activeWorkspace && <Check size={10} style={{ color: 'var(--amber)' }} />}
            <span className={activeWorkspace ? 'ml-4' : ''}>No workspace</span>
          </button>
          {workspaces.map(ws => (
            <div
              key={ws.id}
              className="w-full px-3 py-1.5 wos-hover-sm flex items-center gap-2"
              style={{ fontSize: '12px', color: 'var(--foreground)' }}
            >
              <button
                onClick={() => handleSelect(ws.id)}
                className="flex-1 flex items-center gap-2 text-left min-w-0"
                style={{ color: 'var(--foreground)' }}
              >
                {activeWorkspace?.id === ws.id && <Check size={10} style={{ color: 'var(--amber)' }} />}
                <FolderOpen size={10} style={{ color: 'var(--zinc-600)' }} className="shrink-0" />
                <span className="truncate">{ws.name}</span>
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setConfirmDelete(ws.id) }}
                disabled={workspaces.length <= 1}
                className="p-1 rounded hover:text-red-400 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                title={workspaces.length <= 1 ? "Can't delete the last workspace" : 'Remove workspace'}
                style={{ color: 'var(--zinc-600)' }}
              >
                <Trash2 size={10} />
              </button>
            </div>
          ))}
          <button
            onClick={async () => { await addWorkspace(); setOpen(false) }}
            className="w-full text-left px-3 py-1.5 wos-hover-sm flex items-center gap-2"
            style={{ fontSize: '12px', color: 'var(--zinc-500)', borderTop: '1px solid var(--border)' }}
          >
            <Plus size={10} style={{ color: 'var(--zinc-600)' }} />
            Open workspace…
          </button>
        </div>
      )}
      {confirmTarget && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.5)' }}
          onClick={() => setConfirmDelete(null)}
        >
          <div
            onClick={e => e.stopPropagation()}
            className="rounded-xl p-4 max-w-sm w-full mx-4 space-y-3"
            style={{ background: 'var(--popover)', border: '1px solid var(--border-strong)', boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }}
          >
            <div style={{ color: 'var(--foreground)', fontSize: '13px', fontWeight: 500 }}>Remove workspace?</div>
            <div style={{ color: 'var(--zinc-400)', fontSize: '12px' }}>
              This removes <span className="font-mono">{confirmTarget.name}</span> from WOS. The folder on disk is not deleted.
            </div>
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                onClick={() => setConfirmDelete(null)}
                className="px-3 py-1.5 rounded-md"
                style={{ background: 'var(--surface-base)', color: 'var(--muted-foreground)', border: '1px solid var(--border)', fontSize: '12px' }}
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(confirmTarget.id)}
                className="px-3 py-1.5 rounded-md"
                style={{ background: 'rgba(239,68,68,0.15)', color: '#fca5a5', border: '1px solid rgba(239,68,68,0.3)', fontSize: '12px' }}
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function TokenCounter({ used, limit }: { used: number; limit: number }) {
  const pct = limit > 0 ? (used / limit) * 100 : 0
  const color = pct > 80 ? '#ef4444' : pct > 60 ? 'var(--amber)' : 'var(--zinc-600)'
  if (used === 0) return null
  return (
    <div
      className="flex items-center gap-1 shrink-0"
      style={{ color, fontSize: '10px', fontFamily: 'monospace' }}
    >
      <Cpu size={9} />
      <span>{formatTokens(used)} / {formatTokens(limit)}</span>
    </div>
  )
}
