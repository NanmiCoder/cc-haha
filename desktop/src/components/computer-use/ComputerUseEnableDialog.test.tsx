import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { ComputerUseEnableDialog } from './ComputerUseEnableDialog'

describe('ComputerUseEnableDialog', () => {
  it('explains full-computer access and confirms explicitly', () => {
    const onConfirm = vi.fn()
    render(
      <ComputerUseEnableDialog
        open
        platform="win32"
        onClose={() => {}}
        onConfirm={onConfirm}
      />,
    )

    expect(screen.getByRole('dialog')).toHaveTextContent('all supported applications')
    expect(screen.getByRole('dialog')).toHaveTextContent('screenshots')
    fireEvent.click(screen.getByRole('button', { name: 'Enable Computer Use' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('adds the macOS system-permission distinction', () => {
    render(
      <ComputerUseEnableDialog
        open
        platform="darwin"
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    )

    expect(screen.getByRole('dialog')).toHaveTextContent('Accessibility and Screen Recording')
  })
})
