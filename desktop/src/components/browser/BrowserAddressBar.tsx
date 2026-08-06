import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowLeft, ArrowRight, ArrowUpRight, RotateCw } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'
import { Spinner } from '@/components/ui/Spinner'
import { useTranslation } from '../../i18n'
import { isHtmlFilePath } from '../../lib/htmlPreviewPolicy'

type Props = {
  url: string
  canGoBack: boolean
  canGoForward: boolean
  loading?: boolean
  onNavigate: (url: string) => void
  onBack: () => void
  onForward: () => void
  onReload: () => void
  onOpenExternal: () => void
  rightActions?: ReactNode
}

export function BrowserAddressBar({ url, canGoBack, canGoForward, loading = false, onNavigate, onBack, onForward, onReload, onOpenExternal, rightActions }: Props) {
  const t = useTranslation()
  const [draft, setDraft] = useState(url)
  useEffect(() => { setDraft(url) }, [url])

  return (
    <div
      data-testid="browser-address-bar"
      className="relative flex h-11 items-center gap-1 border-b border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-2"
    >
      <IconButton icon={<ArrowLeft size={16} />} label={t('browser.back')} size="xs" disabled={!canGoBack} onClick={onBack} />
      <IconButton icon={<ArrowRight size={16} />} label={t('browser.forward')} size="xs" disabled={!canGoForward} onClick={onForward} />
      {/* `aria-busy` stays explicit: the reload button must remain clickable while
          loading, so IconButton's `loading` prop (which disables) is not used. */}
      <IconButton
        icon={loading ? <Spinner size={16} /> : <RotateCw size={16} />}
        label={t('browser.reload')}
        size="xs"
        aria-busy={loading}
        onClick={onReload}
      />
      <form className="relative min-w-0 flex-1" onSubmit={(e) => { e.preventDefault(); onNavigate(normalizeBrowserAddress(draft)) }}>
        <input
          className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] py-1 pl-2.5 pr-8 font-mono text-xs text-[var(--color-text-primary)] outline-none transition-[border-color,box-shadow] duration-150 ease-out placeholder:font-[var(--font-body)] placeholder:text-[var(--color-text-tertiary)] hover:border-[var(--color-outline)] focus-visible:border-[var(--color-border-focus)] focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t('browser.addressPlaceholder')}
          spellCheck={false}
        />
        <IconButton
          icon={<ArrowUpRight size={15} strokeWidth={1.9} aria-hidden="true" />}
          label={t('openWith.systemBrowser')}
          size="xs"
          tone="muted"
          disabled={!url}
          onClick={onOpenExternal}
          className="absolute right-0.5 top-1/2 -translate-y-1/2"
        />
      </form>
      {rightActions && (
        <div data-testid="browser-toolbar-actions" className="ml-1 flex shrink-0 items-center gap-1">
          {rightActions}
        </div>
      )}
      {loading && (
        <div
          role="progressbar"
          aria-label={t('browser.loading')}
          data-testid="browser-loading-bar"
          className="progress-indeterminate-track pointer-events-none absolute inset-x-0 bottom-0 h-0.5"
        />
      )}
    </div>
  )
}

export function normalizeBrowserAddress(input: string): string {
  const value = input.trim()
  if (!value) return ''
  if (/^[a-z][a-z\d+\-.]*:\/\//i.test(value) || /^(about|data|file):/i.test(value)) return value
  if (isHtmlFilePath(value)) return value
  if (/^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)(?::\d+)?(?:[/?#].*)?$/i.test(value)) {
    return `http://${value}`
  }
  return `https://${value}`
}
