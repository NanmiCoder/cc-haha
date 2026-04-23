import { useState } from 'react'
import { useChatStore } from '../../stores/chatStore'
import { useTabStore } from '../../stores/tabStore'
import { useTranslation } from '../../i18n'
import type { TranslationKey } from '../../i18n'
import { Button } from '../shared/Button'
import { DiffViewer } from './DiffViewer'

type Props = {
  requestId: string
  toolName: string
  input: unknown
  description?: string
}

/**
 * Icons for known tool types.
 * Uses Material Symbols Outlined names.
 */
const TOOL_META: Record<string, { icon: string; label: string; color: string }> = {
  Bash: { icon: 'terminal', label: 'Bash', color: 'var(--color-warning)' },
  Edit: { icon: 'edit_note', label: 'Edit File', color: 'var(--color-brand)' },
  Write: { icon: 'edit_document', label: 'Write File', color: 'var(--color-success)' },
  Read: { icon: 'description', label: 'Read File', color: 'var(--color-secondary)' },
  Glob: { icon: 'search', label: 'Glob Search', color: 'var(--color-secondary)' },
  Grep: { icon: 'find_in_page', label: 'Grep Search', color: 'var(--color-secondary)' },
  Agent: { icon: 'smart_toy', label: 'Agent', color: 'var(--color-tertiary)' },
  WebSearch: { icon: 'travel_explore', label: 'Web Search', color: 'var(--color-secondary)' },
  WebFetch: { icon: 'cloud_download', label: 'Web Fetch', color: 'var(--color-secondary)' },
  NotebookEdit: { icon: 'note', label: 'Notebook Edit', color: 'var(--color-brand)' },
  Skill: { icon: 'auto_awesome', label: 'Skill', color: 'var(--color-tertiary)' },
}

/**
 * Extract human-readable detail lines from tool input.
 */
function extractToolDetails(toolName: string, input: unknown, t: (key: TranslationKey, params?: Record<string, string | number>) => string): { primary: string; secondary?: string } {
  const obj = (input && typeof input === 'object') ? input as Record<string, unknown> : {}

  switch (toolName) {
    case 'Bash': {
      const cmd = typeof obj.command === 'string' ? obj.command : ''
      const desc = typeof obj.description === 'string' ? obj.description : undefined
      return { primary: cmd, secondary: desc }
    }
    case 'Edit': {
      const filePath = typeof obj.file_path === 'string' ? obj.file_path : ''
      return { primary: filePath, secondary: obj.old_string ? t('permission.replacingContent') : undefined }
    }
    case 'Write': {
      const filePath = typeof obj.file_path === 'string' ? obj.file_path : ''
      return { primary: filePath }
    }
    case 'Read': {
      const filePath = typeof obj.file_path === 'string' ? obj.file_path : ''
      return { primary: filePath }
    }
    case 'Glob':
      return { primary: typeof obj.pattern === 'string' ? obj.pattern : '' }
    case 'Grep':
      return { primary: typeof obj.pattern === 'string' ? obj.pattern : '' }
    case 'Agent':
      return { primary: typeof obj.description === 'string' ? obj.description : '' }
    case 'WebSearch':
      return { primary: typeof obj.query === 'string' ? obj.query : '' }
    case 'WebFetch':
      return { primary: typeof obj.url === 'string' ? obj.url : '' }
    default:
      return { primary: typeof input === 'string' ? input : JSON.stringify(input, null, 2) }
  }
}

function getPermissionTitle(toolName: string, input: unknown, t: (key: TranslationKey, params?: Record<string, string | number>) => string) {
  const obj = (input && typeof input === 'object') ? input as Record<string, unknown> : {}
  const filePath = typeof obj.file_path === 'string' ? obj.file_path : ''
  const fileName = filePath ? filePath.split('/').pop() || filePath : ''

  switch (toolName) {
    case 'Edit':
    case 'Write':
      return fileName ? t('permission.allowEditFile', { toolName, fileName }) : t('permission.allowEditFileGeneric', { toolName: toolName.toLowerCase() })
    case 'Bash':
      return t('permission.allowBash')
    default:
      return t('permission.allowTool', { toolName })
  }
}

function renderPermissionPreview(toolName: string, input: unknown) {
  const obj = (input && typeof input === 'object') ? input as Record<string, unknown> : {}
  const filePath = typeof obj.file_path === 'string' ? obj.file_path : 'file'

  if (toolName === 'Edit' && typeof obj.old_string === 'string' && typeof obj.new_string === 'string') {
    return <DiffViewer filePath={filePath} oldString={obj.old_string} newString={obj.new_string} />
  }

  if (toolName === 'Write' && typeof obj.content === 'string') {
    return <DiffViewer filePath={filePath} oldString="" newString={obj.content} />
  }

  if (toolName === 'Bash' && typeof obj.command === 'string') {
    return (
      <div className="overflow-x-auto rounded-[var(--radius-md)] bg-[var(--color-terminal-bg)] px-3 py-2.5">
        <pre className="font-[var(--font-mono)] text-[11px] leading-[1.3] text-[var(--color-terminal-fg)] whitespace-pre-wrap break-words">
          <span className="text-[var(--color-terminal-accent)] select-none">$ </span>{obj.command}
        </pre>
      </div>
    )
  }

  return null
}

