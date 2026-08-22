import { useEffect, useState } from 'react'
import { Copy, ExternalLink } from 'lucide-react'
import { useTranslation, type TranslationKey } from '../../i18n'
import { useOpenTargetStore } from '../../stores/openTargetStore'
import type { OpenWithItem } from '../../lib/openWithItems'
import { buildOpenWithMenuItems } from '../../lib/openWithMenuItems'
import { getServerBaseUrl } from '../../lib/desktopRuntime'
import { openWithContextForWorkspaceFile } from '../../lib/openWithContextForHref'
import { TargetIcon } from '@/components/composite/TargetIcon'
import type { OpenTarget } from '../../api/openTargets'

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
  const globalTargets = useOpenTargetStore((s) => s.targets)
  const getTargetsForPath = useOpenTargetStore((s) => s.getTargetsForPath)
  const [pathTargets, setPathTargets] = useState<OpenTarget[] | null>(null)

  useEffect(() => {
    let active = true
    setPathTargets(null)
    void getTargetsForPath(absolutePath)
      .then((targets) => {
        if (active) setPathTargets(targets)
      })
      .catch(() => {
        if (active) setPathTargets([])
      })
    return () => {
      active = false
    }
  }, [absolutePath, getTargetsForPath])

  const targets = pathTargets ?? globalTargets

  const items: OpenWithItem[] = buildOpenWithMenuItems(
    sessionId && workspacePath
      ? openWithContextForWorkspaceFile(workspacePath, absolutePath, {
        sessionId,
        serverBaseUrl: getServerBaseUrl(),
      })
      : { kind: 'file', absolutePath, previewable: false },
    targets,
    {
      sessionId: sessionId ?? '',
      // Cast t: useTranslation takes TranslationKey, the builder takes string.
      // Every key it looks up is a valid TranslationKey, so this is safe.
      t: (key, vars) => t(key as TranslationKey, vars),
      // The file-tree menu renders its own copy-path pair directly above this.
      omitCopyPath: true,
    },
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
            ) : item.icon === 'copy' ? (
              <Copy size={14} strokeWidth={1.9} />
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
