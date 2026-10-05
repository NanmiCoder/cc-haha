import { Maximize2, Minimize2, PanelBottom, PanelRight } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'
import { Tooltip } from '@/components/ui/Tooltip'
import { detectPlatform, formatWorkspaceShortcut } from '@/lib/workspace/shortcuts'
import { useTranslation } from '@/i18n'
import type { WorkspaceLayout } from '@/lib/workspace/types'

export type WorkspaceLayoutControlsProps = {
  layout: WorkspaceLayout
  bottomOpen: boolean
  onToggleFullscreen: () => void
  onToggleBottom: () => void
  onToggleWorkspace: () => void
}

/** Window-level layout controls; docks only own their resource tabs. */
export function WorkspaceLayoutControls({
  layout,
  bottomOpen,
  onToggleFullscreen,
  onToggleBottom,
  onToggleWorkspace,
}: WorkspaceLayoutControlsProps) {
  const t = useTranslation()
  const isFull = layout === 'full'
  const isVisible = layout !== 'hidden'
  const platform = detectPlatform()
  const hint = (label: string, shortcut: string | null) => (
    <span className="flex items-center gap-2 whitespace-nowrap font-medium">
      {label}
      {shortcut ? (
        <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[var(--radius-xs)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-1 font-mono text-[11px] font-normal leading-none text-[var(--color-text-tertiary)]">{shortcut}</kbd>
      ) : null}
    </span>
  )

  return (
    <>
      {isVisible && <IconButton
        icon={isFull
          ? <Minimize2 size={16} strokeWidth={1.75} aria-hidden="true" />
          : <Maximize2 size={16} strokeWidth={1.75} aria-hidden="true" />}
        label={t(isFull ? 'workspace.controls.restore' : 'workspace.controls.expand')}
        size="sm"
        tone="muted"
        pressed={isFull}
        data-testid="workspace-toggle-fullscreen"
        onClick={onToggleFullscreen}
      />}
      <Tooltip placement="bottom-end" appearance="surface" content={hint(t('workspace.controls.toggleBottom'), formatWorkspaceShortcut('toggle-bottom-panel', platform))}>
      <IconButton
        icon={<PanelBottom size={16} strokeWidth={1.75} aria-hidden="true" />}
        label={t('workspace.controls.toggleBottom')}
        showTooltip={false}
        size="sm"
        tone="muted"
        pressed={bottomOpen}
        data-testid="workspace-toggle-bottom"
        data-workspace-focus="bottom-toggle"
        data-active={bottomOpen ? 'true' : 'false'}
        onClick={onToggleBottom}
      />
      </Tooltip>
      <Tooltip placement="bottom-end" appearance="surface" content={hint(t('workspace.controls.toggleSide'), formatWorkspaceShortcut('toggle-workspace', platform))}>
      <IconButton
        icon={<PanelRight size={16} strokeWidth={1.75} aria-hidden="true" />}
        label={t(isVisible ? 'tabs.hideWorkspace' : 'tabs.showWorkspace')}
        showTooltip={false}
        size="sm"
        tone="muted"
        pressed={isVisible}
        data-testid="workspace-toggle-side"
        data-workspace-focus="side-toggle"
        data-active={isVisible ? 'true' : 'false'}
        onClick={onToggleWorkspace}
      />
      </Tooltip>
    </>
  )
}
