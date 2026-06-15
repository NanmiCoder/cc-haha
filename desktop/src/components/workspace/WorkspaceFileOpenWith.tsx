import { useEffect } from 'react'
import { ExternalLink } from 'lucide-react'
import { useTranslation, type TranslationKey } from '../../i18n'
import { useOpenTargetStore } from '../../stores/openTargetStore'
import { buildOpenWithItems, type OpenWithItem, type OpenWithDeps } from '../../lib/openWithItems'
import { getDesktopHost } from '../../lib/desktopHost'
import { getServerBaseUrl } from '../../lib/desktopRuntime'
import { openWithContextForWorkspaceFile } from '../../lib/openWithContextForHref'
import { useBrowserPanelStore } from '../../stores/browserPanelStore'
import { useWorkspacePanelStore } from '../../stores/workspacePanelStore'
import { TargetIcon } from '../common/TargetIcon'

function openExternal(path: string) {
  void getDesktopHost().shell.openPath(path).catch(() => {})
}

export function WorkspaceFileOpenWith({
  absolutePath,
  sessionId,
  workspacePath,
  onAfterSelect,
}: {
  absolutePath: string
  sessionId?: string
  workspacePath?: string
  onAfterSelect?: () => void
}) {
  const t = useTranslation()
  const targets = useOpenTargetStore((s) => s.targets)
  const ensureTargets = useOpenTargetStore((s) => s.ensureTargets)
  const openTarget = useOpenTargetStore((s) => s.openTarget)

  useEffect(() => {
    void ensureTargets()
  }, [ensureTargets])

  // Cast t: useTranslation returns (key: TranslationKey, params?: Record<string, string|number>) => string
  // but OpenWithDeps.t expects (key: string, vars?: Record<string, string>) => string.
  // All keys buildOpenWithItems calls are valid TranslationKeys, so the cast is safe.
  const deps: OpenWithDeps = {
    openInAppBrowser: (url) => {
      if (!sessionId) return
      useBrowserPanelStore.getState().open(sessionId, url)
    },
    openWorkspacePreview: (relPath) => {
      if (!sessionId) return
      void useWorkspacePanelStore.getState().openPreview(sessionId, relPath, 'file')
    },
    openSystem: (p) => openExternal(p),
    openTarget: (id, p) => {
      void openTarget(id, p)
    },
    t: (key, vars) => t(key as TranslationKey, vars),
  }
  const items: OpenWithItem[] = buildOpenWithItems(
    sessionId && workspacePath
      ? openWithContextForWorkspaceFile(workspacePath, absolutePath, {
        sessionId,
        serverBaseUrl: getServerBaseUrl(),
      })
      : { kind: 'file', absolutePath, previewable: false },
    targets,
    deps,
  )

  if (items.length === 0) return null

  return (
    <>
      <div className="my-1 border-t border-[var(--color-border)]" role="separator" />
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          onClick={() => {
            item.onSelect()
            onAfterSelect?.()
          }}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
        >
          <span
            aria-hidden="true"
            className="flex h-[14px] w-[14px] items-center justify-center text-[var(--color-text-tertiary)]"
          >
            {item.target ? (
              <TargetIcon target={item.target} size={14} />
            ) : (
              <ExternalLink size={14} strokeWidth={1.9} />
            )}
          </span>
          <span className="truncate">{item.label}</span>
        </button>
      ))}
    </>
  )
}
