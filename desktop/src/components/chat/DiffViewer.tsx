import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued'
import { Highlight, type PrismTheme } from 'prism-react-renderer'
import { CircleCheck, Copy, FileCode } from 'lucide-react'
import { CopyButton } from '@/components/ui/CopyButton'
import { useTranslation } from '../../i18n'
import { useUIStore } from '../../stores/uiStore'
import { countDiffLines } from './toolCallPresentation'

type Props = {
  filePath: string
  oldString: string
  newString: string
}

function inferLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase()
  const langMap: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
    py: 'python', rs: 'rust', go: 'go', rb: 'ruby',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
    md: 'markdown', css: 'css', html: 'markup', xml: 'markup',
    sql: 'sql', sh: 'bash', bash: 'bash', zsh: 'bash',
  }
  return langMap[ext ?? ''] || 'text'
}

/** Shared warm syntax theme — must stay in sync with CodeViewer */
const warmSyntaxTheme: PrismTheme = {
  plain: {
    color: 'var(--color-code-fg)',
    backgroundColor: 'transparent',
  },
  styles: [
    { types: ['comment', 'prolog', 'doctype', 'cdata'], style: { color: 'var(--color-code-comment)' } },
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
    { types: ['regex'], style: { color: 'var(--color-primary-container)' } },
    { types: ['inserted'], style: { color: 'var(--color-code-inserted)' } },
    { types: ['deleted'], style: { color: 'var(--color-code-deleted)' } },
  ],
}

function highlightSyntax(str: string, language: string) {
  return (
    <Highlight theme={warmSyntaxTheme} code={str} language={language}>
      {({ tokens, getTokenProps }) => (
        <>
          {tokens.map((line, i) => (
            <span key={i}>
              {line.map((token, key) => (
                <span key={key} {...getTokenProps({ token })} />
              ))}
            </span>
          ))}
        </>
      )}
    </Highlight>
  )
}

/**
 * Every colour is a theme token, so one palette serves both the library's light
 * and dark modes; leaving `dark` unset dropped ink themes onto its defaults.
 */
const diffPalette = {
  diffViewerBackground: 'var(--color-surface-container-lowest)',
  diffViewerColor: 'var(--color-code-fg)',
  addedBackground: 'var(--color-diff-added-bg)',
  addedColor: 'var(--color-code-fg)',
  removedBackground: 'var(--color-diff-removed-bg)',
  removedColor: 'var(--color-code-fg)',
  wordAddedBackground: 'var(--color-diff-added-word)',
  wordRemovedBackground: 'var(--color-diff-removed-word)',
  addedGutterBackground: 'var(--color-diff-added-bg)',
  removedGutterBackground: 'var(--color-diff-removed-bg)',
  gutterBackground: 'var(--color-surface-container-lowest)',
  gutterBackgroundDark: 'var(--color-surface-container-lowest)',
  highlightBackground: 'var(--color-diff-highlight-bg)',
  highlightGutterBackground: 'var(--color-diff-highlight-gutter)',
  codeFoldGutterBackground: 'var(--color-surface-container)',
  codeFoldBackground: 'var(--color-surface-container)',
  emptyLineBackground: 'var(--color-surface-container-lowest)',
  gutterColor: 'var(--color-text-tertiary)',
  addedGutterColor: 'var(--color-diff-added-text)',
  removedGutterColor: 'var(--color-diff-removed-text)',
  codeFoldContentColor: 'var(--color-text-tertiary)',
  diffViewerTitleBackground: 'var(--color-diff-title-bg)',
  diffViewerTitleColor: 'var(--color-diff-title-color)',
  diffViewerTitleBorderColor: 'var(--color-diff-title-border)',
}

const diffStyles = {
  variables: {
    light: diffPalette,
    dark: diffPalette,
  },
  // The library pins the table to 1000px so long lines scroll sideways. In a
  // conversation that turned every diff into a horizontal scroller; lines wrap
  // at the column instead, which the content cell already supports.
  diffContainer: {
    minWidth: 'unset',
    borderRadius: '0',
    fontSize: '12px',
    lineHeight: '20px',
    fontFamily: 'var(--font-mono)',
    fontVariantLigatures: 'none',
  },
  line: {
    padding: '0',
  },
  gutter: {
    padding: '0 8px',
    minWidth: '36px',
    fontSize: '12px',
    fontVariantNumeric: 'tabular-nums',
  },
  marker: {
    padding: '0 6px',
  },
  wordDiff: {
    padding: '1px 0',
    borderRadius: 'var(--radius-xs)',
  },
}

/**
 * A file change as a block: a 32px head (path, `+N −N`, copy path) over a
 * unified diff with old/new line numbers.
 */
export function DiffViewer({ filePath, oldString, newString }: Props) {
  const t = useTranslation()
  const theme = useUIStore((state) => state.theme)
  const language = inferLanguage(filePath)
  const { additions, deletions } = countDiffLines(oldString, newString)
  // Split so a long absolute path gives way from the left: the directory
  // truncates, the file name never does.
  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  const directory = slash >= 0 ? filePath.slice(0, slash + 1) : ''
  const fileName = slash >= 0 ? filePath.slice(slash + 1) : filePath

  return (
    <div
      data-diff-block=""
      className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)]"
    >
      <div className="flex h-8 items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-container)] pl-2.5 pr-1.5 text-[12px]">
        <FileCode size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
        <span className="flex min-w-0 font-mono text-[12px]" title={filePath}>
          {directory ? <span className="min-w-0 truncate text-[var(--color-text-tertiary)]">{directory}</span> : null}
          <span className="shrink-0 text-[var(--color-text-primary)]">{fileName}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 font-mono tabular-nums">
          <span className="text-[var(--color-diff-added-text)]">+{additions}</span>
          <span className="text-[var(--color-diff-removed-text)]">−{deletions}</span>
        </span>
        <span className="flex-1" />
        <CopyButton
          text={`--- ${filePath}\n+++ ${filePath}`}
          label={t('chat.copyPath')}
          copiedLabel={t('common.copied')}
          displayLabel={<><Copy size={12} strokeWidth={2} aria-hidden="true" />{t('chat.copyPath')}</>}
          displayCopiedLabel={<><CircleCheck size={12} strokeWidth={2} aria-hidden="true" />{t('common.copied')}</>}
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-[var(--radius-sm)] px-1.5 text-[11px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus:outline-none focus-visible:shadow-[var(--shadow-focus-ring)]"
        />
      </div>

      <div className="max-h-[340px] overflow-auto">
        <ReactDiffViewer
          oldValue={oldString}
          newValue={newString}
          splitView={false}
          compareMethod={DiffMethod.WORDS}
          renderContent={(str) => highlightSyntax(str, language)}
          hideLineNumbers={false}
          hideSummary
          styles={diffStyles}
          useDarkTheme={theme === 'dark'}
        />
      </div>
    </div>
  )
}
