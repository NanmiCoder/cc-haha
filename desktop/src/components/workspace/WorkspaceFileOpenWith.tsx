import { useTranslation, type TranslationKey } from '@/i18n'
import { useOpenTargetStore } from '@/stores/openTargetStore'
import { buildOpenWithMenuItems } from '@/lib/openWithMenuItems'
import { getServerBaseUrl } from '@/lib/desktopRuntime'
import { openWithContextForWorkspaceFile } from '@/lib/openWithContextForHref'
import { reportOpenFailure } from '@/lib/systemFileOpen'
import { TargetIcon } from '@/components/composite/TargetIcon'
import type { OpenTarget } from '@/api/openTargets'
import { fileApplicationTargets, useWorkspaceFileOpenTargets } from '@/components/workspace/workspaceFileOpenTargets'

export function WorkspaceFileOpenWith({ absolutePath, sessionId, workspacePath, onAfterSelect, targets: suppliedTargets, loading, error, onRefresh }: {
  absolutePath: string
  sessionId?: string
  workspacePath?: string
  onAfterSelect?: () => void
  targets?: OpenTarget[]
  loading?: boolean
  error?: string | null
  onRefresh?: () => void
}) {
  const t = useTranslation()
  const discovery = useWorkspaceFileOpenTargets(suppliedTargets === undefined ? absolutePath : null)
  const targets = suppliedTargets ?? discovery.targets
  const applications = fileApplicationTargets(absolutePath, targets)
  const context = sessionId && workspacePath
    ? openWithContextForWorkspaceFile(workspacePath, absolutePath, { sessionId, serverBaseUrl: getServerBaseUrl() })
    : { kind: 'file' as const, absolutePath, previewable: false }
  const actions = buildOpenWithMenuItems(context, targets, {
    sessionId: sessionId ?? '', t: (key, vars) => t(key as TranslationKey, vars),
  }).filter((item) => item.icon === 'copy' || item.id === 'in-app' || item.id === 'preview')
  // Previewing again inside an already-open file has no effect. HTML browser
  // and clipboard actions remain available because they have distinct results.
  const usefulActions = actions.filter((item) => item.id !== 'preview' || suppliedTargets === undefined)
  const folders = targets.filter((target) => target.kind === 'file_manager')
  const selectTarget = (target: OpenTarget) => {
    void useOpenTargetStore.getState().openTarget(target.id, absolutePath).catch(() => reportOpenFailure(absolutePath))
    onAfterSelect?.()
  }
  const itemClass = 'flex h-9 w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2 text-left text-[15px] text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:bg-[var(--color-surface-hover)]'
  const failure = error ?? discovery.error
  return (
    <>
      {(loading ?? discovery.loading) && applications.length === 0 ? <p role="status" className="px-2 py-2 text-xs text-[var(--color-text-tertiary)]">{t('common.loading')}</p> : null}
      {failure ? <p role="alert" className="break-words px-2 py-2 text-xs text-[var(--color-error)]">{failure}</p> : null}
      {applications.map((target) => (
        <button key={target.id} type="button" role="menuitem" onClick={() => selectTarget(target)} className={itemClass}>
          <span aria-hidden="true" className="flex h-4 w-4 shrink-0 items-center justify-center"><TargetIcon target={target} size={16} /></span>
          <span className="truncate">{target.kind === 'system_default' ? t('openWith.systemDefault') : target.label}</span>
        </button>
      ))}
      {applications.length > 0 && (folders.length > 0 || usefulActions.length > 0 || onRefresh) ? <div className="mx-2 my-1 border-t border-[var(--color-border)]" role="separator" /> : null}
      {folders.map((target) => <button key={target.id} type="button" role="menuitem" onClick={() => selectTarget(target)} className={itemClass}>{t('workspace.files.openContainingFolder')}</button>)}
      {usefulActions.map((item) => <button key={item.id} type="button" role="menuitem" onClick={() => { item.onSelect(); onAfterSelect?.() }} className={itemClass}><span className="truncate">{item.label}</span></button>)}
      {onRefresh ? <button type="button" role="menuitem" className={itemClass} onClick={() => { onRefresh(); onAfterSelect?.() }}>{t('workspace.refresh')}</button> : null}
    </>
  )
}
