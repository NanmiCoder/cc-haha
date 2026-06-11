import { useState, useRef, type ReactNode } from 'react'

type TooltipProps = {
  content: ReactNode
  shortcut?: string
  children: React.ReactElement
  side?: 'top' | 'bottom'
  delayMs?: number
}

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)

export function formatShortcut(shortcut: string): string {
  if (!isMac) return shortcut.replace('⌘', 'Ctrl+').replace('⌥', 'Alt+').replace('⇧', 'Shift+')
  return shortcut
}

export function Tooltip({ content, shortcut, children, side = 'bottom', delayMs = 300 }: TooltipProps) {
  const [visible, setVisible] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>()

  const show = () => {
    timeoutRef.current = setTimeout(() => setVisible(true), delayMs)
  }
  const hide = () => {
    clearTimeout(timeoutRef.current)
    setVisible(false)
  }

  return (
    <div className="relative inline-flex" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      {children}
      {visible && (
        <div
          role="tooltip"
          className={`absolute z-50 whitespace-nowrap rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-high)] px-2.5 py-1.5 text-xs font-medium text-[var(--color-text-primary)] shadow-[var(--shadow-dropdown)] ${
            side === 'top' ? 'bottom-full mb-2' : 'top-full mt-2'
          } left-1/2 -translate-x-1/2`}
        >
          <div className="flex items-center gap-2">
            <span>{content}</span>
            {shortcut && (
              <kbd className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-0.5 font-mono text-[10px] text-[var(--color-text-tertiary)]">
                {formatShortcut(shortcut)}
              </kbd>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
