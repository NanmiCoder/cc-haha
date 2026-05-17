import { useEffect, useState } from 'react'
import { Highlight, type PrismTheme } from 'prism-react-renderer'
import { useTranslation } from '../../i18n'

export const WORKSPACE_PREVIEW_LINE_LIMIT = 2000
export const WORKSPACE_PLAIN_TEXT_LINE_THRESHOLD = 5000

export const workspacePrismTheme: PrismTheme = {
  plain: {
    color: 'var(--color-code-fg)',
    backgroundColor: 'transparent',
  },
  styles: [
    { types: ['comment', 'prolog', 'doctype', 'cdata'], style: { color: 'var(--color-code-comment)', fontStyle: 'italic' } },
    { types: ['string', 'attr-value', 'template-string'], style: { color: 'var(--color-code-string)' } },
    { types: ['keyword', 'selector', 'important', 'atrule'], style: { color: 'var(--color-code-keyword)' } },
    { types: ['function'], style: { color: 'var(--color-code-function)' } },
    { types: ['tag'], style: { color: 'var(--color-code-keyword)' } },
    { types: ['number', 'boolean'], style: { color: 'var(--color-code-number)' } },
    { types: ['operator'], style: { color: 'var(--color-code-fg)' } },
    { types: ['punctuation'], style: { color: 'var(--color-code-punctuation)' } },
    { types: ['variable', 'parameter'], style: { color: 'var(--color-code-fg)' } },
    { types: ['property', 'attr-name'], style: { color: 'var(--color-code-property)' } },
    { types: ['builtin', 'class-name', 'constant', 'symbol'], style: { color: 'var(--color-code-type)' } },
    { types: ['inserted'], style: { color: 'var(--color-code-inserted)' } },
    { types: ['deleted'], style: { color: 'var(--color-code-deleted)' } },
  ],
}

export function getFileExtension(name: string) {
  const cleanName = name.split('/').pop() ?? name
  const lastDot = cleanName.lastIndexOf('.')
  if (lastDot <= 0 || lastDot === cleanName.length - 1) return ''
  return cleanName.slice(lastDot + 1).toLowerCase()
}

export function normalizePrismLanguage(language: string) {
  const lower = language.toLowerCase()
  const map: Record<string, string> = {
    text: 'text',
    typescript: 'typescript',
    ts: 'typescript',
    tsx: 'tsx',
    javascript: 'javascript',
    js: 'javascript',
    jsx: 'jsx',
    markdown: 'markdown',
    md: 'markdown',
    html: 'markup',
    xml: 'markup',
    shell: 'bash',
    sh: 'bash',
    zsh: 'bash',
    diff: 'diff',
  }
  return map[lower] ?? lower
}

export function getLanguageFromPath(path: string) {
  return normalizePrismLanguage(getFileExtension(path) || 'text')
}

export function InlineHighlightedCode({
  value,
  language,
}: {
  value: string
  language: string
}) {
  return (
    <Highlight
      theme={workspacePrismTheme}
      code={value}
      language={normalizePrismLanguage(language)}
    >
      {({ tokens, getTokenProps }) => (
        <>
          {(tokens[0] ?? []).map((token, tokenIndex) => {
            const { key: tokenKey, ...tokenProps } = getTokenProps({ token, key: tokenIndex })
            return <span key={String(tokenKey)} {...tokenProps} />
          })}
        </>
      )}
    </Highlight>
  )
}

export function WorkspaceDiffSurface({
  value,
  path,
  className = 'min-h-0 flex-1 overflow-auto bg-[var(--color-code-bg)]',
  lineLimit = WORKSPACE_PREVIEW_LINE_LIMIT,
}: {
  value: string
  path: string
  className?: string
  lineLimit?: number
}) {
  const t = useTranslation()
  const [showAllLines, setShowAllLines] = useState(false)
  const lines = value.split('\n')
  const visibleLines = showAllLines ? lines : lines.slice(0, lineLimit)
  const language = getLanguageFromPath(path)
  const usePlainLargePreview = showAllLines && lines.length > WORKSPACE_PLAIN_TEXT_LINE_THRESHOLD

  useEffect(() => {
    setShowAllLines(false)
  }, [path, value])

  return (
    <div className={className}>
      <div className="relative min-w-max py-2">
        <pre
          data-workspace-code=""
          data-testid="workspace-code"
          className="m-0 font-[var(--font-mono)] text-[12px] leading-[1.55] text-[var(--color-code-fg)]"
        >
          {visibleLines.map((line, index) => {
            const isFileHeader = line.startsWith('diff --') || line.startsWith('--- ') || line.startsWith('+++ ')
            const isHunk = line.startsWith('@@')
            const isAdded = line.startsWith('+') && !line.startsWith('+++')
            const isRemoved = line.startsWith('-') && !line.startsWith('---')
            const isCodeLine = isAdded || isRemoved || line.startsWith(' ')
            const code = isCodeLine ? line.slice(1) : line
            const prefix = isCodeLine ? line[0] : ' '

            return (
              <div
                key={index}
                className={`grid min-w-full w-max grid-cols-[48px_18px_max-content] gap-2 px-3 ${
                  isAdded
                    ? 'bg-[var(--color-diff-added-bg)]'
                    : isRemoved
                      ? 'bg-[var(--color-diff-removed-bg)]'
                      : isHunk
                        ? 'bg-[var(--color-diff-highlight-bg)]'
                        : 'hover:bg-[var(--color-surface-hover)]'
                }`}
              >
                <span className="select-none text-right text-[11px] text-[var(--color-text-tertiary)]">
                  {index + 1}
                </span>
                <span
                  className={`select-none text-center ${
                    isAdded
                      ? 'text-[var(--color-diff-added-text)]'
                      : isRemoved
                        ? 'text-[var(--color-diff-removed-text)]'
                        : 'text-[var(--color-text-tertiary)]'
                  }`}
                >
                  {prefix}
                </span>
                <span
                  className={`whitespace-pre pr-6 ${
                    isFileHeader
                      ? 'font-semibold text-[var(--color-text-secondary)]'
                      : isHunk
                        ? 'font-semibold text-[var(--color-warning)]'
                        : ''
                  }`}
                >
                  {isCodeLine && !usePlainLargePreview ? (
                    code ? <InlineHighlightedCode value={code} language={language} /> : ' '
                  ) : (
                    code || ' '
                  )}
                </span>
              </div>
            )
          })}
        </pre>
        {lines.length > lineLimit && (
          <div className="sticky bottom-0 flex items-center gap-3 border-t border-[var(--color-border)] bg-[var(--color-surface-glass)] px-3 py-2 text-xs text-[var(--color-text-tertiary)] backdrop-blur">
            <span>
              {showAllLines
                ? t('workspace.previewAllLines', { total: lines.length })
                : t('workspace.previewLineLimit', { count: visibleLines.length, total: lines.length })}
            </span>
            <button
              type="button"
              onClick={() => setShowAllLines((current) => !current)}
              className="ml-auto rounded-[6px] px-2 py-1 text-[12px] font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
            >
              {showAllLines ? t('workspace.collapsePreview') : t('workspace.showAllLoadedLines')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
