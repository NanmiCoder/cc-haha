import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type { ReasoningEffortLevel } from '../../types/settings'

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

const POPOVER_WIDTH = 240
const VIEWPORT_MARGIN = 16
const POPOVER_GAP = 10

export function ReasoningEffortPopover({
  open,
  anchorRef,
  options,
  value,
  labels,
  onChange,
  onClose,
  ariaLabel = '推理强度',
}: Props) {
  const popoverRef = useRef<HTMLDivElement>(null)
  const sliderRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)
  const [position, setPosition] = useState<PopoverPosition | null>(null)
  const selectedIndex = Math.max(0, options.indexOf(value))
  const maxIndex = Math.max(0, options.length - 1)
  const fillPercent = maxIndex === 0 ? 0 : (selectedIndex / maxIndex) * 100

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

  useEffect(() => {
    if (!open) return
    const handleOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node
      if (!popoverRef.current?.contains(target) && !anchorRef.current?.contains(target)) {
        onClose()
      }
    }
    document.addEventListener('pointerdown', handleOutsidePointer)
    return () => document.removeEventListener('pointerdown', handleOutsidePointer)
  }, [anchorRef, onClose, open])

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
      className="fixed z-[90] rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-3.5 pb-3.5 pt-3 shadow-[0_12px_30px_rgba(15,23,42,0.13)]"
      style={{ bottom: position.bottom, left: position.left, width: position.width }}
    >
      <div
        data-testid="reasoning-effort-header"
        className="mb-2.5 flex items-baseline justify-between gap-3"
      >
        <div
          data-testid="reasoning-effort-label"
          className="text-sm font-semibold text-[var(--color-text-secondary)]"
        >
          {labels[value]}
        </div>
        <div
          data-testid="reasoning-effort-context-label"
          className="text-[10px] font-medium tracking-wide text-[var(--color-text-tertiary)]"
        >
          {ariaLabel}
        </div>
      </div>

      <div
        ref={sliderRef}
        role="slider"
        tabIndex={0}
        aria-label={ariaLabel}
        aria-valuemin={0}
        aria-valuemax={maxIndex}
        aria-valuenow={selectedIndex}
        aria-valuetext={labels[value]}
        className="group relative flex h-9 touch-none cursor-pointer items-center outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)] focus-visible:ring-offset-3 focus-visible:ring-offset-[var(--color-surface-container-lowest)]"
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
        <div
          data-testid="reasoning-effort-track"
          className="absolute inset-x-0 h-6 overflow-hidden rounded-full bg-[var(--color-surface-container-high)] shadow-[inset_0_0_0_1px_var(--color-border)]"
        >
          <div
            data-testid="reasoning-effort-fill"
            className="h-full rounded-full bg-[var(--color-brand)] transition-[width] duration-200 motion-reduce:transition-none"
            style={{ width: `${fillPercent}%` }}
          />
        </div>

        <div className="absolute inset-x-0 flex items-center justify-between px-[18px]">
          {options.map((option, index) => (
            <span
              key={option}
              data-testid="reasoning-effort-stop"
              className={`h-1.5 w-1.5 rounded-full ${index <= selectedIndex ? 'bg-white/45' : 'bg-[var(--color-outline)]/55'}`}
            />
          ))}
        </div>

        <div
          aria-hidden="true"
          data-testid="reasoning-effort-thumb"
          className="absolute top-1/2 h-8 w-8 -translate-x-1/2 -translate-y-1/2 rounded-full border border-[var(--color-border)] bg-white shadow-[0_2px_7px_rgba(15,23,42,0.13)] transition-[left] duration-200 motion-reduce:transition-none"
          style={{ left: `${fillPercent}%` }}
        />
      </div>
    </div>,
    document.body,
  )
}
