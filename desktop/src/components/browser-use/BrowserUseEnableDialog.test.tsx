import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { useSettingsStore } from '@/stores/settingsStore'
import { BrowserUseEnableDialog, BrowserUseTargetPill } from './BrowserUseEnableDialog'

describe('BrowserUseEnableDialog', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
  })

  it('explains Workspace Browser & System Chrome without scary OS permission warnings', () => {
    const onConfirm = vi.fn()
    render(
      <BrowserUseEnableDialog
        open
        onClose={() => {}}
        onConfirm={onConfirm}
      />,
    )

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('Workspace Browser')
    expect(dialog).toHaveTextContent('Chrome')
    expect(dialog).toHaveTextContent('No macOS Accessibility or Screen Recording system permissions are required')
    expect(dialog.querySelectorAll('[class*="rounded-[var(--radius-card-inner)]"]').length).toBeGreaterThanOrEqual(2)
    fireEvent.click(screen.getByRole('button', { name: 'Enable Browser Use' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})

describe('BrowserUseTargetPill', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
  })

  it('cycles Auto -> Workspace -> Chrome and supports one-click disable with brand-soft V6C styling', () => {
    const onChange = vi.fn()
    const onDisable = vi.fn()
    const { rerender } = render(
      <BrowserUseTargetPill
        target="auto"
        onChange={onChange}
        onDisable={onDisable}
      />,
    )

    const pill = screen.getByTestId('browser-use-target-pill')
    expect(pill.className).toContain('bg-[var(--color-brand-soft)]')
    expect(pill.className).toContain('border-[var(--color-primary-fixed-dim)]')
    expect(pill.className).toContain('text-[var(--color-on-brand-soft)]')

    const cycleBtn = screen.getByRole('button', { name: /Browser target: Auto/i })
    const disableBtn = screen.getByRole('button', { name: 'Disable Browser Use' })
    expect(pill.className).toContain('h-6')
    expect(cycleBtn.className).toContain('cursor-pointer')
    expect(cycleBtn.className).toContain('h-full')
    expect(cycleBtn.className).not.toContain('h-6')
    expect(cycleBtn.className).toContain('hover:bg-[var(--color-brand-soft-hover)]')
    expect(disableBtn.className).toContain('h-full')
    expect(disableBtn.className).not.toContain('h-6')
    expect(disableBtn.className).toContain('hover:bg-[var(--color-brand-soft-hover)]')

    fireEvent.click(cycleBtn)
    expect(onChange).toHaveBeenCalledWith('workspace')

    fireEvent.click(disableBtn)
    expect(onDisable).toHaveBeenCalledTimes(1)

    rerender(
      <BrowserUseTargetPill
        target="auto"
        onChange={onChange}
        onDisable={onDisable}
        touch
      />,
    )
    expect(screen.getByTestId('browser-use-target-pill').className).toContain('h-9')
    expect(screen.getByRole('button', { name: /Browser target: Auto/i }).className).toContain('h-full')
    expect(screen.getByRole('button', { name: 'Disable Browser Use' }).className).toContain('w-9')
  })
})
