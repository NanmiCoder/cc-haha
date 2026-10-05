import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { useDismissable } from '@/hooks/useDismissable'
import { useTranslation } from '../../i18n'
import type { ReasoningEffortLevel } from '../../types/settings'
import { COMPOSER_MENU_SECTION, COMPOSER_POPOVER } from '@/components/chat/composerMenuStyles'

type Props = {
  open: boolean
  anchorRef: React.RefObject<HTMLElement>
  options: ReasoningEffortLevel[]
  value: ReasoningEffortLevel
  labels: Record<ReasoningEffortLevel, string>
  onChange: (value: ReasoningEffortLevel) => void
  onClose: () => void
  ariaLabel?: string
}

type PopoverPosition = {
  bottom: number
  left: number
  width: number
}

const POPOVER_WIDTH = 320
const VIEWPORT_MARGIN = 16
const POPOVER_GAP = 8

export function ReasoningEffortPopover({
  open,
  anchorRef,
  options,
  value,
  labels,
  onChange,
  onClose,
  ariaLabel,
}: Props) {
  const t = useTranslation()
  // The default used to be a hardcoded Chinese literal, so a caller that left
  // `ariaLabel` off announced the slider in Chinese under every locale.
  const label = ariaLabel ?? t('model.effort')
  const popoverRef = useRef<HTMLDivElement>(null)
  const sliderRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)
  const [position, setPosition] = useState<PopoverPosition | null>(null)
  const selectedIndex = Math.max(0, options.indexOf(value))
  const maxIndex = Math.max(0, options.length - 1)

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }

    const updatePosition = () => {
      const rect = anchorRef.current?.getBoundingClientRect()
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth
      const width = Math.min(POPOVER_WIDTH, viewportWidth - VIEWPORT_MARGIN * 2)
      const anchorRight = rect?.right ?? viewportWidth - VIEWPORT_MARGIN
      const anchorTop = rect?.top ?? window.innerHeight / 2
      const left = Math.min(
        Math.max(VIEWPORT_MARGIN, anchorRight - width),
        Math.max(VIEWPORT_MARGIN, viewportWidth - width - VIEWPORT_MARGIN),
      )
      setPosition({
        bottom: Math.max(VIEWPORT_MARGIN, window.innerHeight - anchorTop + POPOVER_GAP),
        left,
        width,
      })
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [anchorRef, open])

  // Escape is deliberately left to the slider's own key handler below, which
  // also returns focus to the anchor; letting the hook handle it too would fire
  // `onClose` twice for one key press.
  useDismissable({
    open,
    refs: [popoverRef],
    triggerRef: anchorRef,
    onDismiss: onClose,
    capture: false,
    closeOnEscape: false,
  })

  if (!open || !position || options.length === 0) return null

  const selectFromClientX = (clientX: number) => {
    const rect = sliderRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    const nextIndex = Math.round(ratio * maxIndex)
    const nextValue = options[nextIndex]
    if (nextValue && nextValue !== value) onChange(nextValue)
  }

  const moveBy = (offset: number) => {
    const nextIndex = Math.min(maxIndex, Math.max(0, selectedIndex + offset))
    const nextValue = options[nextIndex]
    if (nextValue && nextValue !== value) onChange(nextValue)
  }

  return createPortal(
    <div
      ref={popoverRef}
      data-testid="reasoning-effort-popover"
      className={`fixed z-[var(--z-popover)] ${COMPOSER_POPOVER}`}
      style={{ bottom: position.bottom, left: position.left, width: position.width }}
    >
      <div data-testid="reasoning-effort-header" className={COMPOSER_MENU_SECTION}>
        <span data-testid="reasoning-effort-context-label">{label}</span>
      </div>

      {/* A five-way segmented control that keeps the slider semantics: one
          tab stop, arrow keys step, Home/End jump, and a press or drag picks
          the nearest segment. The segments are its visual, so they are not
          separate controls. */}
      <div
        ref={sliderRef}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={maxIndex}
        aria-valuenow={selectedIndex}
        aria-valuetext={labels[value]}
        className="mx-1 mb-1 mt-0.5 grid h-[30px] touch-none cursor-pointer gap-0.5 rounded-[var(--radius-sm)] bg-[var(--color-surface-container)] p-0.5 outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
        style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
        onClick={(event) => selectFromClientX(event.clientX)}
        onPointerDown={(event) => {
          draggingRef.current = true
          event.currentTarget.setPointerCapture?.(event.pointerId)
          selectFromClientX(event.clientX)
        }}
        onPointerMove={(event) => {
          if (draggingRef.current) selectFromClientX(event.clientX)
        }}
        onPointerUp={(event) => {
          if (!draggingRef.current) return
          draggingRef.current = false
          selectFromClientX(event.clientX)
          event.currentTarget.releasePointerCapture?.(event.pointerId)
        }}
        onPointerCancel={() => {
          draggingRef.current = false
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
            anchorRef.current?.focus()
            return
          }
          if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
            event.preventDefault()
            moveBy(-1)
          } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
            event.preventDefault()
            moveBy(1)
          } else if (event.key === 'Home') {
            event.preventDefault()
            const firstValue = options[0]
            if (firstValue && firstValue !== value) onChange(firstValue)
          } else if (event.key === 'End') {
            event.preventDefault()
            const lastValue = options[maxIndex]
            if (lastValue && lastValue !== value) onChange(lastValue)
          }
        }}
      >
        {options.map((option, index) => {
          const selected = index === selectedIndex
          return (
            <span
              key={option}
              data-testid="reasoning-effort-stop"
              data-selected={selected || undefined}
              title={labels[option]}
              // The lifted segment of `SegmentedControl`: the selected step sits
              // on the popover's own white with the segment shadow; the rest are
              // tertiary type on the sunken track.
              className={`flex min-w-0 items-center justify-center truncate rounded-[var(--radius-xs)] px-1 text-xs transition-colors ${
                selected
                  ? 'bg-[var(--color-surface-container-lowest)] font-medium text-[var(--color-text-primary)] shadow-[var(--shadow-segment)]'
                  : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]'
              }`}
            >
              {labels[option]}
            </span>
          )
        })}
      </div>
    </div>,
    document.body,
  )
}
