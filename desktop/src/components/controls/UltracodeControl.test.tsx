import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { UltracodeControl } from './UltracodeControl'
import { useSettingsStore } from '@/stores/settingsStore'

beforeEach(() => useSettingsStore.setState({ locale: 'en' }))
afterEach(cleanup)
const off = { enabled: false, active: false, available: true, running: true, effort: 'low' }
it('offers standing orchestration independently from the reasoning levels', () => {
  const change = vi.fn()
  render(<UltracodeControl state={off} pending={false} error={null} modelSupported onChange={change} />)
  const toggle = screen.getByRole('switch', { name: 'Ultracode' })
  expect(toggle).not.toBeChecked()
  fireEvent.click(toggle)
  expect(change).toHaveBeenCalledWith(true)
  expect(screen.queryByRole('slider')).not.toBeInTheDocument()
})
it('prevents duplicate pending changes and never silently chooses another model', () => {
  const change = vi.fn()
  const { rerender } = render(<UltracodeControl state={off} pending error={null} modelSupported onChange={change} />)
  expect(screen.getByRole('switch')).toBeDisabled()
  rerender(<UltracodeControl state={off} pending={false} error={null} modelSupported={false} onChange={change} />)
  expect(screen.getByRole('switch')).toBeDisabled()
  expect(change).not.toHaveBeenCalled()
})
it('lets the human disable a mode paused by workflows or model availability', () => {
  const change = vi.fn()
  render(<UltracodeControl state={{ ...off, enabled: true, available: false, reason: 'workflows-disabled' }} pending={false} error={null} modelSupported onChange={change} />)
  expect(screen.getByRole('switch')).toBeEnabled()
  fireEvent.click(screen.getByRole('switch'))
  expect(change).toHaveBeenCalledWith(false)
})
it('shows failed native controls and native environment precedence', () => {
  render(<UltracodeControl state={{ ...off, envOverride: 'low' }} pending={false} error="Native runtime rejected the toggle" modelSupported onChange={vi.fn()} />)
  expect(screen.getByRole('alert')).toHaveTextContent('Native runtime rejected the toggle')
  expect(screen.getByText(/CLAUDE_CODE_EFFORT_LEVEL/)).toHaveTextContent('low')
})
