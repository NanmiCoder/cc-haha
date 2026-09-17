import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Maximize2, Minimize2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useTranslation } from '@/i18n'

const focusable = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Move one persistent portal, not a second workspace: SSH jobs and drafts must survive maximize. */
export function ApplicationWorkspaceFrame({ name, tools, children }: {
  name: string
  tools?: ReactNode
  children: (fullScreen: boolean) => ReactNode
}) {
  const t = useTranslation()
  const [fullScreen, setFullScreen] = useState(false)
  const [mount] = useState(() => {
    const element = document.createElement('div')
    element.setAttribute('data-application-workspace-mount', '')
    return element
  })
  const slot = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const wasFullScreen = useRef(false)
  const normalScroll = useRef<Array<{ element: HTMLElement; left: number; top: number }>>([])
  const title = t('managedResources.appOperations.title')
  const changeSize = () => {
    if (!fullScreen) normalScroll.current = Array.from(mount.querySelectorAll<HTMLElement>('[data-testid="application-file-lists-scroll"], [role="list"]'))
      .map(element => ({ element, left: element.scrollLeft, top: element.scrollTop }))
    setFullScreen(value => !value)
  }

  useLayoutEffect(() => {
    const placeholder = slot.current!
    const background: Array<{ element: HTMLElement; inert: boolean }> = []
    const overflow = document.body.style.overflow
    if (fullScreen) {
      placeholder.style.height = `${placeholder.getBoundingClientRect().height}px`
      document.body.appendChild(mount)
      // Existing app chrome is not keyboard reachable behind the maximized workspace.
      // New dialog portals stay above it and retain their own focus/Escape handling.
      for (const element of Array.from(document.body.children)) {
        if (!(element instanceof HTMLElement) || element === mount || element.querySelector('[role="dialog"], [role="alertdialog"]')) continue
        background.push({ element, inert: element.hasAttribute('inert') })
        element.setAttribute('inert', '')
      }
      document.body.style.overflow = 'hidden'
    } else {
      placeholder.appendChild(mount)
      placeholder.style.height = ''
      for (const value of normalScroll.current) {
        value.element.scrollLeft = value.left
        value.element.scrollTop = value.top
      }
    }
    if (fullScreen || wasFullScreen.current) toggle.current?.focus({ preventScroll: true })
    wasFullScreen.current = fullScreen
    if (!fullScreen) return

    const handleKey = (event: KeyboardEvent) => {
      // Check in capture phase, before an inner Modal removes itself on Escape.
      if (event.isComposing || document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return
      // A populated file search handles its first Escape locally before leaving fullscreen.
      if (event.key === 'Escape' && event.target instanceof HTMLInputElement && event.target.matches('[data-application-file-search]') && event.target.value) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setFullScreen(false)
      } else if (event.key === 'Tab') {
        const elements = Array.from(mount.querySelectorAll<HTMLElement>(focusable))
          .filter(element => !element.closest('[hidden], [inert]') && element.getClientRects().length > 0)
        const first = elements[0]
        const last = elements.at(-1)
        if (!first || !last) return
        if (!mount.contains(document.activeElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
          event.preventDefault()
          ;(event.shiftKey ? last : first).focus()
        }
      }
    }
    document.addEventListener('keydown', handleKey, true)
    return () => {
      document.removeEventListener('keydown', handleKey, true)
      document.body.style.overflow = overflow
      for (const { element, inert } of background) if (!inert) element.removeAttribute('inert')
    }
  }, [fullScreen, mount])
  useLayoutEffect(() => () => mount.remove(), [mount])

  const sizeLabel = fullScreen ? t('managedResources.appOperations.restore') : t('managedResources.appOperations.fullScreen')
  return <>
    <div ref={slot} className="min-w-0" />
    {createPortal(
      <section data-testid="application-workspace" data-fullscreen={fullScreen} aria-label={title}
        className={fullScreen
          ? 'fixed inset-0 z-[var(--z-drawer)] flex min-h-0 flex-col overflow-hidden bg-[var(--color-surface)] p-4 text-[var(--color-text-primary)]'
          : 'mt-2 min-w-0 border-t border-[var(--color-border)] pt-3'}>
        <div className="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-2">
          <h3 className="min-w-0 text-xs font-semibold">{title}{fullScreen && <span className="ml-2 text-[var(--color-text-secondary)]">{name}</span>}</h3>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {tools}
            <Button ref={toggle} size="xs" variant="secondary" aria-label={sizeLabel} aria-pressed={fullScreen}
              icon={fullScreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />} onClick={changeSize}>{sizeLabel}</Button>
          </div>
        </div>
        {children(fullScreen)}
      </section>, mount,
    )}
  </>
}
