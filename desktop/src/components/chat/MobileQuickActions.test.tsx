import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('../../i18n', () => ({
  useTranslation: () => (key: string) => key,
}))

import { MobileQuickActions } from './MobileQuickActions'

const noop = () => {}
const baseProps = {
  onOpenTasks: noop,
  onOpenTerminal: noop,
  onOpenFiles: noop,
  onOpenReview: noop,
}

describe('MobileQuickActions', () => {
  it('renders the collapsed FAB with no entry items by default', () => {
    render(<MobileQuickActions {...baseProps} />)
    const fab = screen.getByRole('button', { name: 'chat.quickActions' })
    expect(fab).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: 'chat.openTasks' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'chat.openTerminal' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'chat.openFiles' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'chat.openReview' })).not.toBeInTheDocument()
  })

  it('expands four entries when the FAB is tapped', () => {
    render(<MobileQuickActions {...baseProps} />)
    const fab = screen.getByRole('button', { name: 'chat.quickActions' })
    fireEvent.click(fab)
    expect(fab).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'chat.openTasks' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'chat.openTerminal' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'chat.openFiles' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'chat.openReview' })).toBeInTheDocument()
  })

  it('fires the matching action and collapses when an entry is tapped', () => {
    const onOpenTasks = vi.fn()
    const onOpenTerminal = vi.fn()
    const onOpenFiles = vi.fn()
    const onOpenReview = vi.fn()
    render(<MobileQuickActions
      onOpenTasks={onOpenTasks}
      onOpenTerminal={onOpenTerminal}
      onOpenFiles={onOpenFiles}
      onOpenReview={onOpenReview}
    />)
    fireEvent.click(screen.getByRole('button', { name: 'chat.quickActions' }))
    fireEvent.click(screen.getByRole('button', { name: 'chat.openFiles' }))
    expect(onOpenFiles).toHaveBeenCalledTimes(1)
    expect(onOpenTasks).not.toHaveBeenCalled()
    expect(onOpenTerminal).not.toHaveBeenCalled()
    expect(onOpenReview).not.toHaveBeenCalled()
    // run() closes the row before dispatching the action.
    expect(screen.getByRole('button', { name: 'chat.quickActions' })).toHaveAttribute('aria-expanded', 'false')
  })
})
