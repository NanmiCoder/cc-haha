import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { DirectoryPicker } from '@/components/composite/DirectoryPicker'
import { useDismissable } from '@/hooks/useDismissable'
import { useAnchoredPosition } from '@/hooks/useAnchoredPosition'
import { useTranslation } from '@/i18n'
import type { useMcpProjectSharing } from './useMcpProjectSharing'

export function McpProjectTargets({ sharing, disabled }: {
  sharing: ReturnType<typeof useMcpProjectSharing>
  disabled: boolean
}) {
  const t = useTranslation()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const position = useAnchoredPosition({ open, anchorRef: triggerRef, floatingRef: panelRef, placement: 'bottom-end', clampHeight: true })
  useDismissable({
    open, refs: [panelRef], triggerRef, stopEscapePropagation: true,
    closeOnViewportChange: true,
    onDismiss: reason => {
      setOpen(false)
      if (reason === 'escape') triggerRef.current?.focus()
    },
  })
  useEffect(() => {
    if (open) panelRef.current?.querySelector<HTMLInputElement>('input:not(:disabled)')?.focus()
  }, [open])
  const selectedCount = sharing.projects.filter(project => project.checked).length
  const failures = sharing.projects.filter(project => project.saveError)

  return (
    <div className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          ref={triggerRef}
          variant="secondary"
          size="sm"
          aria-label={t('settings.mcp.projects.label')}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          disabled={disabled || !sharing.ready}
          loading={sharing.loading}
          onClick={() => setOpen(current => !current)}
          icon={<ChevronDown size={14} aria-hidden />}
        >
          {t('settings.mcp.projects.selectedCount', { count: selectedCount })}
        </Button>
        <fieldset disabled={disabled || sharing.loading || !sharing.ready}>
          <legend className="sr-only">{t('settings.mcp.projects.add')}</legend>
          <DirectoryPicker value="" onChange={path => void sharing.addProject(path)} />
        </fieldset>
        <Button variant="ghost" size="sm" disabled={disabled || sharing.loading} onClick={() => void sharing.reload()}>
          {t('settings.mcp.projects.reload')}
        </Button>
      </div>
      <p className="max-w-md text-xs leading-[1.5] text-[var(--color-text-tertiary)]">{t('settings.mcp.projects.hint')}</p>
      {(sharing.error || failures.length > 0) && (
        <div role="alert" className="max-w-md space-y-1 break-words text-xs text-[var(--color-error)]">
          {sharing.error && <p>{sharing.error}</p>}
          {failures.map(project => <p key={project.projectPath}>{project.projectPath}: {project.saveError}</p>)}
        </div>
      )}
      {open && createPortal(
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label={t('settings.mcp.projects.label')}
          className="z-[var(--z-dropdown)] overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-lg"
          style={{ ...position.style, width: 'min(440px, calc(100vw - 24px))', visibility: position.ready ? 'visible' : 'hidden' }}
        >
          <div className="space-y-3">
            {sharing.projects.map(project => (
              <Checkbox
                key={project.projectPath}
                label={<span className="break-all font-mono text-xs">{project.projectPath}</span>}
                description={project.error || (project.conflict ? t('settings.mcp.projects.conflict') : undefined)}
                checked={project.checked}
                disabled={disabled || sharing.loading || !!project.error || !!project.conflict}
                onChange={() => sharing.toggle(project.projectPath)}
              />
            ))}
            {sharing.projects.length === 0 && <p className="text-xs text-[var(--color-text-secondary)]">{t('settings.mcp.targetProject.projectEmpty')}</p>}
          </div>
          <Button variant="ghost" size="sm" className="mt-3" onClick={() => { setOpen(false); triggerRef.current?.focus() }}>
          {t('settings.mcp.projects.done')}
          </Button>
        </div>, document.body,
      )}
    </div>
  )
}
