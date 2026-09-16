import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PanelMessage } from './PanelMessage'

describe('PanelMessage', () => {
  it('announces an informational message as a status region', () => {
    render(<PanelMessage icon="folder_open" message="No files" />)

    expect(screen.getByRole('status')).toHaveTextContent('No files')
  })

  it('announces an error message as an alert', () => {
    render(<PanelMessage icon="error" tone="error" message="Load failed" />)

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Load failed')
    expect(alert.className).toContain('text-[var(--color-error)]')
  })

  it('drops the live region when the caller opts out of announcing', () => {
    // Search-in-progress rows re-render on every keystroke; announcing each one
    // would make the screen reader talk over the user's typing.
    render(<PanelMessage announce={false} icon="progress_activity" message="Searching" />)

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByText('Searching')).toBeInTheDocument()
  })

  it('spins only the progress icon', () => {
    const { container: progress } = render(<PanelMessage icon="progress_activity" message="Loading" />)
    const { container: idle } = render(<PanelMessage icon="folder_off" message="Missing" />)

    expect(progress.querySelector('.material-symbols-outlined')?.className).toContain('animate-spin')
    expect(idle.querySelector('.material-symbols-outlined')?.className).not.toContain('animate-spin')
  })

  it('tightens padding in compact mode', () => {
    const { container } = render(<PanelMessage compact icon="error" message="Nested" />)

    expect(container.firstElementChild?.className).toContain('py-2')
    expect(container.firstElementChild?.className).not.toContain('py-8')
  })
})
