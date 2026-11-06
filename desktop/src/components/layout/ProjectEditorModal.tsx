import { useEffect, useId, useRef, useState } from 'react'

import { FolderOpen, Plus, X } from 'lucide-react'
import { desktopUiPreferencesApi } from '@/api/desktopUiPreferences'
import { Badge } from '@/components/ui/Badge'
import { IconButton } from '@/components/ui/IconButton'
import { getDesktopHost } from '@/lib/desktopHost'
import { DirectoryPicker } from '@/components/composite/DirectoryPicker'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { useTranslation } from '../../i18n'

export type ProjectEditorSubmission = {
  name: string
  sourceFolder: string
  logicalRoot: string
  additionalDirectories: string[]
}

type ProjectEditorAction = () => void | Promise<void>

type ProjectEditorBaseProps = {
  open: boolean
  initialName?: string
  logicalRoot?: string
  suggestedName?: string
  loading?: boolean
  error?: string | null
  onClose: () => void
  onSubmit: (submission: ProjectEditorSubmission) => void | Promise<void>
}

type CreateProjectEditorProps = ProjectEditorBaseProps & {
  mode: 'create'
  sourceFolder: string
  onSourceFolderChange: (path: string) => void
}

type EditProjectEditorProps = ProjectEditorBaseProps & {
  mode: 'edit'
  logicalRoot: string
  onRestoreFolderName?: ProjectEditorAction
  onRemoveFromSidebar?: ProjectEditorAction
}

export type ProjectEditorModalProps = CreateProjectEditorProps | EditProjectEditorProps

function folderName(path: string): string {
  const segments = path.replace(/[\\/]+$/, '').split(/[\\/]+/).filter(Boolean)
  return segments[segments.length - 1] ?? ''
}

function normalizeProjectName(name: string): string {
  return name.trim().replace(/\s+/g, ' ')
}

