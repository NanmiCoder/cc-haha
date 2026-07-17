import { useCallback, useRef, useState } from 'react'
import { useUIStore } from '../../stores/uiStore'
import { useTabStore } from '../../stores/tabStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useTranslation } from '../../i18n'
import { SessionChat } from '../chat/SessionChat'

export function SideSessionPanel() {
  const t = useTranslation()
  const activeTabId = useTabStore((s) => s.activeTabId)
  const sideSessions = useUIStore((s) => s.sideSessions)
  const clearSideSession = useUIStore((s) => s.clearSideSession)
  const deleteSession = useSessionStore((s) => s.deleteSession)
  const [width, setWidth] = useState(() => {
    const chatWidth = window.innerWidth - 340  // 减左侧列表宽度
    return Math.min(Math.max(Math.floor(chatWidth * 0.4), 280), chatWidth * 0.5)
  })

  const sideSessionId = activeTabId ? sideSessions[activeTabId] : undefined

  // 拖拽分隔线
  const dragRef = useRef(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(480)

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragRef.current = true
    startXRef.current = e.clientX
    startWidthRef.current = width
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [width])

  const onMouseMove = useCallback((e: MouseEvent) => {
    if (!dragRef.current) return
    const delta = startXRef.current - e.clientX
    const next = Math.min(Math.max(startWidthRef.current + delta, 280), window.innerWidth * 0.5)
    setWidth(next)
  }, [])

  const onMouseUp = useCallback(() => {
    dragRef.current = false
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
  }, [onMouseMove])

  const wrapperClass = "relative flex flex-col flex-shrink-0 border-l border-[var(--color-border)] min-w-[280px] max-w-[50vw] bg-[var(--color-background)]"

  if (!sideSessionId) return null

  return (
    <div className={wrapperClass} style={{ width }}>
      {/* 可拖拽分割线 */}
      <div
        onMouseDown={onMouseDown}
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-[var(--color-accent)]/20 z-10"
        style={{ marginLeft: -2 }}
      />

      <div className="self-start group inline-flex items-center gap-2 shrink-0 m-2 px-3 py-1.5 rounded-lg bg-[var(--color-surface-container-low)]">
        <span className="text-xs font-medium text-[var(--color-text-tertiary)] group-hover:text-[var(--color-text-primary)]">{t('sideChat.label')}</span>
        <button
          onClick={async () => { try { await deleteSession(sideSessionId) } catch {}; clearSideSession(activeTabId!) }}
          className="rounded p-0.5 text-[var(--color-text-tertiary)] group-hover:bg-[var(--color-surface-hover)] group-hover:text-[var(--color-text-primary)]"
        >✕</button>
      </div>
      <div className="flex flex-col flex-1 min-h-0 bg-[var(--color-background)]">
        <SessionChat sessionId={sideSessionId} />
      </div>
    </div>
  )
}
