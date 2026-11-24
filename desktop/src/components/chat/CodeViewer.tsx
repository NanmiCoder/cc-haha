import { useEffect, useRef, useState, type ComponentType, type CSSProperties } from 'react'
import { Highlight, type PrismTheme } from 'prism-react-renderer'
import { Check, Copy } from 'lucide-react'
import { CopyButton } from '@/components/ui/CopyButton'
import { useTranslation } from '../../i18n'

export type CodeViewerChrome = 'card' | 'embedded'

type Props = {
  code: string
  language?: string
  maxLines?: number
  showLineNumbers?: boolean
  wrapLongLines?: boolean
  chrome?: CodeViewerChrome
  label?: string
  /**
   * Drop the 420px cap on the code area and let it grow with its content.
   * For hosts that already scroll (a side panel): a capped box inside a
   * scrolling panel leaves the panel's own space empty below it.
   */
  unboundedHeight?: boolean
}

const warmPrismTheme: PrismTheme = {
  plain: {
    color: 'var(--color-code-fg)',
    backgroundColor: 'transparent',
  },
  styles: [
    // Comments are told apart by colour alone: a slanted comment is often
    // Chinese, and CJK has no italic — the browser just shears the glyphs.
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

const warmShikiTheme = {
  name: 'warm-code',
  type: 'dark' as const,
  fg: 'var(--color-code-fg)',
  bg: 'transparent',
  tokenColors: [
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: 'var(--color-code-comment)' } },
    { scope: ['string', 'string.quoted', 'string.template', 'string.other.link'], settings: { foreground: 'var(--color-code-string)' } },
    { scope: ['string.regexp'], settings: { foreground: 'var(--color-primary-container)' } },
    { scope: ['keyword', 'keyword.control', 'storage', 'storage.type', 'storage.modifier'], settings: { foreground: 'var(--color-code-keyword)' } },
    { scope: ['keyword.operator'], settings: { foreground: 'var(--color-code-keyword)' } },
    { scope: ['entity.name.function', 'support.function'], settings: { foreground: 'var(--color-code-function)' } },
    { scope: ['entity.name.type', 'support.type', 'support.class', 'entity.name.class', 'entity.other.inherited-class'], settings: { foreground: 'var(--color-code-type)' } },
    { scope: ['entity.name.type.parameter'], settings: { foreground: 'var(--color-code-number)' } },
    { scope: ['variable', 'variable.other', 'variable.other.readwrite'], settings: { foreground: 'var(--color-code-fg)' } },
    { scope: ['variable.parameter'], settings: { foreground: 'var(--color-code-parameter)' } },
    { scope: ['variable.other.property', 'support.type.property-name', 'meta.object-literal.key'], settings: { foreground: 'var(--color-code-property)' } },
    { scope: ['variable.other.constant', 'variable.other.enummember'], settings: { foreground: 'var(--color-code-type)' } },
    { scope: ['constant.numeric', 'constant.language'], settings: { foreground: 'var(--color-code-number)' } },
    { scope: ['punctuation', 'meta.brace', 'meta.bracket'], settings: { foreground: 'var(--color-code-punctuation)' } },
    { scope: ['entity.name.tag', 'punctuation.definition.tag'], settings: { foreground: 'var(--color-code-keyword)' } },
    { scope: ['entity.other.attribute-name'], settings: { foreground: 'var(--color-code-property)' } },
    { scope: ['meta.decorator', 'punctuation.decorator'], settings: { foreground: 'var(--color-code-type)' } },
    { scope: ['markup.inserted', 'punctuation.definition.inserted'], settings: { foreground: 'var(--color-code-inserted)' } },
    { scope: ['markup.deleted', 'punctuation.definition.deleted'], settings: { foreground: 'var(--color-code-deleted)' } },
    // No bold: the mono face ships at 400 only, so "bold" is synthesized smear.
    { scope: ['markup.heading', 'entity.name.section'], settings: { foreground: 'var(--color-code-function)' } },
  ],
}

/** Vertical only: the 14px gutter sits on each line (globals.css), so a hovered line is a full-width band. */
const CODE_AREA_PADDING = '10px 0 12px'
const CODE_LINE_HEIGHT = 1.65

type ShikiHighlighterProps = {
  language: string
  theme: typeof warmShikiTheme
  engine: unknown
  showLineNumbers: boolean
  showLanguage: boolean
  addDefaultStyles: boolean
  style: CSSProperties
  children: string
}