function messageFromError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export function ProjectEditorModal(props: ProjectEditorModalProps) {
  const t = useTranslation()
  const {
    open,
    mode,
    initialName,
    logicalRoot,
    suggestedName,
    loading = false,
    error,
    onClose,
    onSubmit,
  } = props
  const host = getDesktopHost()
  const useNativeFolderDialog = host.isDesktop && host.capabilities.dialogs
  const sourceFolder = mode === 'create' ? props.sourceFolder : logicalRoot ?? ''
  const suggestedFolderName = suggestedName?.trim() || folderName(logicalRoot || sourceFolder)
  const [name, setName] = useState(() => initialName ?? suggestedFolderName)
  const [showValidation, setShowValidation] = useState(false)
  const [pending, setPending] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [additionalDirectories, setAdditionalDirectories] = useState<string[]>([])
  const [directoriesLoading, setDirectoriesLoading] = useState(false)
  const [directoriesError, setDirectoriesError] = useState<string | null>(null)
  const directoriesId = useId()
  const directoryFailureMessage = t('sidebar.projectEditor.actionFailed')
  const nameInputId = useId()
  const sourceFolderRef = useRef<HTMLDivElement>(null)
  const nameWasEditedRef = useRef(false)
  const useSuggestedNameRef = useRef(!initialName)
  const pendingRef = useRef(false)
  const wasOpenRef = useRef(open)
  const previousModeRef = useRef(mode)

  const busy = loading || pending
  const normalizedName = normalizeProjectName(name)
  const nameError = !normalizedName
    ? t('sidebar.projectEditor.nameRequired')
    : normalizedName.length > 80
      ? t('sidebar.projectEditor.nameTooLong')
      : undefined
  const sourceFolderError = mode === 'create' && !sourceFolder.trim()
    ? t('sidebar.projectEditor.sourceFolderRequired')
    : undefined
  const displayedError = error || actionError || directoriesError

  useEffect(() => {
    const opened = open && !wasOpenRef.current
    const modeChanged = open && previousModeRef.current !== mode

    if (opened || modeChanged) {
      nameWasEditedRef.current = false
      useSuggestedNameRef.current = !initialName
      setName(initialName ?? suggestedFolderName)
      setShowValidation(false)
      setActionError(null)
    } else if (open && !nameWasEditedRef.current && useSuggestedNameRef.current) {
      setName(suggestedFolderName)
    }

    wasOpenRef.current = open
    previousModeRef.current = mode
  }, [initialName, mode, open, suggestedFolderName])

  useEffect(() => {
    let cancelled = false
    setAdditionalDirectories([])
    setDirectoriesError(null)
    if (!open || !sourceFolder) {
      setDirectoriesLoading(false)
      return
    }
    setDirectoriesLoading(true)
    void desktopUiPreferencesApi.getProjectDirectories(sourceFolder)
      .then((project) => { if (!cancelled) setAdditionalDirectories(project.additionalDirectories) })
      .catch((failure: unknown) => {
        if (!cancelled) setDirectoriesError(messageFromError(failure, directoryFailureMessage))
      })
      .finally(() => { if (!cancelled) setDirectoriesLoading(false) })
    return () => { cancelled = true }
  }, [open, sourceFolder, directoryFailureMessage])

  const addDirectories = (paths: string[]) => {
    setAdditionalDirectories((current) => [...new Set([...current, ...paths.filter((path) => path && path !== sourceFolder)])])
  }

  const runAction = async (action: ProjectEditorAction, afterSuccess?: () => void) => {
    if (loading || pendingRef.current) return

    pendingRef.current = true
    setPending(true)
    setActionError(null)
    try {
      await action()
      afterSuccess?.()
    } catch (actionFailure) {
      setActionError(messageFromError(actionFailure, t('sidebar.projectEditor.actionFailed')))
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }

  const handleClose = () => {
    if (!busy) onClose()
  }

  const focusInvalidField = () => {
    if (nameError) {
      document.getElementById(nameInputId)?.focus()
      return
    }
    sourceFolderRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }

  const handleSubmit = () => {
    if (busy || directoriesLoading || directoriesError) return
    if (nameError || sourceFolderError) {
      setShowValidation(true)
      focusInvalidField()
      return
    }

    const submissionLogicalRoot = logicalRoot?.trim() ? logicalRoot : sourceFolder
    void runAction(() => onSubmit({
      name: normalizedName,
      sourceFolder,
      logicalRoot: submissionLogicalRoot,
      additionalDirectories,
    }))
  }

  const handleChooseSourceFolder = () => {
    if (mode !== 'create') return
    void runAction(async () => {
      const selected = await host.dialogs.open({
        directory: true,
        multiple: false,
        title: t('dirPicker.chooseProjectFolder'),
      })
      if (typeof selected === 'string' && selected.length > 0) {
        props.onSourceFolderChange(selected)
      }
    })
  }

  const handleChooseAdditionalDirectories = () => {
    void runAction(async () => {
      const selected = await host.dialogs.open({
        directory: true,
        multiple: true,
        title: t('sidebar.projectEditor.addDirectory'),
      })
      addDirectories(typeof selected === 'string' ? [selected] : Array.isArray(selected) ? selected : [])
    })
  }

  const handleRestoreFolderName = () => {
    if (mode !== 'edit' || !props.onRestoreFolderName) return
    void runAction(props.onRestoreFolderName, () => {
      nameWasEditedRef.current = false
      useSuggestedNameRef.current = true
      setName(suggestedFolderName)
    })
  }

  const handleRemoveFromSidebar = () => {
    if (mode !== 'edit' || !props.onRemoveFromSidebar) return
    void runAction(props.onRemoveFromSidebar)
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={t(mode === 'create' ? 'sidebar.projectEditor.createTitle' : 'sidebar.projectEditor.editTitle')}
      width={520}
      footer={(
        <>
          <Button variant="secondary" onClick={handleClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSubmit} loading={busy || directoriesLoading} disabled={!!directoriesError}>
            {t(mode === 'create' ? 'sidebar.projectEditor.create' : 'common.save')}
          </Button>
        </>
      )}
    >
      <fieldset disabled={busy} className="m-0 min-w-0 border-0 p-0">
        <div className="flex flex-col gap-5">
          {displayedError && (
            <p id={`${directoriesId}-error`} role="alert" className="rounded-[var(--radius-md)] bg-[var(--color-error-container)] px-3 py-2 text-[13px] text-[var(--color-on-error-container)]">
              {displayedError}
            </p>
          )}

          <Input
            id={nameInputId}
            label={t('sidebar.projectEditor.name')}
            required
            value={name}
            onChange={(event) => {
              nameWasEditedRef.current = true
              useSuggestedNameRef.current = false
              setName(event.target.value)
            }}
            hint={t('sidebar.projectEditor.nameHint', { count: 80 })}
            error={showValidation ? nameError : undefined}
          />

          {mode === 'create' ? (
            <div
              ref={sourceFolderRef}
              role="group"
              aria-labelledby="project-editor-source-folder"
              aria-describedby={showValidation && sourceFolderError ? 'project-editor-source-folder-error' : undefined}
              className="flex flex-col gap-1.5"
            >
              <span id="project-editor-source-folder" className="text-[13px] font-medium text-[var(--color-text-primary)]">
                {t('sidebar.projectEditor.sourceFolder')}
                <Badge className="ml-2">{t('sidebar.projectEditor.primaryDirectory')}</Badge>
                <span className="ml-0.5 text-[var(--color-error)]">*</span>
              </span>
              {useNativeFolderDialog ? (
                <Button
                  variant="secondary"
                  onClick={handleChooseSourceFolder}
                  disabled={busy}
                  title={sourceFolder || undefined}
                  aria-label={t('dirPicker.chooseProjectFolder')}
                  className="min-w-0 self-start max-w-full"
                >
                  <FolderOpen size={14} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
                  <span className="truncate">{sourceFolder || t('dirPicker.chooseProjectFolder')}</span>
                </Button>
              ) : (
                <DirectoryPicker value={sourceFolder} onChange={props.onSourceFolderChange} variant="workbar" />
              )}
              {showValidation && sourceFolderError && (
                <p id="project-editor-source-folder-error" role="alert" className="text-xs text-[var(--color-error)]">
                  {sourceFolderError}
                </p>
              )}
            </div>
          ) : (
            <Input
              label={t('sidebar.projectEditor.realPath')}
              value={logicalRoot}
              readOnly
              aria-readonly="true"
              hint={t('sidebar.projectEditor.realPathHint')}
              className="font-mono text-xs"
            />
          )}

          <div role="group" aria-labelledby={directoriesId} aria-describedby={`${directoriesId}-hint${displayedError ? ` ${directoriesId}-error` : ''}`} className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span id={directoriesId} className="text-[13px] font-medium text-[var(--color-text-primary)]">{t('sidebar.projectEditor.additionalDirectories')}</span>
              {mode === 'edit' && <Badge>{t('sidebar.projectEditor.primaryDirectory')}: {folderName(sourceFolder)}</Badge>}
            </div>
            <p id={`${directoriesId}-hint`} className="text-xs leading-5 text-[var(--color-text-secondary)]">{t('sidebar.projectEditor.directoriesHint')}</p>
            {additionalDirectories.length > 0 && (
              <ul className="divide-y divide-[var(--color-border)] rounded-[var(--radius-md)] border border-[var(--color-border)]">
                {additionalDirectories.map((directory) => (
                  <li key={directory} className="flex min-w-0 items-center gap-2 px-3 py-2">
                    <FolderOpen size={14} strokeWidth={1.75} className="shrink-0 text-[var(--color-text-tertiary)]" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs" title={directory}>{directory}</span>
                    <IconButton icon={<X size={14} strokeWidth={1.75} />} label={t('sidebar.projectEditor.removeDirectory', { path: directory })} size="xs" hoverTone="danger" onClick={() => setAdditionalDirectories((current) => current.filter((path) => path !== directory))} />
                  </li>
                ))}
              </ul>
            )}
            {useNativeFolderDialog ? (
              <Button variant="secondary" className="self-start" onClick={handleChooseAdditionalDirectories} disabled={busy || directoriesLoading || !sourceFolder}>
                <Plus size={14} strokeWidth={1.75} aria-hidden="true" />{t('sidebar.projectEditor.addDirectory')}
              </Button>
            ) : (
              sourceFolder && !directoriesLoading && !directoriesError ? (
                <DirectoryPicker placeholder={t('sidebar.projectEditor.addDirectory')} value="" onChange={(directory) => addDirectories([directory])} variant="workbar" />
              ) : <Button variant="secondary" disabled>{t('sidebar.projectEditor.addDirectory')}</Button>
            )}
          </div>

          {mode === 'edit' && (
            <div className="flex flex-col gap-3 rounded-[var(--radius-md)] bg-[var(--color-surface-container)] px-4 py-3">
              {props.onRestoreFolderName && (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-[13px] font-medium text-[var(--color-text-primary)]">
                      {t('sidebar.projectEditor.restoreFolderName')}
                    </p>
                    <p className="mt-0.5 text-xs text-[var(--color-text-tertiary)]">
                      {suggestedFolderName}
                    </p>
                  </div>
                  <Button variant="secondary" size="sm" onClick={handleRestoreFolderName}>
                    {t('sidebar.projectEditor.restoreFolderName')}
                  </Button>
                </div>
              )}

              {props.onRemoveFromSidebar && (
                <div className="flex flex-wrap items-start justify-between gap-3 border-t border-[var(--color-border)] pt-3">
                  <p className="max-w-[320px] text-xs leading-5 text-[var(--color-text-secondary)]">
                    {t('sidebar.projectEditor.removeFromSidebarHint')}
                  </p>
                  <Button variant="danger-outline" size="sm" onClick={handleRemoveFromSidebar}>
                    {t('sidebar.projectEditor.removeFromSidebar')}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </fieldset>
    </Modal>
  )
}
