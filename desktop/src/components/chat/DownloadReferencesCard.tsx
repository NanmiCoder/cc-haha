import { useEffect, useMemo, useState } from 'react'
import { getFileSize, setFileSize } from '../../lib/fileSizeCache'
import { fileTypeIcon, formatFileSize } from '../../lib/downloadFileMeta'
import { localFileUrl } from '../../lib/handlePreviewLink'
import { getServerBaseUrl } from '../../lib/desktopRuntime'
import { useTranslation } from '../../i18n'

const PAGE_STEP = 20
const INITIAL_VISIBLE = 20

/**
 * References-style download card for ONE tool-execution turn. It collects
 * every Read tool call in the turn (plain or downloadOnly — both offer a
 * download) into a single list, rendered after the turn's tool group, NOT
 * nested inside the collapsed tool execution. The card is fixed-width
 * (references-style), visible by default, and paginated (20 + "show more" +
 * "show all").
 *
 * File sizes come from the two-tier fileSizeCache (hot 50/120s → cold
 * 150/30min); missing sizes are fetched once from /local-file?info=1.
 */
export function TurnDownloadCard({
  toolCalls,
}: {
  toolCalls: Array<{
    toolName: string
    input?: unknown
    toolUseId: string
  }>
}) {
  const t = useTranslation()
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE)
  const [collapsed, setCollapsed] = useState(true)
  const [sizes, setSizes] = useState<Record<string, number>>({})

  const files = useMemo(() => {
    const seen = new Set<string>()
    const result: Array<{ path: string; name: string }> = []
    for (const toolCall of toolCalls) {
      if (toolCall.toolName !== 'Read') continue
      const input = toolCall.input as { file_path?: unknown } | null | undefined
      const filePath = input && typeof input.file_path === 'string' ? input.file_path : undefined
      if (!filePath || seen.has(filePath)) continue
      seen.add(filePath)
      const name = filePath.replace(/\\/g, '/').split('/').pop() || filePath
      result.push({ path: filePath, name })
    }
    return result
  }, [toolCalls])

  // Resolve sizes lazily: a collapsed card makes zero requests; expanding
  // the card fetches all missing sizes in ONE batch request (POST
  // /local-file/info) and fills the two-tier size cache.
  useEffect(() => {
    if (collapsed) return
    if (files.length === 0) return
    const base = getServerBaseUrl()
    let cancelled = false
    const pending: Array<{ path: string }> = []
    const next: Record<string, number> = {}
    for (const file of files) {
      const cached = getFileSize(file.path)
      if (cached !== undefined) {
        next[file.path] = cached
      } else {
        pending.push({ path: file.path })
      }
    }
    if (!cancelled && Object.keys(next).length > 0) setSizes(next)
    if (pending.length === 0) return
    const request = (url: string) =>
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: pending.map((p) => p.path) }),
      })
    request(`${base}/local-file/info`)
      .catch(() => request('/local-file/info'))
      .then((res) => (res.ok ? (res.json() as Promise<{ files?: Record<string, { size?: number }> }>) : null))
      .then((data) => {
        if (cancelled || !data?.files) return
        for (const file of pending) {
          const info = data.files[file.path]
          if (info && typeof info.size === 'number') {
            setFileSize(file.path, info.size)
            setSizes((s) => ({ ...s, [file.path]: info.size! }))
          }
        }
      })
      .catch(() => {
        // sizes stay unknown; rows show '--'
      })
    return () => {
      cancelled = true
    }
  }, [files, collapsed])

  if (files.length === 0) return null

  const base = getServerBaseUrl()
  const total = files.length
  const visibleFiles = files.slice(0, visibleCount)

  return (
    <div className="mt-3 w-full max-w-[384px] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)]">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-[#ea580c] transition-colors hover:bg-[var(--color-surface-hover)]"
      >
        <span className="material-symbols-outlined text-[13px]">download</span>
        {t('chat.downloadableFiles')}
        <span className="ml-1 rounded-full bg-[var(--color-surface-container-high)] px-1.5 py-px text-[10px] font-bold tabular-nums">
          {total}
        </span>
        <span className={`ml-auto material-symbols-outlined text-[14px] transition-transform ${collapsed ? '' : 'rotate-180'}`}>
          expand_more
        </span>
      </button>

      {!collapsed && (
        <div className="space-y-1 border-t border-[var(--color-border)] p-2">
          {visibleFiles.map((file, index) => {
            const url = `${localFileUrl(base, file.path)}?download=1`
            return (
              <div
                key={file.path}
                className="flex items-center gap-2 rounded-[var(--radius-md)] px-2 py-1.5 hover:bg-[var(--color-surface-hover)]"
              >
                <span className="w-5 shrink-0 text-right font-mono text-[10px] text-[var(--color-text-tertiary)]">
                  {index + 1}
                </span>
                <span className="material-symbols-outlined shrink-0 text-[16px] text-[var(--color-text-tertiary)]">
                  {fileTypeIcon(file.path)}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[#2563eb]" title={file.path}>
                  {file.name}
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
                  {sizes[file.path] !== undefined ? formatFileSize(sizes[file.path]!) : '--'}
                </span>
                <a
                  href={url}
                  download={file.name}
                  className="shrink-0 rounded-[var(--radius-sm)] bg-[var(--color-brand)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-on-primary)] no-underline transition-opacity hover:opacity-90"
                >
                  {t('workspace.download')}
                </a>
              </div>
            )
          })}
          {visibleCount < total && (
            <div className="space-y-1 pt-1">
              <button
                type="button"
                onClick={() => setVisibleCount((c) => Math.min(c + PAGE_STEP, total))}
                className="w-full rounded-[var(--radius-md)] px-2 py-1.5 text-center text-[11px] font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)]"
              >
                {t('chat.downloadableMore', { count: total - visibleCount })}
              </button>
              <button
                type="button"
                onClick={() => setVisibleCount(total)}
                className="w-full rounded-[var(--radius-md)] px-2 py-1.5 text-center text-[11px] font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)]"
              >
                {t('chat.downloadableAll')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