type ReactShikiModule = {
  ShikiHighlighter: ComponentType<any>
  createJavaScriptRegexEngine: (options: { forgiving: boolean }) => unknown
}

type ShikiRuntime = {
  Highlighter: ComponentType<ShikiHighlighterProps>
  engine: unknown
}

let shikiRuntimePromise: Promise<ShikiRuntime | null> | null = null

function canUseShikiRuntime(): boolean {
  if (import.meta.env.MODE === 'test') return false
  if (typeof window === 'undefined') return false

  try {
    new RegExp('(?<name>a)')
    new RegExp('(?<=a)b')
  } catch {
    return false
  }

  const ua = window.navigator.userAgent
  const chromiumLike = /\b(Chrome|Chromium|CriOS|Edg|OPR|Firefox)\b/.test(ua)
  const safariVersion = /\bVersion\/(\d+)(?:\.\d+)?\b.*\bSafari\//.exec(ua)
  if (!chromiumLike && safariVersion && Number(safariVersion[1]) <= 15) {
    return false
  }

  return true
}

function loadShikiRuntime(): Promise<ShikiRuntime | null> {
  if (!canUseShikiRuntime()) return Promise.resolve(null)
  shikiRuntimePromise ??= import('react-shiki')
    .then((mod) => {
      const shiki = mod as unknown as ReactShikiModule
      return {
        Highlighter: shiki.ShikiHighlighter as ComponentType<ShikiHighlighterProps>,
        engine: shiki.createJavaScriptRegexEngine({ forgiving: true }),
      }
    })
    .catch(() => null)
  return shikiRuntimePromise
}

function PrismCodeContent({
  code,
  language,
  showLineNumbers,
  wrapLongLines,
}: {
  code: string
  language?: string
  showLineNumbers: boolean
  wrapLongLines: boolean
}) {
  return (
    <Highlight
      theme={warmPrismTheme}
      code={code}
      language={language || 'text'}
    >
      {({ tokens, getLineProps, getTokenProps }) => (
        <pre
          data-code-viewer-content=""
          data-highlight-engine="prism"
          style={{
            margin: 0,
            padding: CODE_AREA_PADDING,
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--code-viewer-font-size, 13px)',
            lineHeight: String(CODE_LINE_HEIGHT),
            whiteSpace: wrapLongLines ? 'pre-wrap' : 'pre',
            wordBreak: wrapLongLines ? 'break-word' : 'normal',
            color: 'var(--color-code-fg)',
          }}
        >
          {tokens.map((line, index) => (
            <span
              key={index}
              {...getLineProps({ line })}
              data-line-number={showLineNumbers ? index + 1 : undefined}
            >
              {showLineNumbers && (
                <span className="mr-3 inline-block min-w-[2.5ch] select-none text-right text-[11px] text-[var(--color-text-tertiary)]">
                  {index + 1}
                </span>
              )}
              {line.map((token, key) => (
                <span key={key} {...getTokenProps({ token })} />
              ))}
            </span>
          ))}
        </pre>
      )}
    </Highlight>
  )
}