export function PermissionDialog({ requestId, toolName, input, description }: Props) {
  const { respondToPermission } = useChatStore()
  const activeTabId = useTabStore((s) => s.activeTabId)
  const pendingPermission = useChatStore((s) => activeTabId ? s.sessions[activeTabId]?.pendingPermission : undefined)
  const t = useTranslation()
  const isPending = pendingPermission?.requestId === requestId
  const [showRaw, setShowRaw] = useState(false)

  const meta = TOOL_META[toolName] || { icon: 'shield', label: toolName, color: 'var(--color-text-tertiary)' }
  const details = extractToolDetails(toolName, input, t)
  const rawInput = typeof input === 'string' ? input : JSON.stringify(input, null, 2)
  const preview = renderPermissionPreview(toolName, input)
  const title = getPermissionTitle(toolName, input, t)
  const allowRawToggle = !preview

  return (
    <div className={`mb-4 ml-10 overflow-hidden rounded-[var(--radius-lg)] border ${
      isPending
        ? 'border-[var(--color-warning)] bg-[var(--color-surface-container-lowest)]'
        : 'border-[var(--color-outline-variant)]/40 bg-[var(--color-surface-container-low)] opacity-70'
    }`}>
      {/* Header */}
      <div className={`flex items-center gap-3 px-4 py-3 ${
        isPending
          ? 'bg-[var(--color-surface-container)]'
          : 'bg-[var(--color-surface-container-low)]'
      }`}>
        <div
          className="flex items-center justify-center w-8 h-8 rounded-[var(--radius-md)]"
          style={{ backgroundColor: `${meta.color}18` }}
        >
          <span
            className="material-symbols-outlined text-[18px]"
            style={{ color: meta.color }}
          >
            {meta.icon}
          </span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-[var(--color-text-primary)]">
              {title}
            </span>
            {isPending && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-[var(--color-warning)]/15 text-[var(--color-warning)]">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-warning)] animate-pulse-dot" />
                {t('permission.awaitingApproval')}
              </span>
            )}
            {!isPending && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-[var(--color-surface-container-high)] text-[var(--color-text-tertiary)]">
                {t('permission.responded')}
              </span>
            )}
          </div>
          {description && (
            <p className="mt-0.5 text-xs text-[var(--color-text-secondary)] truncate">{description}</p>
          )}
        </div>
      </div>

      {/* Tool details */}
      <div className="border-t border-[var(--color-outline-variant)]/20 px-4 py-3">
        {preview ? (
          <div className="space-y-2">
            {details.primary && toolName !== 'Bash' ? (
              <div className="flex items-center gap-2 rounded-[var(--radius-md)] bg-[var(--color-surface-container)] px-3 py-2 text-xs font-[var(--font-mono)] text-[var(--color-text-secondary)]">
                <span className="material-symbols-outlined text-[14px] text-[var(--color-outline)] flex-shrink-0">
                  folder_open
                </span>
                <span className="truncate">{details.primary}</span>
              </div>
            ) : null}
            {preview}
          </div>
        ) : details.primary ? (
          <div className="mb-2">
            <div className="flex items-center gap-2 rounded-[var(--radius-md)] bg-[var(--color-surface-container)] px-3 py-2 text-xs font-[var(--font-mono)] text-[var(--color-text-secondary)]">
              <span className="material-symbols-outlined text-[14px] text-[var(--color-outline)] flex-shrink-0">
                {toolName === 'Glob' || toolName === 'Grep' ? 'search' : 'folder_open'}
              </span>
              <span className="truncate">{details.primary}</span>
            </div>
          </div>
        ) : null}

        {/* Secondary detail */}
        {details.secondary && (
          <p className="mt-2 text-xs text-[var(--color-text-tertiary)]">{details.secondary}</p>
        )}

        {allowRawToggle && (
          <button
            onClick={() => setShowRaw(!showRaw)}
            className="mt-2 flex cursor-pointer items-center gap-1 text-[11px] text-[var(--color-text-accent)] hover:underline"
          >
            <span className="material-symbols-outlined text-[14px]">
              {showRaw ? 'expand_less' : 'expand_more'}
            </span>
            {showRaw ? t('permission.hideDetails') : t('permission.showFullInput')}
          </button>
        )}

        {allowRawToggle && showRaw && (
          <pre className="mt-2 max-h-[220px] overflow-y-auto overflow-x-auto rounded-[var(--radius-md)] bg-[var(--color-terminal-bg)] px-3 py-2.5 font-[var(--font-mono)] text-[11px] leading-[1.3] text-[var(--color-terminal-fg)] whitespace-pre-wrap break-words">
            {rawInput}
          </pre>
        )}
      </div>

      {/* Action buttons */}
      {isPending && (
        <div className="flex items-center gap-2 border-t border-[var(--color-outline-variant)]/20 bg-[var(--color-surface-container-low)] px-4 py-3">
          <Button
            variant="primary"
            size="sm"
            onClick={() => activeTabId && respondToPermission(activeTabId, requestId, true)}
            icon={
              <span className="material-symbols-outlined text-[14px]">check</span>
            }
          >
            {t('permission.allow')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => activeTabId && respondToPermission(activeTabId, requestId, true, { rule: 'always' })}
            icon={
              <span className="material-symbols-outlined text-[14px]">verified</span>
            }
          >
            {t('permission.allowForSession')}
          </Button>
          <div className="flex-1" />
          <Button
            variant="danger"
            size="sm"
            onClick={() => activeTabId && respondToPermission(activeTabId, requestId, false)}
            icon={
              <span className="material-symbols-outlined text-[14px]">close</span>
            }
          >
            {t('permission.deny')}
          </Button>
        </div>
      )}
    </div>
  )
}
