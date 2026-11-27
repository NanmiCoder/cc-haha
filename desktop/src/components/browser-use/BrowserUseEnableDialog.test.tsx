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

  it('cycles Auto -> Workspace -> Chrome and supports one-click disarm', () => {
    const onChange = vi.fn()
    const onRemove = vi.fn()
    render(
      <BrowserUseTargetPill
        target="auto"
        onChange={onChange}
        onRemove={onRemove}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Browser target: Auto/i }))
    expect(onChange).toHaveBeenCalledWith('workspace')

    fireEvent.click(screen.getByRole('button', { name: 'Remove Browser Use' }))
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it('renders a read-only chip without interactive buttons when used on a sent message', () => {
    render(<BrowserUseTargetPill target="workspace" />)

    const pill = screen.getByTestId('browser-use-target-pill')
    expect(pill).toHaveTextContent('Browser')
    expect(pill).toHaveTextContent('Workspace')
    expect(screen.queryByRole('button')).toBeNull()
  })
})
