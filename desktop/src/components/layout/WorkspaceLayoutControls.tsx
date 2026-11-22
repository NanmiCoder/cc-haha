import type { ReactNode } from 'react'
import { Maximize2, Minimize2, PanelBottom, PanelRight } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'
import { Kbd } from '@/components/ui/Kbd'
import { Tooltip } from '@/components/ui/Tooltip'
import { detectPlatform, formatWorkspaceShortcut } from '@/lib/workspace/shortcuts'
import { useTranslation } from '@/i18n'
import type { WorkspaceLayout } from '@/lib/workspace/types'

export type WorkspaceLayoutControlsProps = {
  layout: WorkspaceLayout
  bottomOpen: boolean
  /** Optional leading icon toggle (e.g. session activity) joined into the cluster. */
  leadingSlot?: ReactNode
  onToggleFullscreen: () => void
  onToggleBottom: () => void
  onToggleWorkspace: () => void
}

/** Quiet 3-icon window layout toggle cluster; docks own their own resource tabs. */
export function WorkspaceLayoutControls({
  layout,
  bottomOpen,
  leadingSlot,
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
      {shortcut ? <Kbd size="xs">{shortcut}</Kbd> : null}
    </span>
  )

  return (
    <div
      data-testid="workspace-layout-controls"
      className="tab-bar-interactive inline-flex items-center gap-0.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-0.5 [-webkit-app-region:no-drag]"
    >
      {leadingSlot}
      {isVisible && (
        <IconButton
          icon={isFull
            ? <Minimize2 size={15} strokeWidth={1.75} aria-hidden="true" />
            : <Maximize2 size={15} strokeWidth={1.75} aria-hidden="true" />}
          label={t(isFull ? 'workspace.controls.restore' : 'workspace.controls.expand')}
          size="sm"
          tone="muted"
          pressed={isFull}
          bordered={isFull}
          data-testid="workspace-toggle-fullscreen"
          onClick={onToggleFullscreen}
        />
      )}
      <Tooltip placement="bottom-end" appearance="surface" content={hint(t('workspace.controls.toggleBottom'), formatWorkspaceShortcut('toggle-bottom-panel', platform))}>
        <IconButton
          icon={<PanelBottom size={15} strokeWidth={1.75} aria-hidden="true" />}
          label={t('workspace.controls.toggleBottom')}
          showTooltip={false}
          size="sm"
          tone="muted"
          pressed={bottomOpen}
          bordered={bottomOpen}
          data-testid="workspace-toggle-bottom"
          data-workspace-focus="bottom-toggle"
          data-active={bottomOpen ? 'true' : 'false'}
          onClick={onToggleBottom}
        />
      </Tooltip>
      <Tooltip placement="bottom-end" appearance="surface" content={hint(t('workspace.controls.toggleSide'), formatWorkspaceShortcut('toggle-workspace', platform))}>
        <IconButton
          icon={<PanelRight size={15} strokeWidth={1.75} aria-hidden="true" />}
          label={t(isVisible ? 'tabs.hideWorkspace' : 'tabs.showWorkspace')}
          showTooltip={false}
          size="sm"
          tone="muted"
          pressed={isVisible}
          bordered={isVisible}
          data-testid="workspace-toggle-side"
          data-workspace-focus="side-toggle"
          data-active={isVisible ? 'true' : 'false'}
          onClick={onToggleWorkspace}
        />
      </Tooltip>
    </div>
  )
}
