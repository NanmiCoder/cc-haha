import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowLeft, ArrowRight, Loader2, RotateCw } from 'lucide-react'
import { useTranslation } from '../../i18n'

type Props = {
  url: string
  canGoBack: boolean
  canGoForward: boolean
  loading?: boolean
  onNavigate: (url: string) => void
  onBack: () => void
  onForward: () => void
  onReload: () => void
  rightActions?: ReactNode
}

export function BrowserAddressBar({ url, canGoBack, canGoForward, loading = false, onNavigate, onBack, onForward, onReload, rightActions }: Props) {
  const t = useTranslation()
  const [draft, setDraft] = useState(url)
  useEffect(() => { setDraft(url) }, [url])

  return (
    <div
      data-testid="browser-address-bar"
      className="relative flex h-11 items-center gap-1 border-b border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-2"
    >
      <button aria-label={t('browser.back')} disabled={!canGoBack} onClick={onBack} className="p-1 disabled:opacity-40"><ArrowLeft size={16} /></button>
      <button aria-label={t('browser.forward')} disabled={!canGoForward} onClick={onForward} className="p-1 disabled:opacity-40"><ArrowRight size={16} /></button>
      <button aria-label={t('browser.refresh')} aria-busy={loading} onClick={onReload} className="p-1">
        {loading ? <Loader2 size={16} className="animate-spin" /> : <RotateCw size={16} />}
      </button>
      <form className="min-w-0 flex-1" onSubmit={(e) => { e.preventDefault(); onNavigate(normalizeBrowserAddress(draft)) }}>
        <input
          className="w-full rounded-md bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-text-primary)]"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t('browser.enterUrl')}
          spellCheck={false}
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
  if (/^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)(?::\d+)?(?:[/?#].*)?$/i.test(value)) {
    return `http://${value}`
  }
  return `https://${value}`
}
