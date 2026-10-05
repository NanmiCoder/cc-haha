import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Braces,
  CircleAlert,
  Code,
  File,
  FileCode2,
  FileText,
  FolderX,
  RefreshCw,
  Scissors,
  Terminal,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from '../../i18n'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Spinner } from '@/components/ui/Spinner'
import { CodeViewer } from '../chat/CodeViewer'
import { MarkdownRenderer } from '../markdown/MarkdownRenderer'
import { splitFrontmatter } from '../../lib/skillFrontmatter'
import { FrontmatterPanel } from './FrontmatterPanel'

export type PreviewFile = {
  path: string
  size: number
  language: string
  tooBig?: boolean
}

export type PreviewFileContent = {
  path: string
  content: string
  language: string
  size: number
  truncated: boolean
}

const LANG_ICONS: Record<string, LucideIcon> = {
  markdown: FileText,
  python: Code,
  javascript: FileCode2,
  typescript: FileCode2,
  bash: Terminal,
  json: Braces,
  yaml: Braces,
  text: FileText,
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'loaded'; file: PreviewFileContent }

/**
 * Markdown body plus its structured frontmatter. SKILL.md leads with a YAML
 * block that markdown would otherwise turn into a giant setext heading.
 */
function MarkdownFilePreview({ content }: { content: string }) {
  const { frontmatter, body } = useMemo(() => splitFrontmatter(content), [content])

  return (
    <>
      {frontmatter && <FrontmatterPanel frontmatter={frontmatter} className="mb-5" />}
      <MarkdownRenderer content={body} variant="document" />
    </>
  )
}

/**
 * Two-pane file preview: file list on the left, rendered content on the
 * right. Content is fetched lazily via `loadFile` and cached per path for
 * the lifetime of the component. Serves both market (async fetch) and
 * locally installed skills (loadFile resolves from memory).
 */
export function FilePreview({
  files,
  loadFile,
  initialPath,
}: {
  files: PreviewFile[]
  loadFile: (path: string) => Promise<PreviewFileContent>
  initialPath?: string
}) {
  const t = useTranslation()
  const defaultPath = initialPath ?? files.find((f) => f.path === 'SKILL.md')?.path ?? files[0]?.path ?? null
  const [activePath, setActivePath] = useState<string | null>(defaultPath)
  const [state, setState] = useState<LoadState>({ kind: 'idle' })
  const cacheRef = useRef(new Map<string, PreviewFileContent>())
  const requestSeq = useRef(0)

  const open = useCallback(
    async (path: string) => {
      setActivePath(path)
      const cached = cacheRef.current.get(path)
      if (cached) {
        setState({ kind: 'loaded', file: cached })
        return
      }
      const seq = ++requestSeq.current
      setState({ kind: 'loading' })
      try {
        const file = await loadFile(path)
        cacheRef.current.set(path, file)
        if (requestSeq.current !== seq) return
        setState({ kind: 'loaded', file })
      } catch (err) {
        if (requestSeq.current !== seq) return
        setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
      }
    },
    [loadFile],
  )

  useEffect(() => {
    if (defaultPath) void open(defaultPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (files.length === 0) {
    // `min-h-0 flex-1` is carried over from the layout fix this file already
    // had: the placeholder must claim the leftover height of the preview
    // column rather than shrink to its content.
    return (
      <EmptyState
        icon={<FolderX size={20} strokeWidth={1.6} aria-hidden="true" />}
        title={t('market.file.noFiles')}
        className="min-h-0 flex-1"
      />
    )
  }

  const activeFile = files.find((f) => f.path === activePath)

  return (
    <div
      className="grid min-h-0 min-w-0 flex-1 gap-4 @3xl:h-full @3xl:grid-cols-[minmax(0,260px)_minmax(0,1fr)]"
      data-testid="market-file-preview"
    >
      <div className="flex max-h-[40vh] min-h-0 flex-col gap-px overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] p-1 @3xl:max-h-none">
        {files.map((file) => {
          const active = file.path === activePath
          const Icon = LANG_ICONS[file.language] ?? File
          return (
            <button
              key={file.path}
              type="button"
              data-testid={`market-file-item-${file.path}`}
              onClick={() => void open(file.path)}
              className={`flex items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus-ring)] ${
                // The list's selected row: the neutral selected fill, with the
                // brand reserved for the selected item's icon.
                active
                  ? 'bg-[var(--color-surface-selected)] text-[var(--color-text-primary)]'
                  : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]'
              }`}
            >
              <Icon
                className={`flex-shrink-0 ${active ? 'text-[var(--color-brand)]' : 'text-[var(--color-text-tertiary)]'}`}
                size={14}
                strokeWidth={1.75}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">{file.path}</span>
                <span className="block font-mono text-[11px] text-[var(--color-text-tertiary)]">
                  {file.language} · {formatSize(file.size)}
                </span>
              </span>
            </button>
          )
        })}
      </div>

      <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)]">
        {activeFile && (
          <div className="flex min-h-10 flex-shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-[var(--color-border)] px-4 py-2 text-xs text-[var(--color-text-tertiary)]">
            <span className="font-mono text-xs text-[var(--color-text-primary)]">{activeFile.path}</span>
            <span>{activeFile.language}</span>
            <span>·</span>
            <span>{formatSize(activeFile.size)}</span>
            {state.kind === 'loaded' && state.file.truncated && (
              <span className="inline-flex items-center gap-1 text-[var(--color-warning)]">
                <Scissors size={12} strokeWidth={1.75} aria-hidden="true" />
                {t('market.file.truncated')}
              </span>
            )}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 @max-3xl:max-h-[70vh]">
          {state.kind === 'loading' && (
            <div className="flex justify-center py-10" data-testid="market-file-loading">
              <Spinner size={20} tone="brand" label={t('common.loading')} />
            </div>
          )}
          {state.kind === 'error' && (
            <div className="flex flex-col items-center gap-2 py-8 text-center" data-testid="market-file-error">
              <CircleAlert className="text-[var(--color-error)]" size={20} strokeWidth={1.75} aria-hidden="true" />
              <p className="text-[13px] font-medium text-[var(--color-text-primary)]">{t('market.file.loadError')}</p>
              <p className="max-w-md break-words text-xs text-[var(--color-text-tertiary)]">{state.message}</p>
              <Button
                variant="secondary"
                size="base"
                className="mt-1"
                icon={<RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />}
                onClick={() => activePath && void open(activePath)}
              >
                {t('market.retry')}
              </Button>
            </div>
          )}
          {state.kind === 'idle' && (
            <p className="py-10 text-center text-[13px] text-[var(--color-text-tertiary)]">{t('market.file.empty')}</p>
          )}
          {state.kind === 'loaded' &&
            (state.file.language === 'markdown' ? (
              <MarkdownFilePreview content={state.file.content} />
            ) : (
              <CodeViewer
                code={state.file.content}
                language={state.file.language}
                showLineNumbers
                wrapLongLines
                maxLines={500}
              />
            ))}
        </div>
      </div>
    </div>
  )
}
