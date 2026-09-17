import { useId, useState } from 'react'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { useTranslation } from '@/i18n'
import { RemoteSourceEditor } from './RemoteSourceEditor'
import { RemoteMarkdownEditor } from './RemoteMarkdownEditor'

export type RemoteFileEditorProps = {
  absolutePath: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  error?: string
}
export function remoteFileLanguage(absolutePath: string, value = ''): string {
  const name = absolutePath.split('/').pop()?.toLowerCase() ?? ''
  if (['.bashrc', '.barshrc', 'bashrc', 'bash.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.profile', 'profile', '.zshrc', '.zprofile'].includes(name)) return 'bash'
  if (/\.(?:sh|bash|zsh)$/.test(name) || /^#![^\r\n]*\b(?:bash|sh|zsh|ksh)\b/.test(value)) return 'bash'
  if (/\.(?:md|markdown|mdown)$/.test(name)) return 'markdown'
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
  const languages: Record<string, string> = { json: 'json', yaml: 'yaml', yml: 'yaml', js: 'javascript', ts: 'typescript', py: 'python', sql: 'sql', xml: 'xml', html: 'html', css: 'css', toml: 'toml', java: 'java' }
  return languages[extension] ?? 'text'
}
function EditorSurface({ absolutePath, value, onChange, disabled, error }: RemoteFileEditorProps) {
  const t = useTranslation()
  const id = useId()
  const [mode, setMode] = useState<'formatted' | 'source'>('formatted')
  const language = remoteFileLanguage(absolutePath, value)
  const markdown = language === 'markdown'
  const label = t('managedResources.files.editorLabel')
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="remote-file-edit-surface" data-editor-language={language}>
      <div className="flex shrink-0 items-center justify-between gap-2">
        <span className="text-xs text-[var(--color-text-secondary)]">{language === 'bash' ? 'Bash' : markdown ? 'Markdown' : label}</span>
        {markdown && <SegmentedControl
          value={mode} onChange={setMode} size="sm" as="tablist"
          label={t('managedResources.files.editor.mode' as never)}
          items={[{ value: 'formatted', label: t('managedResources.files.editor.formatted' as never) }, { value: 'source', label: t('managedResources.files.editor.source' as never) }]}
        />}
      </div>
      {markdown && mode === 'formatted'
        ? <RemoteMarkdownEditor value={value} onChange={onChange} disabled={disabled} label={label} describedBy={error ? id : undefined} />
        : <RemoteSourceEditor value={value} onChange={onChange} disabled={disabled} language={language} label={label} describedBy={error ? id : undefined} />}
      {error && <p id={id} role="alert" className="shrink-0 text-xs text-[var(--color-error)]">{error}</p>}
    </div>
  )
}
export function RemoteFileEditor(props: RemoteFileEditorProps) {
  return <EditorSurface key={props.absolutePath} {...props} />
}
