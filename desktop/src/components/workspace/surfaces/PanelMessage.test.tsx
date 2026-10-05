import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CircleAlert, Database, FolderOpen, FolderX } from 'lucide-react'
import { PanelMessage } from './PanelMessage'

describe('PanelMessage', () => {
  it('announces an informational message as a status region', () => {
    render(<PanelMessage icon={FolderOpen} message="No files" />)

    expect(screen.getByRole('status')).toHaveTextContent('No files')
  })

  it('announces an error message as an alert', () => {
    render(<PanelMessage icon={CircleAlert} tone="error" message="Load failed" />)

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Load failed')
    expect(alert.className).toContain('text-[var(--color-error)]')
  })

  it('drops the live region when the caller opts out of announcing', () => {
    // Search-in-progress rows re-render on every keystroke; announcing each one
    // would make the screen reader talk over the user's typing.
    render(<PanelMessage announce={false} busy message="Searching" />)

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByText('Searching')).toBeInTheDocument()
  })

  it('spins only while busy', () => {
    const { container: progress } = render(<PanelMessage busy message="Loading" />)
    const { container: idle } = render(<PanelMessage icon={FolderX} message="Missing" />)

    expect(progress.querySelector('svg')?.getAttribute('class')).toContain('animate-spin')
    expect(idle.querySelector('svg')).not.toBeNull()
    expect(idle.querySelector('svg')?.getAttribute('class')).not.toContain('animate-spin')
  })

  it('tightens padding in compact mode', () => {
    const { container } = render(<PanelMessage compact icon={CircleAlert} message="Nested" />)

    expect(container.firstElementChild?.className).toContain('py-2')
    expect(container.firstElementChild?.className).not.toContain('py-8')
  })

  describe('action', () => {
    it('renders the action next to the message, not inside the live region', () => {
      // A screen reader should announce "File is too large", not "File is too large
      // Open in system app" as one sentence — the button is reached by tabbing.
      render(<PanelMessage icon={Database} message="File is too large" action={<button type="button">Open in system app</button>} />)

      const status = screen.getByRole('status')
      expect(status).toHaveTextContent('File is too large')
      expect(status).not.toHaveTextContent('Open in system app')
      expect(screen.getByRole('button', { name: 'Open in system app' })).toBeInTheDocument()
    })

    it('leaves the markup of a message without an action exactly as it was', () => {
      const { container } = render(<PanelMessage icon={CircleAlert} message="Plain" />)

      // The message row is the root: existing callers and layouts depend on it.
      expect(container.firstElementChild).toHaveAttribute('role', 'status')
      expect(container.firstElementChild?.className).toContain('py-8')
    })

    it('trades the bottom padding for the action so the pair keeps one rhythm', () => {
      const { container } = render(<PanelMessage icon={CircleAlert} message="Failed" action={<button type="button">Retry</button>} />)

      const row = container.querySelector('[role="status"]')
      expect(row?.className).toContain('pb-3')
      expect(row?.className).not.toContain('py-8')
    })
  })
})
