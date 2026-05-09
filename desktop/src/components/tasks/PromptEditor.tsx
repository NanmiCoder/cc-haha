import { PermissionModeSelector } from '../controls/PermissionModeSelector'
import { ModelSelector } from '../controls/ModelSelector'
import { DirectoryPicker } from '../shared/DirectoryPicker'
import { useTranslation } from '../../i18n'
import type { PermissionMode } from '../../types/settings'

type Props = {
  value: string
  onChange: (value: string) => void
  placeholder?: string

  permissionMode: PermissionMode
  onPermissionModeChange: (mode: PermissionMode) => void

  modelId: string
  onModelChange: (modelId: string) => void
  providerId?: string | null
  onProviderIdChange: (providerId: string | null) => void

  folderPath: string
  onFolderPathChange: (path: string) => void

  useWorktree: boolean
  onUseWorktreeChange: (checked: boolean) => void
}

export function PromptEditor({
  value,
  onChange,
  placeholder,
  permissionMode,
  onPermissionModeChange,
  modelId,
  onModelChange,
  providerId,
  onProviderIdChange,
  folderPath,
  onFolderPathChange,
  useWorktree: _useWorktree,
  onUseWorktreeChange: _onUseWorktreeChange,
}: Props) {
  const t = useTranslation()
  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] focus-within:border-[var(--color-border-focus)] transition-colors overflow-visible">
      {/* Prompt textarea */}
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={4}
        className="w-full resize-y bg-transparent px-3 py-2.5 text-sm leading-relaxed text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)]"
        style={{ minHeight: 120 }}
      />

      {/* Bottom toolbar */}
      <div className="border-t border-[var(--color-border)]/40 px-3 py-2 flex flex-col gap-2 bg-[var(--color-surface-container-low)] rounded-b-[var(--radius-lg)]">
        {/* Row 1: Permission + Model selectors */}
        <div className="flex items-center justify-between">
          <PermissionModeSelector value={permissionMode} onChange={onPermissionModeChange} workDir={folderPath || undefined} />
          <ModelSelector
            runtimeSelection={modelId ? { providerId: providerId ?? null, modelId } : undefined}
            onRuntimeSelectionChange={(selection) => {
              onProviderIdChange(selection.providerId)
              onModelChange(selection.modelId)
            }}
          />
        </div>

        {/* Row 2: Folder picker */}
        <div className="flex items-center justify-between">
          <DirectoryPicker value={folderPath} onChange={onFolderPathChange} />
        </div>

        {/* Bypass + no folder warning */}
        {permissionMode === 'bypassPermissions' && (
          <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-md bg-[var(--color-error)]/8 text-[10px] text-[var(--color-error)]">
            <span className="material-symbols-outlined text-[12px]">warning</span>
            {t('promptEditor.bypassWarning')}{folderPath ? ` ${t('promptEditor.within')} ${folderPath}` : ` ${t('promptEditor.selectFolder')}`}.
          </div>
        )}
      </div>
    </div>
  )
}
