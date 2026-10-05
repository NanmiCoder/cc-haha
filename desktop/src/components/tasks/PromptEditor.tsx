import { Gavel, TriangleAlert } from 'lucide-react'
import { ModelSelector } from '../controls/ModelSelector'
import { DirectoryPicker } from '@/components/composite/DirectoryPicker'
import { useTranslation } from '../../i18n'
import { Badge } from '@/components/ui/Badge'

type Props = {
  value: string
  onChange: (value: string) => void
  placeholder?: string

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
    <div className="overflow-visible rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] transition-colors focus-within:border-[var(--color-border-focus)]">
      {/* Prompt textarea */}
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={4}
        className="w-full resize-y bg-transparent px-4 py-3 text-sm leading-[1.7] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)]"
        style={{ minHeight: 120 }}
      />

      {/* Bottom toolbar. The rule was `--color-border` at `/40`, which Safari 15
          WebView drops entirely — the toolbar then floated with no seam. */}
      <div className="flex flex-col gap-2 rounded-b-[var(--radius-xl)] border-t border-[var(--color-border)] bg-[var(--color-surface-sidebar)] px-3 py-2.5">
        {/* Row 1: Permission + Model selectors */}
        <div className="flex items-center justify-between">
          <Badge
            tone="danger"
            size="md"
            icon={<Gavel size={12} strokeWidth={2} aria-hidden="true" />}
          >
            {t('newTask.fullPermissions')}
          </Badge>
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

        {/* `wrap` matters here: the sentence ends in an absolute folder path,
            which a default badge would push onto one unbreakable line. Fill
            only, no border: a tinted strip with an edge as well is the
            "fill + border" double the spec rules out for inset blocks. */}
        <Badge tone="danger" size="sm" wrap pill={false} className="w-full" icon={<TriangleAlert size={12} strokeWidth={2} aria-hidden="true" className="shrink-0" />}>
          {t('promptEditor.bypassWarning')}{folderPath ? ` ${t('promptEditor.within')} ${folderPath}` : ` ${t('promptEditor.selectFolder')}`}.
        </Badge>
      </div>
    </div>
  )
}
