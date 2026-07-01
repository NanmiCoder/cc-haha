import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'

import { MultiSelectDropdown } from './MultiSelectDropdown'

type Item = { value: string; label: string }

function renderDropdown(props: {
  values: string[]
  items: Item[]
  onToggle?: (v: string) => void
}) {
  return render(
    <MultiSelectDropdown
      values={props.values}
      onToggle={props.onToggle ?? (() => {})}
      items={props.items}
      trigger={<button>open</button>}
    />,
  )
}

describe('MultiSelectDropdown', () => {
  it('hides items until the trigger is clicked', () => {
    renderDropdown({
      values: [],
      items: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }],
    })
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('open'))
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
  })

  it('exposes each row as menuitemcheckbox with correct aria-checked', () => {
    renderDropdown({
      values: ['a'],
      items: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }],
    })
    fireEvent.click(screen.getByText('open'))

    const rows = screen.getAllByRole('menuitemcheckbox')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveAttribute('aria-checked', 'true')
    expect(rows[1]).toHaveAttribute('aria-checked', 'false')
  })

  it('keeps the popover open after toggling so multiple items can be chosen', () => {
    const onToggle = vi.fn()
    renderDropdown({
      values: [],
      items: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }],
      onToggle,
    })
    fireEvent.click(screen.getByText('open'))

    fireEvent.click(screen.getByText('Alpha'))
    fireEvent.click(screen.getByText('Beta'))

    // Both fires AND the menu items are still on screen — popover never auto-closed.
    expect(onToggle).toHaveBeenCalledTimes(2)
    expect(onToggle).toHaveBeenNthCalledWith(1, 'a')
    expect(onToggle).toHaveBeenNthCalledWith(2, 'b')
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
  })

  it('closes when Escape is pressed', () => {
    renderDropdown({
      values: [],
      items: [{ value: 'a', label: 'Alpha' }],
    })
    fireEvent.click(screen.getByText('open'))
    expect(screen.getByText('Alpha')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
  })
})