function CodeArea({
  code,
  language,
  showLineNumbers,
  wrapLongLines,
  unboundedHeight,
}: {
  code: string
  language?: string
  showLineNumbers: boolean
  wrapLongLines: boolean
  unboundedHeight: boolean
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [runtime, setRuntime] = useState<ShikiRuntime | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoaded(false)
    loadShikiRuntime().then((nextRuntime) => {
      if (!cancelled) setRuntime(nextRuntime)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    setLoaded(false)
  }, [code, language])

  useEffect(() => {
    if (!runtime) return
    const el = containerRef.current
    if (!el) return
    const check = () => {
      const shikiContainer = el.querySelector('[data-testid="shiki-container"]')
      if (shikiContainer?.querySelector('code')) {
        setLoaded(true)
      }
    }
    check()
    const observer = new MutationObserver(check)
    observer.observe(el, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [runtime, code, language])

  const ShikiHighlighter = runtime?.Highlighter

  return (
    <div
      ref={containerRef}
      data-has-line-numbers={showLineNumbers ? 'true' : 'false'}
      data-unbounded-height={unboundedHeight ? 'true' : undefined}
      className={`code-viewer-area relative overflow-auto bg-[var(--color-code-bg)] ${unboundedHeight ? '' : 'max-h-[420px]'}`}
    >
      {(!ShikiHighlighter || !loaded) && (
        <PrismCodeContent
          code={code}
          language={language}
          showLineNumbers={showLineNumbers}
          wrapLongLines={wrapLongLines}
        />
      )}
      {ShikiHighlighter && (
        <div
          data-code-viewer-content=""
          data-highlight-engine="shiki"
          style={
            loaded
              ? { padding: CODE_AREA_PADDING }
              : {
                  position: 'absolute',
                  inset: 0,
                  opacity: 0,
                  pointerEvents: 'none',
                  padding: CODE_AREA_PADDING,
                }
          }
        >
          <ShikiHighlighter
            language={language || 'text'}
            theme={warmShikiTheme}
            engine={runtime.engine}
            showLineNumbers={showLineNumbers}
            showLanguage={false}
            addDefaultStyles={false}
            style={{
              margin: 0,
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--code-viewer-font-size, 13px)',
              lineHeight: String(CODE_LINE_HEIGHT),
              whiteSpace: wrapLongLines ? 'pre-wrap' : 'pre',
              wordBreak: wrapLongLines ? 'break-word' : 'normal',
            }}
          >
            {code}
          </ShikiHighlighter>
        </div>
      )}
    </div>
  )
}

export function CodeViewer({
  code,
  language,
  maxLines = 20,
  showLineNumbers = false,
  wrapLongLines = false,
  chrome = 'card',
  label,
  unboundedHeight = false,
}: Props) {
  const t = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const isEmbedded = chrome === 'embedded'

  const allLines = code.split('\n')
  const isTruncated = !expanded && allLines.length > maxLines
  const visibleCode = isTruncated ? allLines.slice(0, maxLines).join('\n') : code

  const effectiveShowLineNumbers = showLineNumbers && !!language && language !== 'text'
  const languageLabel = language || 'code'
  const lineCountLabel = t(
    allLines.length === 1 ? 'tool.lineCountSingular' : 'tool.lineCountPlural',
    { count: allLines.length },
  )
  const showExpandToggle = allLines.length > maxLines

  return (
    <div
      data-code-viewer-chrome={chrome}
      style={{ fontFamily: 'var(--font-body)' }}
      className={
        isEmbedded
          ? 'overflow-hidden bg-[var(--color-code-bg)]'
          : 'overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-code-bg)]'
      }
    >
      {/* Header: one quiet 30px line on the code's own ground. */}
      <div className="flex h-[30px] items-center justify-between gap-2 border-b border-[var(--color-border)] pl-3 pr-1.5 text-[11px] text-[var(--color-text-tertiary)]">
        <div className="flex min-w-0 items-center gap-1.5">
          {label ? (
            <>
              <span className="shrink-0 font-medium text-[var(--color-text-secondary)]">{label}</span>
              <span aria-hidden="true" className="h-[3px] w-[3px] shrink-0 rounded-full bg-[var(--color-text-tertiary)]" />
            </>
          ) : null}
          <span className="truncate font-mono">{languageLabel}</span>
          <span aria-hidden="true" className="h-[3px] w-[3px] shrink-0 rounded-full bg-[var(--color-text-tertiary)]" />
          <span className="shrink-0 tabular-nums">{lineCountLabel}</span>
        </div>
        <CopyButton
          text={code}
          label={t('common.copy')}
          copiedLabel={t('common.copied')}
          displayLabel={<><Copy size={12} strokeWidth={2} aria-hidden="true" />{t('common.copy')}</>}
          displayCopiedLabel={<><Check size={12} strokeWidth={2} aria-hidden="true" />{t('common.copied')}</>}
          className="inline-flex h-[22px] shrink-0 items-center gap-1 rounded-[var(--radius-xs)] px-1.5 text-[11px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
        />
      </div>

      {/* Code area */}
      <CodeArea
        code={visibleCode}
        language={language}
        showLineNumbers={effectiveShowLineNumbers}
        wrapLongLines={wrapLongLines}
        unboundedHeight={unboundedHeight}
      />

      {/* Expand/collapse toggle */}
      {showExpandToggle && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex h-[30px] w-full items-center justify-center border-t border-[var(--color-border)] text-[11px] font-medium text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]"
        >
          {expanded
            ? t('codeViewer.collapse')
            : t('codeViewer.showMoreLines', { count: allLines.length - maxLines })}
        </button>
      )}
    </div>
  )
}
