import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it, vi } from 'vitest'

import { EmptyState } from './EmptyState'

describe('EmptyState', () => {
  it('renders the title as a real heading', () => {
    // Only 2 of the 24 hand-rolled empty states used a heading tag; to a screen
    // reader the other 22 were ordinary paragraphs and never appeared in the
    // document outline.
    render(<EmptyState title="No sessions yet" />)
    expect(screen.getByRole('heading', { name: 'No sessions yet', level: 3 })).toBeInTheDocument()
  })

  it('honors an explicit heading level', () => {
    render(<EmptyState title="No sessions yet" headingLevel={2} />)
    expect(screen.getByRole('heading', { level: 2 })).toBeInTheDocument()
  })

  it('renders the description', () => {
    render(<EmptyState title="No sessions" description="Start one from the sidebar." />)
    expect(screen.getByText('Start one from the sidebar.')).toBeInTheDocument()
  })

  it('renders an action button that calls back', () => {
    const onClick = vi.fn()
    render(<EmptyState title="No agents" action={{ label: 'Create agent', onClick }} />)

    screen.getByRole('button', { name: 'Create agent' }).click()
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('renders a row of choices under the description', () => {
    render(
      <EmptyState title="No providers" description="Pick one to start.">
        <button type="button">DeepSeek</button>
        <button type="button">Kimi</button>
      </EmptyState>,
    )
    const description = screen.getByText('Pick one to start.')
    const choice = screen.getByRole('button', { name: 'DeepSeek' })
    expect(description.compareDocumentPosition(choice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Kimi' })).toBeInTheDocument()
  })

  it('hides the decorative icon from assistive tech', () => {
    render(<EmptyState title="No data" icon={<span data-testid="icon" />} />)
    expect(screen.getByTestId('icon').parentElement).toHaveAttribute('aria-hidden', 'true')
  })

  it('draws a dashed placeholder box by default and drops it for plain', () => {
    const { container: dashed } = render(<EmptyState title="A" />)
    expect(dashed.firstElementChild?.className).toContain('border-dashed')

    const { container: plain } = render(<EmptyState title="B" variant="plain" />)
    expect(plain.firstElementChild?.className).not.toContain('border-dashed')
  })

  it('collapses to a single row in inline variant', () => {
    const { container } = render(<EmptyState title="Nothing matched" variant="inline" />)
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
    expect(container).toHaveTextContent('Nothing matched')
  })

  it('falls back to the description when inline has no title', () => {
    const { container } = render(<EmptyState description="No results" variant="inline" />)
    expect(container).toHaveTextContent('No results')
  })
})
