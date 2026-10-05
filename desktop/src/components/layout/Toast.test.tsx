import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

import { useSettingsStore } from '../../stores/settingsStore'
import { useUIStore } from '../../stores/uiStore'
import { ToastContainer } from './Toast'

describe('ToastContainer accessibility', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    useUIStore.setState({ toasts: [] })
  })

  it('announces success and info messages politely as statuses', () => {
    useUIStore.setState({
      toasts: [
        { id: 'success', type: 'success', message: 'Saved' },
        { id: 'info', type: 'info', message: 'Refreshing' },
      ],
    })

    render(<ToastContainer />)

    expect(screen.getByText('Saved').closest('[role]')).toHaveAttribute('role', 'status')
    expect(screen.getByText('Saved').closest('[role]')).toHaveAttribute('aria-live', 'polite')
    expect(screen.getByText('Refreshing').closest('[role]')).toHaveAttribute('role', 'status')
  })

  it('announces warning and error messages assertively as alerts', () => {
    useSettingsStore.setState({ locale: 'zh' })
    useUIStore.setState({
      toasts: [
        { id: 'warning', type: 'warning', message: 'Check settings' },
        { id: 'error', type: 'error', message: 'Save failed' },
      ],
    })

    render(<ToastContainer />)

    expect(screen.getByText('Check settings').closest('[role]')).toHaveAttribute('role', 'alert')
    expect(screen.getByText('Check settings').closest('[role]')).toHaveAttribute('aria-live', 'assertive')
    expect(screen.getByText('Save failed').closest('[role]')).toHaveAttribute('role', 'alert')
    expect(screen.getAllByRole('button', { name: '关闭通知' })).toHaveLength(2)
  })

  // The tone is carried by a leading glyph, not by colour alone on a rule:
  // each state has its own outline, in its own status colour.
  it.each([
    ['success', 'lucide-circle-check', 'var(--color-success)'],
    ['error', 'lucide-circle-x', 'var(--color-error)'],
    ['warning', 'lucide-circle-alert', 'var(--color-warning)'],
    ['info', 'lucide-info', 'var(--color-info)'],
  ] as const)('marks a %s toast with its own glyph', (type, glyph, color) => {
    useUIStore.setState({ toasts: [{ id: type, type, message: `${type} message` }] })

    render(<ToastContainer />)

    const toast = screen.getByText(`${type} message`).closest('[role]') as HTMLElement
    const icon = toast.querySelector(`svg.${glyph}`)
    expect(icon).toHaveAttribute('aria-hidden', 'true')
    expect(icon?.getAttribute('class')).toContain(color)
    expect(toast.className).not.toMatch(/border-l-/)
  })
})
