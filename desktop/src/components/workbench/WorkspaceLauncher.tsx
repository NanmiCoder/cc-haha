import { MessageCircle, FolderClosed, Globe, SquareTerminal, SquareSplitVertical } from 'lucide-react'
import { useTranslation } from '../../i18n'
import {
  detectPlatform,
  formatWorkspaceShortcut,
  type WorkspaceShortcutAction,
} from '../../lib/workspace/shortcuts'
import type { WorkspaceDock, WorkspaceTabKind } from '../../lib/workspace/types'

type LauncherEntry = {
  kind: WorkspaceTabKind
  labelKey: 'workspace.launcher.review' | 'workspace.launcher.terminal' | 'workspace.launcher.browser' | 'workspace.launcher.files' | 'sideChat.title'
  shortcut?: WorkspaceShortcutAction
  Icon: typeof Globe
}

/**
 * Order matches the reference: review, terminal, browser, files. It is not
 * alphabetical and not usage-ranked — it runs from "look at what changed" to
 * "look at anything", which is the order the work itself tends to go in.
 */
const ENTRIES: readonly LauncherEntry[] = [
  { kind: 'side-chat', labelKey: 'sideChat.title', Icon: MessageCircle },
  { kind: 'review', labelKey: 'workspace.launcher.review', shortcut: 'open-review', Icon: SquareSplitVertical },
  { kind: 'terminal', labelKey: 'workspace.launcher.terminal', shortcut: 'toggle-terminal', Icon: SquareTerminal },
  { kind: 'browser', labelKey: 'workspace.launcher.browser', shortcut: 'new-browser-tab', Icon: Globe },
  { kind: 'file', labelKey: 'workspace.launcher.files', shortcut: 'quick-open-file', Icon: FolderClosed },
]

export type WorkspaceLauncherProps = {
  onSelect: (kind: WorkspaceTabKind) => void
  /**
   * Bottom panels have less vertical space. The same four actions remain
   * available, with less outer padding so the last action stays reachable.
   */
  dock?: WorkspaceDock
  variant?: 'empty' | 'menu'
  /**
   * Why review cannot run here, if it cannot. A directory that is not a Git
   * repository still shows the entry — disabled with the reason — rather than
   * hiding it, so the absence reads as a fact about the folder instead of as a
   * missing feature.
   */
  reviewUnavailableReason?: string | null
  /**
   * A side chat forks the parent transcript, so a session with no
   * conversation yet has nothing to fork. Unlike review, the entry is left
   * out rather than disabled: it becomes available by talking, not by
   * changing the folder.
   */
  sideChatAvailable?: boolean
}

export function WorkspaceLauncher({
  onSelect,
  reviewUnavailableReason,
  sideChatAvailable = true,
  dock = 'side',
  variant = 'empty',
}: WorkspaceLauncherProps) {
  const t = useTranslation()
  const platform = detectPlatform()
  const compact = dock === 'bottom'
  const menu = variant === 'menu'

  return (
    <div
      data-testid={menu ? 'workspace-add-menu-items' : 'workspace-launcher'}
      className={menu ? '' : `flex min-h-0 flex-1 items-start justify-center overflow-y-auto ${compact ? 'px-4 py-2' : 'px-6 py-10'}`}
    >
      <ul className={menu ? 'space-y-px' : 'my-auto w-full max-w-[420px] space-y-px'} role={menu ? 'presentation' : undefined} aria-label={menu ? undefined : t('workspace.launcher.label')}>
        {ENTRIES.filter(entry => entry.kind !== 'side-chat' || (dock !== 'bottom' && sideChatAvailable)).map(({ kind, labelKey, shortcut, Icon }) => {
          const disabledReason = kind === 'review' ? reviewUnavailableReason ?? null : null
          // The hint advertises the app command; a pointer choice uses this dock.
          const hint = shortcut ? formatWorkspaceShortcut(shortcut, platform) : null
          return (
            <li key={kind} role={menu ? 'presentation' : undefined}>
              <button
                type="button"
                role={menu ? 'menuitem' : undefined}
                aria-label={menu ? t(labelKey) : undefined}
                data-testid={`${menu ? 'workspace-menu' : 'workspace-launcher'}-${kind}`}
                disabled={disabledReason !== null}
                title={disabledReason ?? undefined}
                onClick={() => onSelect(kind)}
                className={`group flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2 text-left text-[13px] transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent ${menu || compact ? 'h-8' : 'h-9'}`}
              >
                <Icon
                  size={16}
                  strokeWidth={1.75}
                  aria-hidden="true"
                  className="shrink-0 text-[var(--color-text-tertiary)] group-hover:text-[var(--color-text-secondary)]"
                />
                <span className="min-w-0 flex-1 truncate text-[var(--color-text-primary)]">
                  {t(labelKey)}
                </span>
                {disabledReason ? (
                  <span className="max-w-[60%] shrink-0 truncate text-[12px] text-[var(--color-text-tertiary)]">
                    {disabledReason}
                  </span>
                ) : hint ? (
                  <kbd className="inline-flex h-[18px] shrink-0 items-center rounded-[var(--radius-xs)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-1 font-mono text-[11px] leading-none text-[var(--color-text-tertiary)]">
                    {hint}
                  </kbd>
                ) : null}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
