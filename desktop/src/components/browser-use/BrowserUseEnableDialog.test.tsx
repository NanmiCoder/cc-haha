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
    fireEvent.click(screen.getByRole('button', { name: 'Enable Browser Use' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})

describe('BrowserUseTargetPill', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
  })

  it('cycles Auto -> Workspace -> Chrome and supports one-click disable', () => {
    const onChange = vi.fn()
    const onDisable = vi.fn()
    render(
      <BrowserUseTargetPill
        target="auto"
        onChange={onChange}
        onDisable={onDisable}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Browser target: Auto/i }))
    expect(onChange).toHaveBeenCalledWith('workspace')

    fireEvent.click(screen.getByRole('button', { name: 'Disable Browser Use' }))
    expect(onDisable).toHaveBeenCalledTimes(1)
  })
})
